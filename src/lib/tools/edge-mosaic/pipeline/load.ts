import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

const OWNED_TABLES = [
  "input_raw_layer",
  "input_layer_01",
  "input_layer_attr",
  "overlay_raw_layer",
  "overlay_layer_01",
  "overlay_layer_attr",
  "original_raw_layer",
  "original_layer_01",
  "original_layer_attr",
  "cl_input_parts",
  "cl_overlay_parts",
  "cl_overlay_pieces",
  "cl_pairs_geom",
  "cl_pairs_raw",
  "cl_pairs",
  "cl_assign",
  "cl_clip",
  "cl_clip_in",
  "cl_clip_dropped",
  "cl_tiles_all",
  "cl_detached",
  "ms_micro",
  "ms_invalid",
  "ms_gaps",
  "ms_gap_regions",
  "ms_unassigned",
  "ms_code_issues",
  "ms_issues",
];

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of OWNED_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

export async function loadLayers(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  originalFiles: File[] = [],
): Promise<void> {
  await dropPriorRun(conn);
  await loadFile(db, conn, inputFiles, { prefix: "input_" });
  await loadFile(db, conn, overlayFiles, { prefix: "overlay_" });
  if (originalFiles.length > 0) await loadFile(db, conn, originalFiles, { prefix: "original_" });
}
