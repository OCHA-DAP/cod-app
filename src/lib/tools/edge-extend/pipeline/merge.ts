import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "$lib/db/bbox";
import { vertexBatches } from "$lib/db/batches";
import { MERGE_VERTEX_BUDGET, NODING_FALLBACK_GRID, SNAP_TOLERANCE } from "$lib/db/constants";

const pieceUnion = (extension: string, outside: string) => `CASE
  WHEN ST_IsEmpty(outside) THEN extension
  WHEN ST_IsEmpty(extension) THEN outside
  ELSE ST_Union(${extension}, ${outside})
END`;

export async function stageMerge(
  conn: AsyncDuckDBConnection,
  budget = MERGE_VERTEX_BUDGET,
): Promise<void> {
  // Per-part layer_01 with bbox columns: a whole-fid bbox can span disjoint
  // parts and match nearly everything.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05_tmp1 AS
    WITH parts AS (
      SELECT fid, UNNEST(ST_Dump(geom)).geom AS part_geom FROM layer_01
    )
    SELECT fid, part_geom, ${bboxColumnsSql("part_geom")}
    FROM parts
  `);

  // A DuckDB vector holds up to 2048 rows' differences and a hash join builds
  // its whole right side, so each batch builds only its own neighbour unions.
  const batches = await vertexBatches(
    conn,
    `--sql
    WITH v AS (SELECT rowid AS rid, geom, ${bboxColumnsSql()} FROM layer_04)
    SELECT v.rid AS rid, any_value(ST_NPoints(v.geom)) + coalesce(sum(p.n), 0) AS n
    FROM v
    LEFT JOIN (
      SELECT xmin, xmax, ymin, ymax, ST_NPoints(part_geom) AS n FROM layer_05_tmp1
    ) p ON ${bboxOverlapSql("v", "p")}
    GROUP BY v.rid
    ORDER BY v.rid
  `,
    budget,
  );

  // Each fid is (cell minus other fids) plus (its original outside the cell),
  // so its own coastline is never noded only to be dissolved away again.
  for (const [i, [lo, hi]] of batches.entries()) {
    await conn.query(`--sql
      ${i === 0 ? "CREATE OR REPLACE TABLE layer_05_tmp2 AS" : "INSERT INTO layer_05_tmp2"}
      WITH
      v AS (
        SELECT fid, geom, ${bboxColumnsSql()}
        FROM layer_04 WHERE rowid BETWEEN ${lo} AND ${hi}
      ),
      neighbor_union AS (
        SELECT v.fid AS vfid, ST_Union_Agg(p.part_geom) AS geom
        FROM v
        JOIN layer_05_tmp1 p
          ON p.fid <> v.fid
         AND ${bboxOverlapSql("v", "p")}
         AND ST_Intersects(p.part_geom, v.geom)
        GROUP BY v.fid
      ),
      snapped AS (
        SELECT v.fid,
          CASE WHEN n.geom IS NOT NULL
               THEN ST_Snap(v.geom, n.geom, ${SNAP_TOLERANCE})
               ELSE v.geom
          END AS geom,
          n.geom AS neighbor_geom
        FROM v
        LEFT JOIN neighbor_union n ON v.fid = n.vfid
      )
      SELECT s.fid,
        ST_MakeValid(ST_CollectionExtract(
          CASE WHEN s.neighbor_geom IS NOT NULL
               THEN ST_Difference(s.geom, s.neighbor_geom)
               ELSE s.geom
          END, 3
        )) AS extension,
        ST_CollectionExtract(ST_Difference(o.geom, s.geom), 3) AS outside
      FROM snapped s
      JOIN layer_01 o USING (fid)
    `);
  }

  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE layer_05 AS
      SELECT fid, ${pieceUnion("extension", "outside")} AS geom FROM layer_05_tmp2
    `);
  } catch (e) {
    console.warn(`merge union failed; retrying failing fids on a ${NODING_FALLBACK_GRID} grid:`, e);
    const gridded = await unionPerFid(conn);
    console.warn(`stageMerge: ${gridded} fid(s) unioned on the fallback grid`);
  }

  // A fid with no Voronoi cell keeps its original geometry.
  await conn.query(`--sql
    INSERT INTO layer_05
    SELECT fid, geom FROM layer_01 WHERE fid NOT IN (SELECT fid FROM layer_05)
  `);

  await conn.query("DROP TABLE IF EXISTS layer_05_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_04");
  await conn.query("DROP TABLE IF EXISTS layer_05_tmp2");
}

async function unionPerFid(conn: AsyncDuckDBConnection): Promise<number> {
  const fids = (await conn.query("SELECT fid FROM layer_05_tmp2 ORDER BY fid")).toArray();
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_05 AS
    SELECT fid, extension AS geom FROM layer_05_tmp2 WHERE FALSE
  `);
  const grid = (col: string) => `ST_ReducePrecision(${col}, ${NODING_FALLBACK_GRID})`;
  let gridded = 0;
  for (const { fid } of fids) {
    const insert = (geomExpr: string) => `--sql
      INSERT INTO layer_05 SELECT fid, ${geomExpr} FROM layer_05_tmp2 WHERE fid = ${fid}
    `;
    try {
      await conn.query(insert(pieceUnion("extension", "outside")));
    } catch {
      await conn.query(insert(pieceUnion(grid("extension"), grid("outside"))));
      gridded++;
    }
  }
  return gridded;
}
