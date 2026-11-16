import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { GEOMETRY_TYPE } from "$lib/db/constants";
import { assignOneDropIssuesSql } from "$lib/db/assignOne";
import {
  CODE_FALLBACK_REASON,
  CODE_MISMATCH_REASON,
  type AssignmentMethod,
} from "$lib/db/codeJoin";
import { uncoveredOverlayIssuesSql } from "$lib/db/issues";

// Combined issues report: dropped input features, clip-detached pieces, merged
// micro-polygons, invalid edges, gaps after the final clean, and code-join rows when one was supplied (docs/adr/0045).

export interface MosaicIssueRow {
  key: string;
  kind:
    | "unassigned"
    | "clip-empty"
    | "detached-part"
    | "micro-polygon"
    | "invalid-edge"
    | "gap"
    | "code-mismatch"
    | "code-fallback";
  areaM2: number | null;
  maxWidthM: number | null;
  thinnessRatio: number | null;
  unitA: number | null;
  unitB?: number | null;
  overlayFid?: number | null;
  reason?: string | null;
  bbox: [number, number, number, number];
}

export interface MosaicIssuesResult {
  rows: MosaicIssueRow[];
  geojson: string; // FeatureCollection, props {key, kind, area_m2, max_width_m, unit_a, unit_b, overlay_fid, reason}
}

export interface AssignmentOutcomeInfo {
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

export async function buildMosaicIssues(
  conn: AsyncDuckDBConnection,
  assignment: AssignmentOutcomeInfo = {},
): Promise<MosaicIssuesResult> {
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ms_gaps AS
      ${uncoveredOverlayIssuesSql("cl_clip", "overlay_layer_01", "cl_clip_cover")}
    `);
  } catch (e) {
    console.warn("gap issues failed:", e);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ms_gaps AS
      SELECT NULL::VARCHAR AS key, NULL::VARCHAR AS kind, NULL::DOUBLE AS area_m2,
             NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio, NULL::BOOLEAN AS fixed,
             NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b, NULL::BIGINT AS overlay_fid,
             NULL::VARCHAR AS reason, NULL::${GEOMETRY_TYPE} AS geom, NULL::DOUBLE AS xmin,
             NULL::DOUBLE AS ymin, NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymax
      WHERE FALSE
    `);
  } finally {
    await conn.query("DROP TABLE IF EXISTS cl_clip_cover");
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_unassigned AS
    SELECT key, kind, NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m,
           NULL::DOUBLE AS thinness_ratio, unit_a, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM (${assignOneDropIssuesSql("cl_clip", "ms_micro")})
  `);

  // Every assigned input feature shares the single run-wide assignment_method
  // (assign-one is per-file, not per-input-feature; see docs/adr/0045).
  const codeKind: "code-mismatch" | "code-fallback" | null =
    assignment.assignmentMethod === "code" && assignment.spatialAgrees === false
      ? "code-mismatch"
      : assignment.assignmentMethod === "spatial_fallback"
        ? "code-fallback"
        : null;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_code_issues AS
    SELECT ${codeKind ? `'${codeKind}-' || a.input_fid` : "NULL::VARCHAR"} AS key,
           ${codeKind ? `'${codeKind}'` : "NULL::VARCHAR"} AS kind,
           NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
           a.input_fid AS unit_a, a.overlay_fid AS overlay_fid,
           ${codeKind === "code-mismatch" ? `'${CODE_MISMATCH_REASON}'` : codeKind === "code-fallback" ? `'${CODE_FALLBACK_REASON}'` : "NULL::VARCHAR"} AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE ${codeKind ? "TRUE" : "FALSE"}
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ms_issues AS
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, NULL::BOOLEAN AS fixed, unit_a,
           NULL::BIGINT AS unit_b, overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM ms_unassigned
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, NULL, unit_a, NULL::BIGINT,
           overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM ms_code_issues
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, fixed, unit_a, unit_b,
           overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM cl_detached
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, NULL::DOUBLE, fixed, unit_a, unit_b,
           NULL::BIGINT AS overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM ms_micro
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, fixed, unit_a, unit_b,
           overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM ms_invalid
    UNION ALL
    SELECT key, kind, area_m2, max_width_m, thinness_ratio, fixed, unit_a, unit_b,
           overlay_fid, reason, geom, xmin, ymin, xmax, ymax
    FROM ms_gaps
  `);
  await conn.query("DROP TABLE IF EXISTS ms_gaps");
  await conn.query("DROP TABLE IF EXISTS ms_code_issues");
  await conn.query("DROP TABLE IF EXISTS cl_detached");

  const meta = (
    await conn.query(`--sql
      SELECT key, kind, area_m2, max_width_m, thinness_ratio, unit_a, unit_b, overlay_fid, reason,
             xmin, ymin, xmax, ymax
      FROM ms_issues
    `)
  ).toArray() as Array<{
    key: string;
    kind: MosaicIssueRow["kind"];
    area_m2: number | null;
    max_width_m: number | null;
    thinness_ratio: number | null;
    unit_a: bigint | number | null;
    unit_b: bigint | number | null;
    overlay_fid: bigint | number | null;
    reason: string | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  }>;

  const rows: MosaicIssueRow[] = meta.map((r) => ({
      key: r.key,
      kind: r.kind,
      areaM2: r.area_m2,
      maxWidthM: r.max_width_m,
      thinnessRatio: r.thinness_ratio,
      unitA: r.unit_a == null ? null : Number(r.unit_a),
      unitB: r.unit_b == null ? null : Number(r.unit_b),
      overlayFid: r.overlay_fid == null ? null : Number(r.overlay_fid),
      reason: r.reason,
      bbox: [r.xmin, r.ymin, r.xmax, r.ymax] as [number, number, number, number],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, area_m2, max_width_m, unit_a, unit_b, overlay_fid, reason,
           ST_AsGeoJSON(geom) AS _geom
    FROM ms_issues
  `);
  const features = (
    gj.toArray() as Array<{
      key: string;
      kind: string;
      area_m2: number | null;
      max_width_m: number | null;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      overlay_fid: bigint | number | null;
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
      unit_a: r.unit_a == null ? null : Number(r.unit_a),
      unit_b: r.unit_b == null ? null : Number(r.unit_b),
      overlay_fid: r.overlay_fid == null ? null : Number(r.overlay_fid),
      reason: r.reason,
    },
  }));

  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}
