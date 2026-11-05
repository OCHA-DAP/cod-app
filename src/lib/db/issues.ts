import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { GEOMETRY_TYPE, NOTCH_SPACING, SNAP_TOLERANCE } from "./constants";
import { buildGapTable, buildOverlapTable, emptyRegions, isMicroSql } from "./coverage";
import { detectNotches } from "./notches";
import { degSqToM2, degToM } from "./units";

// Shared gap/overlap issues-table assembly, used by topo-clean (against
// its own tc_* tables, plus reclean-loop fixed-status tracking layered on top
// in its own pipeline/issues.ts) and by detect (a thin, read-only pass over
// these same builders with no reclean loop). Column shape matches
// topo-tools' unified issues schema (ADR-0036): every row carries every
// column, null where the row's kind doesn't apply.

export interface IssueRow {
  key: string; // "gap-3" / "overlap-7" — stable id, also the map feature id
  kind: IssueKind;
  areaM2: number; // approximate, for display/sorting
  maxWidthM: number; // Maximum Inscribed Circle diameter, approximate
  thinnessRatio: number | null; // Polsby-Popper compactness; gap rows only, null for overlaps
  nearLengthM: number | null; // notch rows only: length of the two units' edges running close
  units: number[]; // fids involved (overlaps, notches: two units; micro-polygons: one; gaps: none)
  bbox: [number, number, number, number];
}

export type IssueKind = "gap" | "overlap" | "micro-polygon" | "notch";

export interface IssuesResult {
  rows: IssueRow[];
  geojson: string; // FeatureCollection of issue polygons, props {key, kind}
  // Kinds whose detection query threw and was degraded to an empty table — a
  // 0 count for these is NOT "clean", it's "couldn't check." Distinct from a
  // kind that ran fine and found nothing.
  failedKinds: Set<IssueKind>;
}

// Degrades to an empty table on GEOS overlay failure. Returns false when that
// happens — the caller surfaces this so the UI can tell "detection failed"
// apart from "genuinely 0 gaps."
export async function buildGapRegions(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<boolean> {
  try {
    await buildGapTable(conn, targetTable, sourceTable);
    return true;
  } catch (e) {
    console.warn("gap-region detection failed; skipping gaps:", e);
    await emptyRegions(conn, targetTable);
    return false;
  }
}

// Degrades to an empty table on GEOS overlay failure. Returns false when that
// happens. Skips the O(n²) self-join entirely when the input already has no
// coverage violations — a coverage with no invalid edges cannot contain an
// overlapping or nested pair either, matching topo-tools'
// has_coverage_violations() pre-check (confirmed there to cut a ~20min run on
// an already-clean 9,658-fid layer to ~23s, dominated by gap detection).
export async function buildOverlapRegions(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
  hasViolations = true,
): Promise<boolean> {
  if (!hasViolations) {
    await emptyRegions(conn, targetTable, ", NULL::BIGINT AS fa, NULL::BIGINT AS fb");
    return true;
  }
  try {
    await buildOverlapTable(conn, targetTable, sourceTable);
    return true;
  } catch (e) {
    console.warn("overlap detection failed; skipping overlaps:", e);
    await emptyRegions(conn, targetTable, ", NULL::BIGINT AS fa, NULL::BIGINT AS fb");
    return false;
  }
}

// Every micro-polygon part of sourceTable, written to targetTable in the
// microRegionsSql region shape, unfixed. Returns false when detection threw.
export async function buildMicroRegions(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<boolean> {
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT row_number() OVER (ORDER BY fid, hash(geom)) AS n, fid AS unit_a, NULL::BIGINT AS unit_b,
             NULL::VARCHAR AS reason, FALSE AS fixed, geom
      FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS geom FROM ${sourceTable}
            WHERE geom IS NOT NULL)
      WHERE ${isMicroSql("geom")}
    `);
    return true;
  } catch (e) {
    console.warn("micro-polygon detection failed; skipping micro-polygons:", e);
    await emptyRegions(
      conn,
      targetTable,
      ", NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b, NULL::VARCHAR AS reason, FALSE AS fixed",
    );
    return false;
  }
}

// Every notch in sourceTable, as detectNotches' (n, unit_a, unit_b, score, geom).
// Returns false when detection threw.
export async function buildNotchRegions(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<boolean> {
  try {
    await detectNotches(conn, sourceTable, targetTable);
    return true;
  } catch (e) {
    console.warn("notch detection failed; skipping notches:", e);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT NULL::BIGINT AS n, NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b,
             NULL::DOUBLE AS score, NULL::${GEOMETRY_TYPE} AS geom WHERE FALSE
    `);
    return false;
  }
}

