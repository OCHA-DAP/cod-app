import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { hasNoiseFloorGap } from "$lib/db/coverage";
import { hasInvalidEdges } from "$lib/db/invalidEdges";

// Post-fix validation gate, matching topo-tools' _03_clean.py checks
// (docs/adr/0009-area-floor-anchored-to-overlap-area.md there). Runs
// immediately after every successful ST_CoverageClean call, before the
// result is accepted — a failure here throws, which both buildClean callers
// (runFromLoaded, recleanOnly) already propagate as a run/reclean error
// rather than silently showing a corrupted "Fixed" view.

// Baseline area-loss tolerance when no overlaps are detected — double the
// ~1% per-fid renoding drift topo-tools confirmed on real defect-dense data.
const AREA_NOISE_FACTOR = 0.02;
// Multiplier on detected overlap area: resolving an overlap can legitimately
// redraw well beyond its own footprint (confirmed up to ~1.5x on a real
// regression case in topo-tools; headroom set to 3x).
const OVERLAP_LOSS_HEADROOM = 3.0;

async function totalArea(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  const r = await conn.query(
    `SELECT SUM(ST_Area(geom)) AS a FROM ${table} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
  );
  return Number((r.toArray()[0] as { a: number | null }).a ?? 0);
}

async function overlapArea(conn: AsyncDuckDBConnection): Promise<number> {
  const r = await conn.query(
    "SELECT SUM(ST_Area(geom)) AS a FROM tc_overlap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)",
  );
  return Number((r.toArray()[0] as { a: number | null }).a ?? 0);
}

// Fids not adjacent to any detected gap or overlap that nonetheless vanished
// (became empty) in the cleaned output despite having nonzero input area.
// Defect-adjacent and micro-polygon fids are exempt, since resolving their
// own defect is expected to change or remove them.
async function collapsedUnrelatedCount(
  conn: AsyncDuckDBConnection,
  cleanTable: string,
): Promise<number> {
  const r = await conn.query(`--sql
    WITH defect_adjacent AS (
      SELECT fa AS fid FROM tc_overlap_regions WHERE fa IS NOT NULL
      UNION
      SELECT fb AS fid FROM tc_overlap_regions WHERE fb IS NOT NULL
      UNION
      SELECT DISTINCT i.fid
      FROM layer_01 i, tc_gap_regions g
      WHERE g.geom IS NOT NULL AND NOT ST_IsEmpty(g.geom) AND ST_Intersects(i.geom, g.geom)
      UNION
      SELECT unit_a AS fid FROM tc_micro
      UNION
      SELECT unit_a AS fid FROM tc_notch_regions
      UNION
      SELECT unit_b AS fid FROM tc_notch_regions
    )
    SELECT COUNT(*) AS n
    FROM layer_01 i
    LEFT JOIN ${cleanTable} o USING (fid)
    WHERE i.geom IS NOT NULL AND ST_Area(i.geom) > 0
      AND i.fid NOT IN (SELECT fid FROM defect_adjacent)
      AND (o.geom IS NULL OR ST_IsEmpty(o.geom))
  `);
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}

async function badGeometryTypeCount(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  const r = await conn.query(`--sql
    SELECT COUNT(*) AS n FROM ${table}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      AND ST_GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON')
  `);
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}

// Rejects a coverage-clean output that's invalid or has collapsed beyond
// what the detected defects account for. Throws (never returns a partial
// result) if: the output still has coverage violations; its total area
// falls below a floor anchored to the detected overlap area, not a flat
// fraction of the dataset; a feature untouched by any detected defect
// collapsed to nothing; a feature's fixed shape isn't a valid polygon; or a
// gap at or below the requested fill width survived (an under-fill).
export async function validateCleanOutput(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  gapDeg: number,
): Promise<void> {
  const inputArea = await totalArea(conn, "layer_01");
  const outputArea = await totalArea(conn, targetTable);
  const ovArea = await overlapArea(conn);
  const minArea = inputArea * (1 - AREA_NOISE_FACTOR) - ovArea * OVERLAP_LOSS_HEADROOM;
  const collapsed = await collapsedUnrelatedCount(conn, targetTable);
  const badTypes = await badGeometryTypeCount(conn, targetTable);
  const stillViolating = await hasInvalidEdges(conn, targetTable);
  const underFilled = gapDeg > 0 && (await hasNoiseFloorGap(conn, targetTable, gapDeg));

  if (stillViolating || underFilled || outputArea < minArea || collapsed > 0 || badTypes > 0) {
    throw new Error(
      `Coverage-clean output rejected: area ${outputArea.toFixed(6)} vs input ` +
        `${inputArea.toFixed(6)} (floor ${minArea.toFixed(6)}), ${collapsed} feature(s) with no ` +
        `detected defect collapsed to empty, ${badTypes} feature(s) with a non-polygon geometry ` +
        `type${stillViolating ? ", output still has coverage violations" : ""}` +
        `${underFilled ? ", a gap at or below the fill width remains" : ""} ` +
        `(gap_maximum_width=${gapDeg}).`,
    );
  }
}
