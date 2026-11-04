import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { checkNoOverlaps } from "$lib/db/coverage";
import { ROW_ORDER_COLUMN } from "$lib/db/export";
import { tableToGeoJSON } from "$lib/db/geojson";
import { layerBounds, type Bounds } from "$lib/db/layerView";
import { loadFile } from "$lib/db/loader";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { assignJoinFeatures } from "./assign";
import { buildJoinIssues, type JoinIssueRow } from "./issues";
import { joinColumns, type JoinedColumn } from "./join";

export { DEFAULT_TARGET_SCHEMA } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { JoinIssueKind, JoinIssueRow } from "./issues";
export type { JoinedColumn } from "./join";

export const MIN_OVERLAP_DEFAULT = 0.5;

export interface LoadedLayers {
  inputGeoJSON: string;
  joinGeoJSON: string;
  bounds: Bounds | null;
  inputCount: number;
}

export interface SchemaJoinResult {
  columns: JoinedColumn[];
  sortColumn: string | null;
  issues: JoinIssueRow[];
}

// Loads both layers and assigns each input feature a join feature; geometry-only, so runs once per layer pair.
export async function loadAndAssign(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  joinFiles: File[],
): Promise<LoadedLayers> {
  await loadFile(db, conn, inputFiles, { prefix: "input_" });
  await checkNoOverlaps(conn, "input_layer_01");
  await loadFile(db, conn, joinFiles, { prefix: "join_" });
  await checkNoOverlaps(conn, "join_layer_01");
  await assignJoinFeatures(conn);
  return {
    inputGeoJSON: await tableToGeoJSON(conn, "input_layer_01", null),
    joinGeoJSON: await tableToGeoJSON(conn, "join_layer_01", null),
    bounds: await layerBounds(conn, "input_layer_01"),
    inputCount: Number(
      ((await conn.query("SELECT COUNT(*) AS n FROM input_layer_01")).toArray()[0] as { n: bigint })
        .n,
    ),
  };
}

// Copies the matched join feature's hierarchy columns onto each input feature and reports issues.
export async function runSchemaJoin(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  minOverlap: number,
): Promise<SchemaJoinResult> {
  if (!(minOverlap > 0 && minOverlap <= 1)) {
    throw new Error(`Minimum overlap must be in (0, 1], got ${minOverlap}.`);
  }
  const { columns, sortColumn } = await joinColumns(conn, schema);
  const issues = await buildJoinIssues(conn, minOverlap);
  return { columns, sortColumn, issues };
}

// Joined attributes of one output row, as strings.
export async function joinedRow(
  conn: AsyncDuckDBConnection,
  outRow: number,
): Promise<Record<string, string | null> | null> {
  const r = await conn.query(`--sql
    SELECT * EXCLUDE (fid, ${ROW_ORDER_COLUMN}) FROM sj_result_attr
    WHERE ${ROW_ORDER_COLUMN} = ${outRow}
  `);
  const row = r.toArray()[0]?.toJSON() as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? null : String(v)]));
}
