import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildCoverageCleanInput, runCoverageClean } from "$lib/db/coverageClean";
import { hasInvalidEdges } from "$lib/db/invalidEdges";
import { mergeMicroPolygons } from "$lib/db/coverage";
import { tryCloseNotches } from "$lib/db/notches";
import { validateCleanOutput } from "./validate";

// The topo-clean pipeline. Reads the loader-owned `layer_01` (fid, geom)
// + `layer_attr` tables, then runs DuckDB spatial's ST_CoverageClean over the
// whole coverage via the shared src/lib/db/coverageClean.ts helpers (also used
// by Edge Extender's input-clean gate and merge finalization).

// The table the clean starts from: layer_01, or a copy of it with its notches
// closed (tc_notched) when tc_notch_regions has any, as topo-tools' _03_clean.py.
export async function buildNotched(conn: AsyncDuckDBConnection): Promise<string> {
  const r = await conn.query("SELECT count(*) AS n FROM tc_notch_regions");
  if (Number((r.toArray()[0] as { n: bigint | number }).n) === 0) return "layer_01";
  await conn.query("CREATE OR REPLACE TABLE tc_notched AS SELECT * FROM layer_01");
  await tryCloseNotches(conn, "tc_notched");
  return "tc_notched";
}

// Build the frozen input list ONCE per load (tc_input), from sourceTable with
// micro-polygons merged (tc_merged), as topo-tools' coverage_clean does.
export async function buildInput(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
): Promise<number> {
  await mergeMicroPolygons(conn, sourceTable, "tc_merged", "tc_micro");
  return buildCoverageCleanInput(conn, "tc_merged", "tc_input");
}

// True if table has any overlaps/unmatched edges. Static per load, so callers
// should compute this once and cache it; see index.ts's cachedHasViolations.
export async function inputHasViolations(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<boolean> {
  return hasInvalidEdges(conn, table);
}

// `gapDeg` is already in degrees (see units.ts); 0 = no gap filling.
// `hasViolations` is layer_01's cached inputHasViolations() result: when
// there are no overlaps/unmatched edges AND no gap fill is requested,
// ST_CoverageClean has nothing to do, so skip it entirely and copy layer_01
// straight into targetTable — same gate topo-tools' _03_clean.py uses
// (has_coverage_violations() is False and gap_maximum_width_deg is None).
// Matters beyond speed: ST_CoverageClean's WASM-GEOS path has its own
// robustness edges (see gatedCoverageClean's comment in coverageClean.ts) that
// get exercised more, the more it's called on data that didn't need it.
//
// After a real ST_CoverageClean run, validateCleanOutput (pipeline/validate.ts)
// gates the result the same way topo-tools' _03_clean.py does — throwing
// rather than accepting an output that's still invalid or has collapsed
// beyond what the detected defects account for. The skip-gate branch above
// never calls it: a straight copy-through can't fail those checks.
//
// ST_CoverageClean writes to a scratch table first, not targetTable directly:
// on rejection, targetTable (tc_clean) must stay whatever it was before this
// call — a reclean that fails validation must not leave the DB-backed export
// sources (GeoParquet/GPKG/etc. dropdown, which query tc_clean directly)
// pointing at rejected output while the UI still shows the last-good result.
export async function buildClean(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  gapDeg: number,
  hasViolations = true,
): Promise<void> {
  if (gapDeg === 0 && !hasViolations) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT fid, geom FROM tc_merged WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    await conn.query(`DROP TABLE IF EXISTS ${targetTable}_micro`);
    return;
  }
  const scratch = `${targetTable}_scratch`;
  await runCoverageClean(conn, "tc_input", scratch, { gap: gapDeg });
  try {
    await validateCleanOutput(conn, scratch, gapDeg);
  } catch (e) {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
    throw e;
  }
  // Catches parts the clean itself left micro, as topo-tools' topo-clean does.
  await mergeMicroPolygons(conn, scratch, targetTable, `${targetTable}_micro`);
  await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
}

// Count rows in a cleaned table (post-explode) for the collapsed-feature warning.
export async function countRows(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  const r = await conn.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
  );
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}