// Gap issue rows for regionsTable's holes wider than the noise floor, as
// topo-tools' gap_issues_sql.
export function gapIssuesSql(regionsTable: string): string {
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  return `--sql
    SELECT 'gap-' || row_number() OVER (ORDER BY hash(geom)) AS key, 'gap' AS kind,
           ST_Area(geom) * ${areaFactor} AS area_m2,
           (ST_MaximumInscribedCircle(geom)).radius * 2 * ${widthFactor} AS max_width_m,
           4 * pi() * ST_Area(geom) / POWER(ST_Perimeter(geom), 2) AS thinness_ratio,
           FALSE AS fixed,
           NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b, NULL::VARCHAR AS reason,
           geom,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM ${regionsTable}
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      AND (ST_MaximumInscribedCircle(geom)).radius * 2 > ${SNAP_TOLERANCE}`;
}

export interface AssembleIssuesTables {
  issuesTable: string;
  gapRegionsTable: string;
  overlapRegionsTable: string;
  microRegionsTable?: string;
  notchRegionsTable?: string;
}

// Union a gap-regions table and an overlap-regions table (built by
// buildGapRegions/buildOverlapRegions) into one issuesTable, and derive the
// row list + map GeoJSON from it.
export async function assembleIssues(
  conn: AsyncDuckDBConnection,
  {
    issuesTable,
    gapRegionsTable,
    overlapRegionsTable,
    microRegionsTable,
    notchRegionsTable,
  }: AssembleIssuesTables,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  // Linear scalings (degSqToM2(x) = x * areaFactor, degToM(x) = x * widthFactor) —
  // compute the factor once here so the conversion formula itself stays defined
  // only in units.ts, with SQL just receiving the literal multiplier.
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT key, kind, area_deg, mic_radius_deg,
           area_deg * ${areaFactor} AS area_m2,
           mic_radius_deg * 2 * ${widthFactor} AS max_width_m,
           thinness_ratio, near_length_m,
           fixed, reason,
           NULL::DOUBLE AS filled_area_m2,
           NULL::DOUBLE AS unit_a_area_change_m2,
           NULL::DOUBLE AS unit_b_area_change_m2,
           unit_a, unit_b, geom, xmin, ymin, xmax, ymax
    FROM (
      SELECT 'gap-' || n AS key, 'gap' AS kind, ST_Area(geom) AS area_deg,
             (ST_MaximumInscribedCircle(geom)).radius AS mic_radius_deg,
             4 * pi() * ST_Area(geom) / POWER(ST_Perimeter(geom), 2) AS thinness_ratio,
             NULL::DOUBLE AS near_length_m,
             NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b,
             FALSE AS fixed, NULL::VARCHAR AS reason, geom,
             ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
      FROM ${gapRegionsTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      UNION ALL
      SELECT 'overlap-' || n, 'overlap', ST_Area(geom),
             (ST_MaximumInscribedCircle(geom)).radius,
             NULL::DOUBLE, NULL::DOUBLE,
             fa, fb, FALSE, NULL::VARCHAR, geom,
             ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)
      FROM ${overlapRegionsTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ${microRegionsTable ? `UNION ALL ${microRegionsSql(microRegionsTable, "micro-polygon-")}` : ""}
      ${notchRegionsTable ? `UNION ALL ${notchRegionsSql(notchRegionsTable, gapRegionsTable, overlapRegionsTable)}` : ""}
    ) t
  `);
  return readIssues(conn, issuesTable, failedKinds);
}

// Region rows (n, unit_a, unit_b, reason, fixed, geom) in assembleIssues' inner
// column order, keyed keyPrefix || n.
function microRegionsSql(regionsTable: string, keyPrefix: string): string {
  return `--sql
      SELECT '${keyPrefix}' || n, 'micro-polygon', ST_Area(geom),
             (ST_MaximumInscribedCircle(geom)).radius,
             NULL::DOUBLE, NULL::DOUBLE,
             unit_a, unit_b, fixed, reason, geom,
             ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)
      FROM ${regionsTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`;
}

// Notch rows in assembleIssues' inner column order, minus notches that touch a gap or a
// same-pair overlap (wedge tips already reported as those). Area and width stay null, as in py.
function notchRegionsSql(regionsTable: string, gapTable: string, overlapTable: string): string {
  return `--sql
      SELECT 'notch-' || n, 'notch', NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE,
             score * ${degToM(NOTCH_SPACING)},
             unit_a, unit_b, FALSE, NULL::VARCHAR, geom,
             ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)
      FROM ${regionsTable} nr
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        AND NOT EXISTS (
          SELECT 1 FROM ${gapTable} g
          WHERE g.geom IS NOT NULL AND ST_Intersects(nr.geom, g.geom)
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${overlapTable} o
          WHERE least(o.fa, o.fb) = least(nr.unit_a, nr.unit_b)
            AND greatest(o.fa, o.fb) = greatest(nr.unit_a, nr.unit_b)
            AND ST_Intersects(nr.geom, o.geom)
        )`;
}

// Replaces issuesTable's rows keyed keyPrefix* with regionsTable's micro rows.
export async function replaceMicroIssues(
  conn: AsyncDuckDBConnection,
  issuesTable: string,
  regionsTable: string | null,
  keyPrefix: string,
): Promise<void> {
  await conn.query(`DELETE FROM ${issuesTable} WHERE starts_with(key, '${keyPrefix}')`);
  if (!regionsTable) return;
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  await conn.query(`--sql
    INSERT INTO ${issuesTable} BY NAME
    SELECT key, kind, area_deg, mic_radius_deg,
           area_deg * ${areaFactor} AS area_m2,
           mic_radius_deg * 2 * ${widthFactor} AS max_width_m,
           thinness_ratio, near_length_m, fixed, reason, unit_a, unit_b,
           geom, xmin, ymin, xmax, ymax
    FROM (${microRegionsSql(regionsTable, keyPrefix)}) t(
      key, kind, area_deg, mic_radius_deg, thinness_ratio, near_length_m,
      unit_a, unit_b, fixed, reason, geom, xmin, ymin, xmax, ymax)
  `);
}

// Reads issuesTable back as the row list and map GeoJSON.
export async function readIssues(
  conn: AsyncDuckDBConnection,
  issuesTable: string,
  failedKinds: Set<IssueKind>,
): Promise<IssuesResult> {
  const meta = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, near_length_m, unit_a, unit_b,
           xmin, ymin, xmax, ymax
    FROM ${issuesTable}
    ORDER BY
      CASE kind WHEN 'overlap' THEN 0 ELSE 1 END,
      CASE kind WHEN 'overlap' THEN -max_width_m ELSE max_width_m END
  `);
  const rows: IssueRow[] = (
    meta.toArray() as Array<{
      key: string;
      kind: IssueKind;
      area_m2: number | null;
      max_width_m: number | null;
      thinness_ratio: number | null;
      near_length_m: number | null;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
    }>
  ).map((r) => ({
    key: r.key,
    kind: r.kind,
    areaM2: r.area_m2 ?? NaN,
    maxWidthM: r.max_width_m ?? NaN,
    thinnessRatio: r.thinness_ratio,
    nearLengthM: r.near_length_m,
    units: [r.unit_a, r.unit_b]
      .filter((u): u is bigint | number => u !== null)
      .map((u) => Number(u)),
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, near_length_m, unit_a, unit_b,
           reason, ST_AsGeoJSON(geom) AS _geom
    FROM ${issuesTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      area_m2: number | null;
      max_width_m: number | null;
      thinness_ratio: number | null;
      near_length_m: number | null;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      reason: string | null;
      _geom: string;
    }>
  ).map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: {
      key: r.key,
      kind: r.kind,
      area_m2: r.area_m2,
      max_width_m: r.max_width_m,
      thinness_ratio: r.thinness_ratio,
      near_length_m: r.near_length_m,
      // BIGINT columns surface as JS `bigint`, which JSON.stringify can't serialize.
      unit_a: r.unit_a === null ? null : Number(r.unit_a),
      unit_b: r.unit_b === null ? null : Number(r.unit_b),
      reason: r.reason,
    },
  }));
  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }), failedKinds };
}
