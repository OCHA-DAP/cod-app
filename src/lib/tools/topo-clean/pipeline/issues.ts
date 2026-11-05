import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import {
  assembleIssues,
  buildGapRegions as sharedBuildGapRegions,
  buildOverlapRegions as sharedBuildOverlapRegions,
  gapIssuesSql,
  readIssues,
  replaceMicroIssues,
  type IssueKind,
  type IssueRow,
  type IssuesResult,
} from "$lib/db/issues";
import { detectNotches } from "$lib/db/notches";
import { degSqToM2, degToM } from "$lib/db/units";
import { niceNum } from "./units";

export type { IssueKind, IssueRow, IssuesResult } from "$lib/db/issues";

// Polsby-Popper compactness cutoff (4·π·Area / Perimeter², 1.0 = circle,
// →0 = elongated crack) below which a gap is treated as a digitization
// sliver rather than a real feature. Same formula and cutoff guidance
// ArcGIS Pro's "Polygon Sliver" data-quality check uses. Not user-tunable —
// see measureThinFillM.
const DEFAULT_THINNESS_RATIO = 0.3;

// Headroom over the widest qualifying gap's width in Thin mode, so that gap
// reliably clears ST_CoverageClean's internal <= width comparison — just
// enough, not "2x and round," to avoid also sweeping in a wider, non-thin
// gap Thin wasn't meant to touch (ST_CoverageClean only understands width,
// not thinness). Matches topo-tools' current tuning
// (AUTO_GAP_WIDTH_EPSILON_FACTOR, widened from 1.001 to 1.01 after real-data
// testing).
const AUTO_GAP_WIDTH_EPSILON_FACTOR = 1.01;

const NEW_GAP_PREFIX = "gap-new-";

// A discrete topology problem in the *input* coverage, surfaced in the issues
// table so the user can click to zoom to it. Gaps and overlaps are computed once
// at load (a property of the input). Region detection + issue-row assembly are
// shared with detect (see $lib/db/issues) — this file adds only what's
// specific to a reclean loop: persisted fixed-status tracking and the
// gap-fill-mode width resolution the Minimal/Thin/All UI needs.

export async function buildGapRegions(conn: AsyncDuckDBConnection): Promise<boolean> {
  return sharedBuildGapRegions(conn, "tc_gap_regions", "layer_01");
}

export async function buildOverlapRegions(
  conn: AsyncDuckDBConnection,
  hasViolations = true,
): Promise<boolean> {
  return sharedBuildOverlapRegions(conn, "tc_overlap_regions", "layer_01", hasViolations);
}

// Assemble the issues table/rows/geojson from the gap + overlap region tables
// and the input's merged micro-polygons (tc_micro), built once per load.
export async function buildIssues(
  conn: AsyncDuckDBConnection,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_micro_regions AS
    SELECT row_number() OVER (ORDER BY unit_a, hash(geom)) AS n, unit_a, unit_b, reason, fixed, geom
    FROM tc_micro
  `);
  try {
    return await assembleIssues(
      conn,
      {
        issuesTable: "tc_issues",
        gapRegionsTable: "tc_gap_regions",
        overlapRegionsTable: "tc_overlap_regions",
        microRegionsTable: "tc_micro_regions",
        notchRegionsTable: "tc_notch_regions",
      },
      failedKinds,
    );
  } finally {
    await conn.query("DROP TABLE IF EXISTS tc_micro_regions");
  }
}

// Swaps in the micro-polygon rows of the latest clean's own output merge
// (tc_clean_micro, absent when the clean was skipped).
export async function syncOutputMicroIssues(
  conn: AsyncDuckDBConnection,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  const r = await conn.query(
    "SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name = 'tc_clean_micro'",
  );
  const exists = Number((r.toArray()[0] as { n: bigint | number }).n) > 0;
  if (exists) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_clean_micro_regions AS
      SELECT row_number() OVER (ORDER BY unit_a, hash(geom)) AS n, unit_a, unit_b, reason, fixed, geom
      FROM tc_clean_micro
    `);
  }
  try {
    await replaceMicroIssues(
      conn,
      "tc_issues",
      exists ? "tc_clean_micro_regions" : null,
      "micro-polygon-output-",
    );
  } finally {
    await conn.query("DROP TABLE IF EXISTS tc_clean_micro_regions");
  }
  return readIssues(conn, "tc_issues", failedKinds);
}

