import { SUBDIVIDE_MAX_VERTICES, SUBDIVIDE_MIN_VERTICES } from "./constants";

// Bbox SQL fragments for prefiltered joins. A scalar bbox predicate plans as
// PIECEWISE_MERGE_JOIN, avoiding SPATIAL_JOIN's ~1x RAM virtual reservation.
// Bbox columns must be precomputed in a CTE, not called inline in a JOIN
// condition — DuckDB recomputes an inline ST_XMin/ST_XMax/etc. per pairwise
// comparison, not once per row, which hangs indefinitely on a table with even
// a few very-high-vertex-count polygons. Mirrors topo-tools'
// bbox_columns_sql() (core/duckdb_utils.py).

// A geometry list: geomExpr split into bounded-vertex pieces, or as is.
export function subdivideSql(geomExpr = "geom"): string {
  return `CASE WHEN ST_NPoints(${geomExpr}) >= ${SUBDIVIDE_MIN_VERTICES}
    THEN list_transform(ST_Dump(ST_Subdivide(${geomExpr}, ${SUBDIVIDE_MAX_VERTICES})), lambda d: d.geom)
    ELSE [${geomExpr}] END`;
}

export function bboxColumnsSql(geomExpr = "geom"): string {
  return `ST_XMin(${geomExpr}) AS xmin, ST_XMax(${geomExpr}) AS xmax, ST_YMin(${geomExpr}) AS ymin, ST_YMax(${geomExpr}) AS ymax`;
}

export function bboxOverlapSql(a: string, b: string): string {
  return `${b}.xmax >= ${a}.xmin AND ${b}.xmin <= ${a}.xmax AND ${b}.ymax >= ${a}.ymin AND ${b}.ymin <= ${a}.ymax`;
}
