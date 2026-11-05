import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { isNoiseColumn } from "$lib/tools/schema-map/pipeline/constants";
import { isNumericDuckdbType } from "$lib/db/columnTypes";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { columnFamilies, detectLevels, levelPrefix } from "$lib/tools/schema-fill/pipeline/levels";

const ALLOWED_AGGREGATIONS: Record<string, string> = {
  sum: "SUM",
  min: "MIN",
  max: "MAX",
  avg: "AVG",
  first: "ANY_VALUE",
};

export interface DissolveOptions {
  groupBy: string[];
  exclude?: string[];
  targetSchema?: TargetSchema;
  aggregations?: Record<string, "sum" | "min" | "max" | "avg" | "first">;
}

export interface DissolveCoreResult {
  kept: string[];
  summed: string[];
  overridden: string[];
  dropped: string[];
}

// Collapses per-group counts to one summary row in SQL, so result size
// scales with columns, never with group count.
async function distinctCounts(
  conn: AsyncDuckDBConnection,
  table: string,
  groupBy: string[],
  columns: string[],
): Promise<Record<string, number>> {
  if (columns.length === 0) return {};
  if (groupBy.length === 0) {
    const countsSql = columns.map((c) => `COUNT(DISTINCT "${c}")`).join(", ");
    const r = await conn.query(`SELECT ${countsSql} FROM "${table}"`);
    const row = r.toArray()[0] as Record<string, number | bigint>;
    const out: Record<string, number> = {};
    columns.forEach((c, i) => {
      out[c] = Number(Object.values(row)[i]);
    });
    return out;
  }
  const groupBySql = groupBy.map((c) => `"${c}"`).join(", ");
  const countsSql = columns.map((c, i) => `COUNT(DISTINCT "${c}") AS "__auto_${i}"`).join(", ");
  const summarySql = columns.map((_, i) => `MAX("__auto_${i}") AS "c${i}"`).join(", ");
  const r = await conn.query(`--sql
    WITH counts AS (
      SELECT ${groupBySql}, ${countsSql}
      FROM "${table}"
      GROUP BY ${groupBySql}
    )
    SELECT ${summarySql} FROM counts
  `);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const out: Record<string, number> = {};
  columns.forEach((c, i) => {
    out[c] = Number(row[`c${i}`]);
  });
  return out;
}

// Every column belonging to a level finer than group_by's own detected level.
async function schemaDerivedExclusions(
  conn: AsyncDuckDBConnection,
  table: string,
  groupBy: string[],
  schema: TargetSchema,
): Promise<Set<string>> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  const columns = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
  const levels = await detectLevels(conn, table, schema);

  let targetLevel: number | null = null;
  for (const level of [...levels].sort((a, b) => b - a)) {
    if (
      groupBy.includes(schema.codeField.replace("{n}", String(level))) ||
      groupBy.includes(schema.nameField.replace("{n}", String(level)))
    ) {
      targetLevel = level;
      break;
    }
  }
  if (targetLevel === null) {
    throw new Error(
      `targetSchema given but no groupBy column matches any detected level: ${groupBy.join(", ")}`,
    );
  }

  const finerLevels = levels.filter((l) => l > targetLevel!);
  const prefix = levelPrefix(schema);
  const families = columnFamilies(columns, finerLevels, prefix);
  const result = new Set<string>();
  for (const family of families.values()) {
    for (const column of family.values()) result.add(column);
  }
  return result;
}

// A NULL groupBy value forms its own group; other columns are kept if
// constant per group, else summed if numeric (else dropped), unless overridden.
export async function runDissolveCore(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  { groupBy, exclude, targetSchema, aggregations }: DissolveOptions,
): Promise<DissolveCoreResult> {
  for (const fn of Object.values(aggregations ?? {})) {
    if (!(fn in ALLOWED_AGGREGATIONS)) {
      throw new Error(`unsupported aggregation "${fn}"`);
    }
  }

  const alwaysExcluded = new Set([...groupBy, "fid", "geom", ...(exclude ?? [])]);
  if (targetSchema) {
    for (const c of await schemaDerivedExclusions(conn, tableIn, groupBy, targetSchema)) {
      alwaysExcluded.add(c);
    }
  }

  const desc = await conn.query(`DESCRIBE "${tableIn}"`);
  const columnTypes = new Map(
    (desc.toArray() as Array<{ column_name: string; column_type: string }>).map((r) => [
      r.column_name,
      r.column_type,
    ]),
  );
  for (const c of columnTypes.keys()) {
    if (c !== "fid" && c !== "geom" && isNoiseColumn(c)) alwaysExcluded.add(c);
  }

  const candidateCols = [...columnTypes.keys()].filter((c) => !alwaysExcluded.has(c)).sort();
  const stats = await distinctCounts(conn, tableIn, groupBy, candidateCols);

  const kept: string[] = [];
  const summed: string[] = [];
  const overridden: string[] = [];
  const dropped: string[] = [];
  for (const c of candidateCols) {
    if (aggregations && c in aggregations) {
      overridden.push(c);
    } else if (stats[c] <= 1) {
      kept.push(c);
    } else if (isNumericDuckdbType(columnTypes.get(c)!)) {
      summed.push(c);
    } else {
      dropped.push(c);
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `dissolve: dropping ${dropped.length} column(s) not constant within every group:`,
      dropped,
    );
  }

  const groupColsSql = groupBy.map((c) => `"${c}"`);
  const exprs = new Map<string, string>([
    ...groupBy.map((c): [string, string] => [c, `"${c}"`]),
    ...kept.map((c): [string, string] => [c, `any_value("${c}") AS "${c}"`]),
    ...summed.map((c): [string, string] => [c, `SUM("${c}") AS "${c}"`]),
    ...overridden.map((c): [string, string] => [
      c,
      `${ALLOWED_AGGREGATIONS[aggregations![c]]}("${c}") AS "${c}"`,
    ]),
  ]);
  // Input column order, so an admin hierarchy keeps its own level order.
  const selectSql = [...columnTypes.keys()].flatMap((c) => exprs.get(c) ?? []).join(", ");
  const groupClause = groupBy.length > 0 ? `GROUP BY ${groupColsSql.join(", ")}` : "";

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${tableOut}" AS
    SELECT row_number() OVER () AS fid, ${selectSql},
           ST_MakeValid(ST_Union_Agg(geom)) AS geom
    FROM "${tableIn}"
    ${groupClause}
  `);

  return { kept, summed, overridden, dropped };
}
