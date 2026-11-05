import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "$lib/db/bbox";
import { vertexBatches } from "$lib/db/batches";
import { LINES_VERTEX_BUDGET } from "$lib/db/constants";

export async function stageLines(
  conn: AsyncDuckDBConnection,
  budget = LINES_VERTEX_BUDGET,
): Promise<void> {
  console.log("[EE-DEBUG] lines:1 boundary (layer_02_tmp1)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_02_tmp1 AS
    SELECT fid, geom, ${bboxColumnsSql()}
    FROM (SELECT fid, ST_Boundary(geom) AS geom FROM layer_01)
  `);

  // Per-polygon neighbor union via bbox self-join. Bbox-only is correct: a
  // non-touching neighbor adds nothing to ST_Difference / ST_Intersection
  // against a's boundary. See $lib/db/bbox for why bbox columns are
  // precomputed above rather than called inline in the JOIN.
  console.log("[EE-DEBUG] lines:2 neighbor union (layer_02_tmp2)");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE layer_02_tmp2 AS
    SELECT a.fid AS afid, ST_Union_Agg(b.geom) AS neighbor_union
    FROM layer_02_tmp1 AS a
    JOIN layer_02_tmp1 AS b
      ON a.fid != b.fid
     AND ${bboxOverlapSql("a", "b")}
    GROUP BY a.fid
  `);

  console.log("[EE-DEBUG] lines:3 difference+linemerge (layer_02a)");
  const batches = await vertexBatches(
    conn,
    `--sql
    SELECT a.rowid AS rid, ST_NPoints(a.geom) + coalesce(ST_NPoints(n.neighbor_union), 0) AS n
    FROM layer_02_tmp1 AS a
    LEFT JOIN layer_02_tmp2 AS n ON a.fid = n.afid
    ORDER BY a.rowid
  `,
    budget,
  );
  for (const [i, [lo, hi]] of batches.entries()) {
    await conn.query(`--sql
      ${i === 0 ? "CREATE OR REPLACE TABLE layer_02a AS" : "INSERT INTO layer_02a"}
      SELECT
        a.fid,
        UNNEST(ST_Dump(ST_LineMerge(ST_CollectionExtract(
          CASE WHEN n.neighbor_union IS NOT NULL
               THEN ST_Difference(a.geom, n.neighbor_union)
               ELSE a.geom
          END, 2
        )))).geom AS geom
      FROM (SELECT * FROM layer_02_tmp1 WHERE rowid BETWEEN ${lo} AND ${hi}) AS a
      LEFT JOIN (
        SELECT * FROM layer_02_tmp2 WHERE afid IN (
          SELECT fid FROM layer_02_tmp1 WHERE rowid BETWEEN ${lo} AND ${hi}
        )
      ) AS n ON a.fid = n.afid
    `);
  }
  console.log("[EE-DEBUG] lines:4 done, dropping tmp tables");

  await conn.query("DROP TABLE IF EXISTS layer_02_tmp1");
  await conn.query("DROP TABLE IF EXISTS layer_02_tmp2");
}
