import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import {
  detectLevelColumnsOrSingle,
  levelLikeColumns,
  verifyFunctionalCluster,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

// One level's code column, name column, and whether the input lacks the code.
export interface Level {
  code: string;
  name: string | null;
  seeded: boolean;
}

async function hasCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  code: string,
  columns: Set<string>,
): Promise<boolean> {
  if (!columns.has(code)) return false;
  const r = (
    await conn.query(
      `SELECT bool_or(trim(${quoteIdent(code)}::VARCHAR) <> '') AS v FROM ${quoteIdent(table)}`,
    )
  ).toArray()[0] as { v: boolean | null };
  return r.v === true;
}

// A constant coarsest column (empty groupBy) is dropped before renumbering,
// so every structurally resolved level ends up a clean 1..N.
export async function resolveCodeLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  geomTable: string,
  schema: TargetSchema | null,
): Promise<Map<number, Level>> {
  if (schema !== null) {
    const columns = new Set(
      (
        (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{
          column_name: string;
        }>
      ).map((r) => r.column_name),
    );
    const result = new Map<number, Level>();
    // Every code starts with the root code, so a template always gets level 0.
    const detected = await detectLevels(conn, table, schema, { requireCodes: false });
    for (const n of [...new Set([0, ...detected])].sort((a, b) => a - b)) {
      const code = schema.codeField.replace("{n}", String(n));
      const name = schema.nameField.replace("{n}", String(n));
      const seeded = n >= 1 && !(await hasCodes(conn, table, code, columns));
      result.set(n, { code, name: columns.has(name) ? name : null, seeded });
    }
    return result;
  }

  const levelColumns = await detectLevelColumnsOrSingle(conn, table);
  const coded = [...levelColumns.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, cols]) => cols.groupBy.length > 0);
  if (coded.length === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }
  // A skipped level would corrupt every code below it, so never guess.
  const supplemental = await levelLikeColumns(conn, table, geomTable);
  if (supplemental.length > 0) {
    throw new Error(
      `${table}: ${JSON.stringify(supplemental)} group units like a level but were not detected as one; set the name/code field template explicitly`,
    );
  }
  const missing = coded.filter(([, cols]) => !cols.hasCode).map(([n]) => n);
  if (missing.length > 0) {
    throw new Error(
      `no existing code column to overwrite for level(s) ${missing.join(", ")} in ${table}; set the name/code field template explicitly`,
    );
  }

  const result = new Map<number, Level>();
  let parent: string | null = null;
  for (const [, cols] of coded) {
    const canonical = cols.groupBy[0];
    await verifyFunctionalCluster(conn, table, canonical, cols.groupBy, parent);
    result.set(result.size + 1, { code: canonical, name: cols.nameColumn, seeded: false });
    parent = canonical;
  }
  return result;
}
