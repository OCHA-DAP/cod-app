import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  detectLevelCodes,
  detectLevelColumns,
  groupFamiliesByLevel,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import {
  validateTargetSchema,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { columnFamilies, detectLevels, fieldPrefix, levelPrefix } from "./levels";

// Explicit schema: levels via its codeField prefix. Null schema: the same
// level set resolved structurally instead, via schema-map's own engine.
export async function resolveLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
): Promise<number[]> {
  if (schema !== null) {
    validateTargetSchema(schema);
    return detectLevels(conn, table, schema);
  }
  const levelColumns = await detectLevelColumns(conn, table);
  const missing = [...levelColumns].filter(([, cols]) => !cols.hasCode).map(([n]) => n);
  if (missing.length > 0) {
    throw new Error(`missing code column for level(s) ${missing.join(", ")} in ${table}`);
  }
  return [...levelColumns.keys()].sort((a, b) => a - b);
}

function depthColumnSql(codeColumns: Map<number, string>, depthColumn: string): string {
  const cases = [...codeColumns.keys()]
    .sort((a, b) => b - a)
    .map((lvl) => `WHEN ${JSON.stringify(codeColumns.get(lvl))} IS NOT NULL THEN ${lvl}`)
    .join(" ");
  return `CASE ${cases} END AS ${JSON.stringify(depthColumn)}`;
}

export interface FillOptions {
  levels: number[];
  schema: TargetSchema | null;
  depthColumn: string;
}

// Each level's code column, and every column family to cascade down; a null
// schema triggers structural auto-detection of each family instead.
async function resolveFamilies(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  columns: string[],
  levels: number[],
  schema: TargetSchema | null,
): Promise<{ codeColumns: Map<number, string>; families: Array<Map<number, string>> }> {
  if (schema !== null) {
    const codePrefix = levelPrefix(schema);
    const namePrefix = fieldPrefix(schema.nameField);
    const codeSuffix = schema.codeField.split("{n}")[1];
    let codeColumns = new Map<number, string>();
    const families: Array<Map<number, string>> = [];
    for (const prefix of new Set([codePrefix, namePrefix])) {
      const familyGroup = columnFamilies(columns, levels, prefix);
      if (prefix === codePrefix) codeColumns = familyGroup.get(codeSuffix) ?? new Map();
      for (const family of familyGroup.values()) families.push(family);
    }
    return { codeColumns, families };
  }

  const levelColumns = await detectLevelColumns(conn, tableIn);
  const allCodes = await detectLevelCodes(conn, tableIn);
  const codeColumns = new Map([...allCodes].filter(([lvl]) => levels.includes(lvl)));
  const families = [...(await groupFamiliesByLevel(conn, tableIn, levelColumns)).values()];
  return { codeColumns, families };
}

// depthColumn is stamped from tableIn's raw columns: DuckDB resolves a
// later same-named expression against the FROM clause, not a sibling alias.
export async function runFill(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  { levels, schema, depthColumn }: FillOptions,
): Promise<void> {
  const desc = await conn.query(`DESCRIBE "${tableIn}"`);
  const columns = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
  if (columns.includes(depthColumn)) {
    throw new Error(`depthColumn "${depthColumn}" already exists on ${tableIn}`);
  }

  const { codeColumns, families } = await resolveFamilies(conn, tableIn, columns, levels, schema);

  // A column at the level a row's own hierarchy really reaches, including a
  // legitimate NULL there, is pinned and never backfilled from a sibling.
  const filled = new Map<string, string>();
  for (const perLevel of families) {
    if (perLevel.size === 1) continue;
    const sortedLevels = [...perLevel.keys()].sort((a, b) => a - b);
    const fallbackCases = [...sortedLevels]
      .reverse()
      .map((lvl) => `WHEN "${depthColumn}" >= ${lvl} THEN ${JSON.stringify(perLevel.get(lvl))}`)
      .join(" ");
    const fallback = `CASE ${fallbackCases} END`;
    for (const [level, column] of perLevel) {
      filled.set(
        column,
        `CASE WHEN "${depthColumn}" >= ${level} THEN ${JSON.stringify(column)} ELSE (${fallback}) END AS ${JSON.stringify(column)}`,
      );
    }
  }

  // Input column order, so an admin hierarchy keeps its own level order.
  const selectParts = columns
    .map((c) => filled.get(c) ?? JSON.stringify(c))
    .concat([JSON.stringify(depthColumn)]);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${tableOut}" AS
    WITH "depth" AS (
      SELECT *, ${depthColumnSql(codeColumns, depthColumn)}
      FROM "${tableIn}"
    )
    SELECT ${selectParts.join(", ")} FROM "depth"
  `);
}
