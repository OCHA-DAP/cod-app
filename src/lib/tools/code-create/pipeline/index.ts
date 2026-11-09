import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { resolveCodeFormat, type CodeFormat } from "$lib/db/code";
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

// Codes are written into cc_attr, a fresh copy of layer_attr per run, so a
// rerun with other settings starts from the loaded source codes again.
export async function runCodeCreate(
  conn: AsyncDuckDBConnection,
  rootCode: string,
  delimiter: string,
  minWidth: string,
  sourceCodes: SourceCodes,
  schema: TargetSchema | null,
): Promise<CodeCreateResult> {
  const fmt: CodeFormat = resolveCodeFormat(rootCode, delimiter, minWidth, {
    allowEmptyDelimiter: true,
  });
  await conn.query("CREATE OR REPLACE TABLE cc_attr AS SELECT * FROM layer_attr");
  const levels = await resolveCodeLevels(conn, "cc_attr", "layer_01", schema);
  await assignCreateCodes(conn, "cc_attr", levels, fmt, sourceCodes);
  const issues = await buildCodeIssues(conn, "cc_attr", levels, fmt, sourceCodes);

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "cc_attr");
  const bounds = await layerBounds(conn);
  return {
    resultGeoJSON,
    bounds,
    levelCount: [...levels.keys()].filter((n) => n >= 1).length,
    issues,
  };
}
