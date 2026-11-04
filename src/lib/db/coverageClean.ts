import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "./constants";
import { buildGapTable, hasMicroPolygons, hasNoiseFloorGap, mergeMicroPolygons } from "./coverage";
import { hasInvalidEdges } from "./invalidEdges";

// Shared ST_CoverageClean plumbing used by both the Topology Cleaner tool
// (topo-clean/pipeline/clean.ts) and Edge Extender's input-clean gate and
// merge finalization. ST_CoverageClean takes a GEOMETRY[] and returns a
// GeometryCollection in the SAME order as the input list, so every caller here
// follows the same shape: freeze an (fid, geom) table into a content-ordered
// array once, then explode the cleaned result back to one row per fid by the
// top-level dump-path index.

// DuckDB accepts scientific notation in numeric literals, but format defensively.
function fmt(n: number): string {
  return Number.isFinite(n) ? n.toString() : "-1";
}

export interface CoverageCleanOptions {
  // GEOS snapping tolerance, in degrees. Defaults to SNAP_TOLERANCE (matches
  // topo-tools ADR-0040): GEOS's own auto-default (-1, dataset_diameter /
  // 1e8) swings from too tight on small territories to too loose on a global
  // mosaic, so it's no longer the default; -1 remains available as an
  // explicit override.
  snap?: number;
  // gap_max_width, in the same units as geom (degrees, post-normalization).
  // Defaults to SNAP_TOLERANCE (ADR-0040, same rationale as snap above); 0
  // remains available as an explicit "no gap filling" override.
  gap?: number;
}

// Freezes an (fid, geom) source table into a single-row (geoms[], fids[]) array
// table, both ordered by geometry hash then fid so geoms[i] <-> fids[i] holds and
// ST_CoverageClean (input-order dependent) sees topo-tools' order. Returns the row count (array
// length) so callers can detect an empty/all-null input before cleaning.
export async function buildCoverageCleanInput(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
): Promise<number> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    SELECT
      array_agg(geom ORDER BY hash(geom), fid)::GEOMETRY[] AS geoms,
      array_agg(fid  ORDER BY hash(geom), fid)             AS fids
    FROM ${sourceTable}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const r = await conn.query(`SELECT COALESCE(len(fids), 0) AS n FROM ${targetTable}`);
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}

// Runs ST_CoverageClean over a table already frozen by buildCoverageCleanInput
// and explodes the result back to one row per surviving fid. We key on the
// top-level dump path index (s.path[1], 1-based) to recover fid, regrouping a
// cleaned MultiPolygon element's parts (e.g. [2,1],[2,2]) back to one fid with
// a per-element (tiny) ST_Union_Agg — never a global union. ST_Dump drops EMPTY
// elements, so collapsed polygons simply don't appear in the output (callers
// derive a collapsed count from the row delta if they need it).
export async function runCoverageClean(
  conn: AsyncDuckDBConnection,
  inputTable: string,
  targetTable: string,
  { snap = SNAP_TOLERANCE, gap = SNAP_TOLERANCE }: CoverageCleanOptions = {},
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH cleaned AS (
      SELECT fids, ST_CoverageClean(geoms, ${fmt(snap)}, ${fmt(gap)}) AS coll
      FROM ${inputTable}
    ),
    dumped AS (
      SELECT fids, UNNEST(ST_Dump(coll)) AS s FROM cleaned
    )
    SELECT fids[s.path[1]] AS fid, ST_MakeValid(ST_Union_Agg(s.geom)) AS geom
    FROM dumped
    GROUP BY fids[s.path[1]]
  `);
}

// True if `table`'s union has any interior hole, however narrow: the input
// auto-clean trigger of topo-tools' read_reproject_and_clean.
export async function hasAnyHole(conn: AsyncDuckDBConnection, table: string): Promise<boolean> {
  const scratch = `${table}_any_hole`;
  try {
    await buildGapTable(conn, scratch, table);
    const r = await conn.query(`SELECT COUNT(*) > 0 AS bad FROM ${scratch}`);
    return Boolean(r.toArray()[0].bad);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
  }
}

// The clean trigger: invalid edges or a micro-polygon, plus any hole when
// anyHole is set (for inputs, as topo-tools' has_valid_topology(gap=0)).
export async function needsCoverageClean(
  conn: AsyncDuckDBConnection,
  table: string,
  anyHole = false,
): Promise<boolean> {
  return (
    (await hasInvalidEdges(conn, table)) ||
    (await hasMicroPolygons(conn, table)) ||
    (anyHole && (await hasAnyHole(conn, table)))
  );
}

// Runs ST_CoverageClean on `table` in place, only when needsCoverageClean
// says so: cleaning unconditionally made WASM crash rates worse. A failure
// is swallowed (warn + leave `table` untouched): a not-quite-seamless output
// beats losing an already-valid result.
export async function gatedCoverageClean(
  conn: AsyncDuckDBConnection,
  table: string,
  opts: CoverageCleanOptions & { anyHole?: boolean; microIssuesTable?: string } = {},
): Promise<void> {
  const { anyHole, ...cleanOpts } = opts;
  if (!(await needsCoverageClean(conn, table, anyHole))) return;

  const scratch = `${table}_cc_gated`;
  try {
    await buildCoverageClean(conn, table, scratch, { preserveOriginal: true, ...cleanOpts });
    await conn.query(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${scratch}`);
  } catch (e) {
    console.warn(`CoverageClean failed on ${table}, leaving as-is:`, e);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
  }
}

