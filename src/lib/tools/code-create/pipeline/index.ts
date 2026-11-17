import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent, quoteLiteral, resolveCodeFormat, type CodeFormat } from "$lib/db/code";
import { tableToGeoJSON } from "$lib/db/geojson";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { assignCreateCodes, type SourceCodes } from "./assign";
import { buildCodeIssues, type CodeIssueRow } from "./issues";
import { resolveCodeLevels } from "./levels";
import { layerBounds } from "$lib/db/layerView";

export { parseMinWidth, resolveCodeFormat } from "$lib/db/code";
export type { CodeFormat } from "$lib/db/code";
export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { CodeIssueRow } from "./issues";
export { SOURCE_CODES, type SourceCodes } from "./assign";

export interface CodeCreateResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levelCount: number;
  issues: CodeIssueRow[];
}

// The root as SQL: a quoted literal, or the root column's values.
export function rootSql(rootCode: string | null, rootCodeField: string | null): string {
  if ((rootCode === null) === (rootCodeField === null)) {
    throw new Error("give exactly one of a root code and a root code column");
  }
  return rootCodeField !== null ? `${quoteIdent(rootCodeField)}::VARCHAR` : quoteLiteral(rootCode!);
}

// Codes are written into cc_attr, a fresh copy of layer_attr per run, so a
// rerun with other settings starts from the loaded source codes again.
export async function runCodeCreate(
  conn: AsyncDuckDBConnection,
  rootCode: string | null,
  delimiter: string,
  minWidth: string,
  sourceCodes: SourceCodes,
  schema: TargetSchema | null,
  rootCodeField: string | null = null,
): Promise<CodeCreateResult> {
  const root = rootSql(rootCode, rootCodeField);
  const fmt: CodeFormat = resolveCodeFormat(rootCode, delimiter, minWidth, {
    allowEmptyDelimiter: true,
  });
  await conn.query("CREATE OR REPLACE TABLE cc_attr AS SELECT * FROM layer_attr");
  const levels = await resolveCodeLevels(conn, "cc_attr", "layer_01", schema, rootCodeField);
  await assignCreateCodes(conn, "cc_attr", levels, fmt, sourceCodes, root, rootCodeField);
  const issues = await buildCodeIssues(conn, "cc_attr", levels, fmt, sourceCodes, root);

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "cc_attr");
  const bounds = await layerBounds(conn);
  return {
    resultGeoJSON,
    bounds,
    levelCount: [...levels.keys()].filter((n) => n >= 1).length,
    issues,
  };
}
