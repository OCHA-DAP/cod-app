import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";
import { gatedCoverageClean } from "$lib/db/coverageClean";
import { tryCloseNotches } from "$lib/db/notches";

// Tables this tool owns, dropped defensively before every run so re-running
// with different inputs in the same session starts clean. input_*/overlay_*
// are also dropped internally by loadFile itself, but listed here too for a
// complete, self-documenting sweep.
const OWNED_TABLES = [
  "input_raw_layer",
  "input_layer_01",
  "input_layer_attr",
  "overlay_raw_layer",
  "overlay_layer_01",
  "overlay_layer_attr",
  "ge_pairs",
  "ge_assignment",
  "ge_unassigned",
  "ge_groups",
  "ge_group_clip",
  "ge_results",
  "ge_results_attr",
  "ge_clip_targets",
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
): Promise<void> {
  await dropPriorRun(conn);
  await loadFile(db, conn, inputFiles, { prefix: "input_" });
  await loadFile(db, conn, overlayFiles, { prefix: "overlay_" });

  // Edge-extend's per-group clean can't see defects between units of different groups.
  await tryCloseNotches(conn, "input_layer_01");
  await gatedCoverageClean(conn, "input_layer_01", { anyHole: true });
}