// Check which issues are resolved in the current cleaned output (tc_clean),
// persisting the result into tc_issues.fixed so it survives into any export
// (see export.ts's topology_issues columns) rather than living only in this
// function's return value. Overlaps are always fixed by ST_CoverageClean. A gap
// is fixed when no gap still open in tc_clean overlaps it; an open gap that
// overlaps no detected gap gets its own unfixed row.
//
// Also persists outcome columns (measured after the fix, not detection-time
// values) matching topo-tools' issues-file schema: unit_a/b_area_change_m2
// (an overlap-adjacent unit's own area delta) and filled_area_m2 (how much of
// a gap the cleaned coverage now actually fills, 0 if unfilled).
export async function checkFixedIssues(
  conn: AsyncDuckDBConnection,
  rows: IssueRow[],
  failedKinds: Set<IssueKind> = new Set(),
): Promise<Set<string>> {
  const fixed = new Set<string>();
  rows
    .filter((r) => r.kind === "overlap" || r.kind === "micro-polygon")
    .forEach((r) => fixed.add(r.key));
  const areaFactor = degSqToM2(1).toExponential();

  try {
    await conn.query(`--sql
      UPDATE tc_issues SET
        fixed = (kind = 'overlap'),
        unit_a_area_change_m2 = (
          COALESCE((SELECT ST_Area(geom) FROM tc_clean WHERE fid = tc_issues.unit_a), 0)
          - COALESCE((SELECT ST_Area(geom) FROM layer_01 WHERE fid = tc_issues.unit_a), 0)
        ) * ${areaFactor},
        unit_b_area_change_m2 = (
          COALESCE((SELECT ST_Area(geom) FROM tc_clean WHERE fid = tc_issues.unit_b), 0)
          - COALESCE((SELECT ST_Area(geom) FROM layer_01 WHERE fid = tc_issues.unit_b), 0)
        ) * ${areaFactor}
      WHERE kind IN ('overlap', 'notch')
    `);
  } catch (e) {
    console.warn("checkFixedIssues: persisting overlap fixed status failed:", e);
  }

  if (rows.some((r) => r.kind === "notch")) {
    try {
      // Fixed unless a notch between the same units still intersects it in the output.
      await detectNotches(conn, "tc_clean", "tc_notch_remaining");
      await conn.query(`--sql
        UPDATE tc_issues i SET fixed = NOT EXISTS (
          SELECT 1 FROM tc_notch_remaining r
          WHERE least(r.unit_a, r.unit_b) = least(i.unit_a, i.unit_b)
            AND greatest(r.unit_a, r.unit_b) = greatest(i.unit_a, i.unit_b)
            AND ST_Intersects(r.geom, i.geom)
        )
        WHERE kind = 'notch'
      `);
      const result = await conn.query("SELECT key FROM tc_issues WHERE kind = 'notch' AND fixed");
      for (const row of result.toArray() as Array<{ key: string }>) fixed.add(row.key);
    } catch (e) {
      console.warn("checkFixedIssues: notch fixed status unavailable:", e);
    } finally {
      await conn.query("DROP TABLE IF EXISTS tc_notch_remaining");
    }
  }

  try {
    await conn.query(`DELETE FROM tc_issues WHERE starts_with(key, '${NEW_GAP_PREFIX}')`);
    if (!(await sharedBuildGapRegions(conn, "tc_open_gap_regions", "tc_clean"))) return fixed;
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_open_gaps AS SELECT * FROM (${gapIssuesSql("tc_open_gap_regions")})
    `);
    if (rows.some((r) => r.kind === "gap")) {
      await conn.query(`--sql
        UPDATE tc_issues i SET fixed = NOT EXISTS (
          SELECT 1 FROM tc_open_gaps r
          WHERE ST_Intersects(r.geom, i.geom) AND ST_Area(ST_Intersection(r.geom, i.geom)) > 0
        )
        WHERE kind = 'gap'
      `);
      await conn.query(`--sql
        UPDATE tc_issues
        SET filled_area_m2 = ST_Area(ST_Intersection(tc_issues.geom, u.geom)) * ${areaFactor}
        FROM (
          SELECT ST_Union_Agg(geom) AS geom FROM tc_clean
          WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        ) AS u
        WHERE tc_issues.kind = 'gap'
      `);
      const result = await conn.query(`SELECT key FROM tc_issues WHERE kind = 'gap' AND fixed`);
      for (const row of result.toArray() as Array<{ key: string }>) {
        fixed.add(row.key);
      }
    }
    // With load-time gap detection failed, every open gap would look new.
    if (!failedKinds.has("gap")) {
      await conn.query(`--sql
        INSERT INTO tc_issues BY NAME
        SELECT * REPLACE (
          '${NEW_GAP_PREFIX}' || row_number() OVER (ORDER BY hash(geom)) AS key,
          'gap opened by the fix' AS reason
        )
        FROM tc_open_gaps r
        WHERE NOT EXISTS (
          SELECT 1 FROM tc_issues i
          WHERE i.kind = 'gap' AND ST_Intersects(r.geom, i.geom)
            AND ST_Area(ST_Intersection(r.geom, i.geom)) > 0
        )
      `);
    }
  } catch (e) {
    console.warn("checkFixedIssues failed; fixed status unavailable:", e);
  } finally {
    await conn.query("DROP TABLE IF EXISTS tc_open_gap_regions");
    await conn.query("DROP TABLE IF EXISTS tc_open_gaps");
  }

  return fixed;
}

// Derive the gap-fill widths the UI's Minimal/Thin/All modes need.
//
// Minimal (the default) only considers gaps at or below SNAP_TOLERANCE —
// floating-point-noise scale, never a real feature — and fills them at
// exactly that width. Matches topo-tools' own default (no shape
// heuristic; ADR-0033/0034).
//
// sliderCeilingM ("2x the widest detected gap, rounded up to a nice number")
// is UI-only: it sizes the Manual slider's max/step and All mode's display
// text. All mode's actual fill width is topo-tools' fixed
// GAP_MAXIMUM_WIDTH_ALL_DEG sentinel (applied directly in pipeline/index.ts),
// not derived from this number — a looser bound changes no outcome for All
// regardless, since it already fills every detected gap.
//
// Any of these can be 0 (no qualifying gaps), meaning "fill nothing."
export function resolveGapFillWidths(rows: IssueRow[]): {
  sliderCeilingM: number;
  minimalFillM: number;
} {
  const widthsOf = (predicate: (r: IssueRow) => boolean) =>
    rows
      .filter(
        (r) =>
          r.kind === "gap" &&
          !r.key.startsWith(NEW_GAP_PREFIX) &&
          r.maxWidthM > 0 &&
          predicate(r),
      )
      .map((r) => r.maxWidthM);
  const allWidths = widthsOf(() => true);
  const snapToleranceM = degToM(SNAP_TOLERANCE);
  const hasNoiseScaleGap = widthsOf((r) => r.maxWidthM <= snapToleranceM).length > 0;
  return {
    sliderCeilingM: allWidths.length ? niceNum(Math.max(...allWidths) * 2) : 0,
    minimalFillM: hasNoiseScaleGap ? snapToleranceM : 0,
  };
}

// Thin mode's fill width, 0 with no thin gap. Measured on the table the clean
// starts from, since closing notches reshapes gaps.
export async function measureThinFillM(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
): Promise<number> {
  const regions = sourceTable === "layer_01" ? "tc_gap_regions" : "tc_source_gap_regions";
  if (sourceTable !== "layer_01") await sharedBuildGapRegions(conn, regions, sourceTable);
  try {
    const r = await conn.query(`--sql
      SELECT MAX(max_width_m) AS width FROM (${gapIssuesSql(regions)})
      WHERE thinness_ratio <= ${DEFAULT_THINNESS_RATIO}
    `);
    return ((r.toArray()[0] as { width: number | null }).width ?? 0) * AUTO_GAP_WIDTH_EPSILON_FACTOR;
  } finally {
    await conn.query("DROP TABLE IF EXISTS tc_source_gap_regions");
  }
}
