import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, subdivideSql } from "./bbox";
import { intersectPairs } from "./overlap";
import {
  type AssignmentMethod,
  type MatchColumnOptions,
  pickFileCodeWinner,
  resolveAssignment,
  resolveMatchColumns,
} from "./codeJoin";

export interface AssignOneResult {
  // Null when no input feature overlaps any overlay feature.
  overlayFid: number | null;
  assignedCount: number;
  // Input features overlapping the winner; the rest are assigned anyway and clip to empty.
  overlappingCount: number;
  // Set only when a match column was supplied; see docs/adr/0045.
  assignmentMethod?: AssignmentMethod;
  spatialAgrees?: boolean | null;
}

export const CLIP_EMPTY_REASON = "clip intersection with its overlay polygon was empty";

// Issue rows for input features missing from clipTable: 'unassigned' when no
// winner took them, 'clip-empty' when their clip to the winner came out empty.
export function assignOneDropIssuesSql(
  clipTable: string,
  microTable: string | null = null,
): string {
  const notMicro = microTable ? `AND a.input_fid NOT IN (SELECT unit_a FROM ${microTable})` : "";
  return `--sql
    SELECT 'unassigned-' || c.fid AS key, 'unassigned' AS kind,
           c.fid AS unit_a, NULL::BIGINT AS overlay_fid, NULL::VARCHAR AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM input_layer_01 c
    WHERE c.fid NOT IN (SELECT input_fid FROM cl_assign)
    UNION ALL
    SELECT 'clip-empty-' || a.input_fid AS key, 'clip-empty' AS kind,
           a.input_fid AS unit_a, a.overlay_fid AS overlay_fid,
           '${CLIP_EMPTY_REASON}' AS reason,
           c.geom,
           ST_XMin(c.geom) AS xmin, ST_YMin(c.geom) AS ymin, ST_XMax(c.geom) AS xmax, ST_YMax(c.geom) AS ymax
    FROM cl_assign a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.input_fid NOT IN (SELECT fid FROM ${clipTable}) ${notMicro}`;
}

// Port of topo-tools' assign_one (py ADR 0082): every input feature goes to
// the majority-vote winner, into cl_assign, even one that doesn't overlap it.
export async function assignOne(
  conn: AsyncDuckDBConnection,
  matchColumns: MatchColumnOptions = {},
): Promise<AssignOneResult> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_input_parts AS
    SELECT ROW_NUMBER() OVER () AS id, fid, geom, ${bboxColumnsSql("geom")}
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS geom FROM input_layer_01)
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_overlay_parts AS
    SELECT ROW_NUMBER() OVER () AS part_id, fid, part_geom, ST_NPoints(part_geom) AS n_points
    FROM (SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM overlay_layer_01)
  `);

  // Heavy overlay parts are split so input features bbox-prefilter against the pieces.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_overlay_pieces AS
    WITH t AS (SELECT fid AS overlay_fid, UNNEST(${subdivideSql("part_geom")}) AS geom FROM cl_overlay_parts)
    SELECT ROW_NUMBER() OVER () AS id, overlay_fid, geom, ${bboxColumnsSql("geom")} FROM t
  `);

  // Area-weighted overlap per piece pair. A touch-only pair (shared edge or
  // corner) has zero area and is dropped below, matching topo-tools'
  // assign_one, which only counts shared_area > 0.
  await intersectPairs(conn, "assignOne", "cl_input_parts", "cl_overlay_pieces", "cl_pairs_geom");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_pairs_raw AS
    SELECT c.fid AS input_fid, p.overlay_fid, ST_Area(g.geom) AS shared_area
    FROM cl_pairs_geom g
    JOIN cl_input_parts c ON c.id = g.a_id
    JOIN cl_overlay_pieces p ON p.id = g.b_id
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs_geom");
  await conn.query("DROP TABLE IF EXISTS cl_overlay_pieces");

  // Aggregate part-level areas up to one row per (input feature, overlay feature) — an input feature
  // with multiple parts overlapping the same overlay feature still counts as one vote
  // — and drop any pair whose total shared area is zero (touch-only).
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_pairs AS
    SELECT input_fid, overlay_fid, SUM(shared_area) AS shared_area
    FROM cl_pairs_raw
    GROUP BY input_fid, overlay_fid
    HAVING SUM(shared_area) > 0
  `);
  await conn.query("DROP TABLE IF EXISTS cl_pairs_raw");

  const votes = (
    await conn.query(`--sql
      SELECT overlay_fid, COUNT(DISTINCT input_fid) AS n_inputs
      FROM cl_pairs GROUP BY overlay_fid
      ORDER BY n_inputs DESC, overlay_fid ASC
      LIMIT 1
    `)
  ).toArray() as Array<{ overlay_fid: bigint | number; n_inputs: bigint | number }>;

  await conn.query("DROP TABLE IF EXISTS cl_input_parts");
  await conn.query("DROP TABLE IF EXISTS cl_overlay_parts");

  if (votes.length === 0) {
    await conn.query("DROP TABLE IF EXISTS cl_pairs");
    await conn.query("CREATE OR REPLACE TABLE cl_assign (input_fid BIGINT, overlay_fid BIGINT)");
    return { overlayFid: null, assignedCount: 0, overlappingCount: 0 };
  }

  const spatialOverlayFid = Number(votes[0].overlay_fid);

  const resolvedCols = resolveMatchColumns(matchColumns);
  let overlayFid = spatialOverlayFid;
  let assignmentMethod: AssignmentMethod | undefined;
  let spatialAgrees: boolean | null | undefined;
  if (resolvedCols) {
    const codeOverlayFid = await pickFileCodeWinner(conn, {
      inputAttrTable: "input_layer_attr",
      overlayAttrTable: "overlay_layer_attr",
      pairsTable: "cl_pairs",
      pairsInputCol: "input_fid",
      pairsOverlayCol: "overlay_fid",
      columns: resolvedCols,
    });
    const outcome = resolveAssignment(codeOverlayFid, spatialOverlayFid);
    overlayFid = outcome.overlayFid;
    assignmentMethod = outcome.assignmentMethod;
    spatialAgrees = outcome.spatialAgrees;
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cl_assign AS
    SELECT fid AS input_fid, ${overlayFid}::BIGINT AS overlay_fid FROM input_layer_01
  `);
  const [assignedRes, overlappingRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM cl_assign"),
    conn.query(
      `SELECT COUNT(DISTINCT input_fid) AS n FROM cl_pairs WHERE overlay_fid = ${overlayFid}`,
    ),
  ]);
  await conn.query("DROP TABLE IF EXISTS cl_pairs");

  return {
    overlayFid,
    assignedCount: Number((assignedRes.toArray()[0] as { n: bigint | number }).n),
    overlappingCount: Number((overlappingRes.toArray()[0] as { n: bigint | number }).n),
    assignmentMethod,
    spatialAgrees,
  };
}