const SNAP_ESCALATION_STEP = SNAP_TOLERANCE;
const SNAP_ESCALATION_MAX_STEPS = 9;

// Ported from topo-tools' coverage_clean_escalating: widens snap by
// SNAP_TOLERANCE per retry (up to 9 steps) until no invalid edges remain.
export async function buildCoverageCleanEscalating(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
  opts: CoverageCleanOptions & { preserveOriginal?: boolean; microIssuesTable?: string } = {},
): Promise<void> {
  let snap = opts.snap ?? SNAP_TOLERANCE;
  for (let step = 0; step <= SNAP_ESCALATION_MAX_STEPS; step++) {
    await buildCoverageClean(conn, sourceTable, targetTable, { ...opts, snap });
    if (!(await hasInvalidEdges(conn, targetTable))) return;
    snap += SNAP_ESCALATION_STEP;
  }
}

// One-shot convenience wrapper for callers that don't need to reuse the frozen
// input array across a retry (e.g. Topology Cleaner's precision-reduction
// retry path reuses buildCoverageCleanInput/runCoverageClean directly instead).
//
// preserveOriginal: true falls back to sourceTable's own (pre-clean) geometry
// for any fid ST_CoverageClean collapses to EMPTY, instead of dropping the row
// (Edge Extender's contract — a merge/input-clean step must never change the
// fid set, since downstream stages assume it's stable). Topology Cleaner wants
// the opposite (collapsed rows should disappear so it can report a collapse
// count), so it leaves this off.
export async function buildCoverageClean(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  targetTable: string,
  opts: CoverageCleanOptions & { preserveOriginal?: boolean; microIssuesTable?: string } = {},
): Promise<void> {
  const { preserveOriginal, microIssuesTable, ...cleanOpts } = opts;
  const merged = `${targetTable}_cc_merged`;
  const microIssues = microIssuesTable ?? `${targetTable}_cc_micro`;
  const scratchInput = `${targetTable}_cc_input`;
  try {
    // ST_CoverageClean returns an all-micro feature as EMPTY, so merge first.
    await mergeMicroPolygons(conn, sourceTable, merged, microIssues);
    await buildCoverageCleanInput(conn, merged, scratchInput);

    if (!preserveOriginal) {
      await runCoverageClean(conn, scratchInput, targetTable, cleanOpts);
      return;
    }

    const scratchClean = `${targetTable}_cc_clean`;
    await runCoverageClean(conn, scratchInput, scratchClean, cleanOpts);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT s.fid, COALESCE(c.geom, s.geom) AS geom
      FROM ${merged} s
      LEFT JOIN ${scratchClean} c USING (fid)
    `);
    await conn.query(`DROP TABLE IF EXISTS ${scratchClean}`);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${merged}`);
    await conn.query(`DROP TABLE IF EXISTS ${scratchInput}`);
    if (!microIssuesTable) await conn.query(`DROP TABLE IF EXISTS ${microIssues}`);
  }
}

// Ported from topo-tools' check_valid_topology: throws on invalid edges, a gap at
// or below gapMaxWidth (any hole when 0), or a micro-polygon.
export async function checkValidTopology(
  conn: AsyncDuckDBConnection,
  table: string,
  gapMaxWidth = SNAP_TOLERANCE,
): Promise<void> {
  if (await hasInvalidEdges(conn, table)) throw new Error(`INVALID_EDGES: ${table}`);
  const gaps =
    gapMaxWidth === 0 ? await hasAnyHole(conn, table) : await hasNoiseFloorGap(conn, table, gapMaxWidth);
  if (gaps) throw new Error(`GAPS: ${table}`);
  if (await hasMicroPolygons(conn, table)) throw new Error(`MICRO_POLYGONS: ${table}`);
}

// Ported from topo-tools' coverage_clean_rows: coverage-cleans `table` (fid, geom) in
// place, leaving rows failing `where` untouched.
export async function coverageCleanRows(
  conn: AsyncDuckDBConnection,
  table: string,
  where: string,
  microIssuesTable: string,
): Promise<void> {
  const held = `${table}_held`;
  await conn.query(`CREATE OR REPLACE TABLE ${held} AS SELECT * FROM ${table} WHERE NOT (${where})`);
  await conn.query(`DELETE FROM ${table} WHERE NOT (${where})`);
  await mergeMicroPolygons(conn, table, table, microIssuesTable);
  await gatedCoverageClean(conn, table);
  await conn.query(`INSERT INTO ${table} BY NAME SELECT * FROM ${held}`);
  await conn.query(`DROP TABLE ${held}`);
}
