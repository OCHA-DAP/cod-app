import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, subdivideSql } from "./bbox";
import { CLIP_PAIR_VERTEX_BUDGET, GEOMETRY_TYPE } from "./constants";

// Ported from topo-tools' core/clip/_tiles.py: adds `table` (tid, overlay_fid, geom,
// bbox) rows for every fid not tiled yet.
export async function buildTiles(
  conn: AsyncDuckDBConnection,
  overlaySource: string,
  fidsSql: string,
  table: string,
): Promise<void> {
  await conn.query(`--sql
    CREATE TABLE IF NOT EXISTS ${table} (
      tid BIGINT, overlay_fid BIGINT, geom ${GEOMETRY_TYPE}, xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE
    )
  `);
  const fids = (
    await conn.query(`--sql
      SELECT DISTINCT fid FROM (${fidsSql}) f(fid)
      WHERE fid NOT IN (SELECT DISTINCT overlay_fid FROM ${table}) ORDER BY 1
    `)
  )
    .toArray()
    .map((r) => Number((r as { fid: bigint | number }).fid));
  for (const g of fids) {
    await conn.query(`--sql
      INSERT INTO ${table} BY NAME
      SELECT (SELECT coalesce(max(tid), 0) FROM ${table}) + row_number() OVER () AS tid,
             ${g} AS overlay_fid, geom, ${bboxColumnsSql("geom")}
      FROM (SELECT UNNEST(${subdivideSql("geom")}) AS geom FROM ${overlaySource} WHERE fid = ${g})
    `);
  }
}

// Creates `out` (fid, tid, b): row/tile bbox pairs, batched by row vertex count.
export async function pairBatches(
  conn: AsyncDuckDBConnection,
  rows: string,
  tiles: string,
  out: string,
  overlayFid: number | null = null,
): Promise<void> {
  const where = overlayFid === null ? "TRUE" : `overlay_fid = ${overlayFid}`;
  const whereR = overlayFid === null ? "TRUE" : `r.overlay_fid = ${overlayFid}`;
  // Joining counts, never geometries, keeps one big row over many tiles in memory.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${out} AS
    SELECT p.fid, p.tid,
           floor(sum(n.np) OVER (ORDER BY p.fid, p.tid) / ${CLIP_PAIR_VERTEX_BUDGET})::BIGINT AS b
    FROM (
      SELECT r.fid, t.tid FROM ${rows} r JOIN ${tiles} t
        ON t.overlay_fid = r.overlay_fid
       AND t.xmax >= r.xmin AND t.xmin <= r.xmax AND t.ymax >= r.ymin AND t.ymin <= r.ymax
      WHERE ${whereR}
    ) p
    JOIN (SELECT fid, ST_NPoints(geom) AS np FROM ${rows} WHERE ${where}) n USING (fid)
  `);
}
