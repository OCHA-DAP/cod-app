import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { WORLD_BOUNDS_WKT } from "$lib/db/constants";

// A point in no Voronoi cell, or a cell holding several: no retry, as topo-tools.
export class AssignmentError extends Error {}

export async function stageVoronoi(conn: AsyncDuckDBConnection): Promise<void> {
  // Clip only cells whose own bbox exceeds WGS84 world bounds (GEOS's own
  // exterior-cell envelope can overshoot at country scale). See ADR 0030.
  console.log("[EE-DEBUG] voronoi:1 ST_VoronoiDiagram (layer_04_tmp1)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_04_tmp0 AS
    SELECT row_number() OVER () AS point_id, fid, geom FROM layer_03b
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_04_tmp1 AS
    SELECT row_number() OVER () AS cell_id, CASE
        WHEN ST_XMin(geom) < -180 OR ST_XMax(geom) > 180
          OR ST_YMin(geom) < -90  OR ST_YMax(geom) > 90
        THEN ST_CollectionExtract(
            ST_Intersection(geom, ST_GeomFromText('${WORLD_BOUNDS_WKT}')), 3
        )
        ELSE geom
    END AS geom
    FROM (
      SELECT UNNEST(ST_Dump(
        ST_CollectionExtract(
          ST_VoronoiDiagram(ST_Collect(list(geom))), 3
        )
      )).geom AS geom
      FROM layer_04_tmp0
    )
  `);

  // Assign source fid to each Voronoi cell via point-in-polygon. ST_Intersects
  // (not ST_Within) handles generators that land exactly on a cell boundary,
  // but triggers SPATIAL_JOIN's ~1x memory_limit reservation, so we override
  // to 999GB for the join only.
  const origLimit = (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0]
    .v as string;
  await conn.query("SET memory_limit = '999GB'");
  try {
    console.log("[EE-DEBUG] voronoi:2 ST_Intersects cell-to-fid join (layer_04_tmp2)");
    await conn.query(`--sql
      CREATE OR REPLACE TABLE layer_04_tmp2 AS
      SELECT a.point_id, a.fid, b.cell_id, b.geom, ST_Contains(b.geom, a.geom) AS inside
      FROM layer_04_tmp0 AS a
      JOIN layer_04_tmp1 AS b ON ST_Intersects(a.geom, b.geom)
    `);
  } finally {
    await conn.query(`SET memory_limit = '${origLimit}'`);
  }

  const [pts, assigned] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM layer_04_tmp0"),
    conn.query("SELECT COUNT(DISTINCT point_id) AS n FROM layer_04_tmp2"),
  ]);
  const ptCount = Number(pts.toArray()[0].n);
  const assignedCount = Number(assigned.toArray()[0].n);
  if (assignedCount < ptCount) {
    throw new AssignmentError(
      `Voronoi assignment incomplete: ${assignedCount}/${ptCount} points assigned`,
    );
  }
  await checkCells(conn);

  await conn.query("DROP TABLE IF EXISTS layer_03b");
  await conn.query("DROP TABLE IF EXISTS layer_04_tmp0");
  await conn.query("DROP TABLE IF EXISTS layer_04_tmp1");

  // Union Voronoi cells by fid. ST_MakeValid defends against invalid cells
  // produced by ST_VoronoiDiagram on degenerate point configurations — feeding
  // an invalid polygon to ST_Union_Agg segfaults GEOS.
  console.log("[EE-DEBUG] voronoi:3 union cells by fid (layer_04)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_04 AS
    SELECT fid, ST_Union_Agg(ST_MakeValid(geom)) AS geom
    FROM layer_04_tmp2
    GROUP BY fid
  `);

  await conn.query("DROP TABLE IF EXISTS layer_04_tmp2");
}

// A cell holding several distinct generators is a degenerate GEOS cell that
// would overlap its neighbours.
export async function checkCells(conn: AsyncDuckDBConnection): Promise<void> {
  const bad = (
    await conn.query(`--sql
      WITH multi AS (
        SELECT cell_id FROM layer_04_tmp2 WHERE inside
        GROUP BY cell_id HAVING count(*) > 1
      )
      SELECT t.cell_id AS cell_id, count(DISTINCT (ST_X(p.geom), ST_Y(p.geom))) AS n,
        count(DISTINCT t.fid) AS fids, any_value(ST_Extent(c.geom))::VARCHAR AS bbox
      FROM layer_04_tmp2 t
      JOIN multi USING (cell_id)
      JOIN layer_04_tmp0 p USING (point_id)
      JOIN layer_04_tmp1 c USING (cell_id)
      WHERE t.inside
      GROUP BY t.cell_id
      HAVING n > 1
      ORDER BY n DESC
    `)
  ).toArray() as Array<{
    cell_id: bigint | number;
    n: bigint | number;
    fids: bigint | number;
    bbox: string;
  }>;
  if (bad.length > 0) {
    const { cell_id, n, fids, bbox } = bad[0];
    throw new AssignmentError(
      `Voronoi cell check failed: ${bad.length} cell(s) hold more than one point, worst cell ${cell_id} holds ${n} points from ${fids} fid(s), bbox ${bbox}`,
    );
  }
}
