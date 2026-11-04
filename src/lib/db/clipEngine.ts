import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "./bbox";
import { pairBatches } from "./clipTiles";
import { mergeDetachedParts } from "./coverage";

export interface ClipEngineResult {
  outputCount: number;
  emptyCount: number; // rows dropped because their clip result was empty
}

const CLIP_TMP = ["cl_in", "cl_tiles", "cl_bat", "cl_po", "cl_result"];

// Ported from topo-tools' core/clip/_engine.py, in-process per overlay fid: clips each
// row to its fid's `tiles`; rows that clip to nothing go to `${tableOut}_dropped`.
export async function clipEngine(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tiles: string,
  tableOut: string,
): Promise<ClipEngineResult> {
  const x = (sql: string) => conn.query(sql);
  await x(`CREATE OR REPLACE TABLE ${tableOut} (fid BIGINT, geom GEOMETRY)`);
  await x(`CREATE OR REPLACE TABLE ${tableOut}_dropped (fid BIGINT, overlay_fid BIGINT, geom GEOMETRY)`);
  const fids = (await x(`SELECT DISTINCT overlay_fid FROM ${tableIn} ORDER BY 1`))
    .toArray()
    .map((r) => Number((r as { overlay_fid: bigint | number }).overlay_fid));

  for (const g of fids) {
    await x(`--sql
      CREATE OR REPLACE TABLE cl_in AS
      SELECT fid, overlay_fid, geom, ${bboxColumnsSql("geom")} FROM ${tableIn} WHERE overlay_fid = ${g}
    `);
    await x(`CREATE OR REPLACE TABLE cl_tiles AS SELECT * FROM ${tiles} WHERE overlay_fid = ${g}`);
    const nTiles = Number(
      ((await x("SELECT count(*) AS n FROM cl_tiles")).toArray()[0] as { n: bigint | number }).n,
    );
    if (nTiles === 0) throw new Error(`clip: no overlay geometry for overlay_fid=${g}`);
    await pairBatches(conn, "cl_in", "cl_tiles", "cl_bat");
    await x("CREATE OR REPLACE TABLE cl_po (fid BIGINT, geom GEOMETRY)");
    const batches = (await x("SELECT DISTINCT b FROM cl_bat ORDER BY 1"))
      .toArray()
      .map((r) => Number((r as { b: bigint | number }).b));
    for (const b of batches) {
      await x(`--sql
        INSERT INTO cl_po
        SELECT p.fid, ST_CollectionExtract(ST_Union_Agg(ST_Intersection(i.geom, t.geom)), 3)
        FROM cl_bat p JOIN cl_in i USING (fid) JOIN cl_tiles t USING (tid)
        WHERE p.b = ${b}
        GROUP BY p.fid
      `);
    }
    // A row split across batches is unioned once more; a row with no tile pair is dropped.
    await x(`--sql
      CREATE OR REPLACE TABLE cl_result AS
      SELECT c.fid, c.geom AS orig_geom, ST_Multi(ST_CollectionExtract(r.geom, 3)) AS geom
      FROM cl_in c
      LEFT JOIN (
        SELECT fid, CASE WHEN count(*) = 1 THEN any_value(geom) ELSE ST_Union_Agg(geom) END AS geom
        FROM cl_po GROUP BY fid
      ) r USING (fid)
    `);
    await x(`--sql
      INSERT INTO ${tableOut}
      SELECT fid, geom FROM cl_result WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) ORDER BY fid
    `);
    await x(`--sql
      INSERT INTO ${tableOut}_dropped
      SELECT fid, ${g}, orig_geom FROM cl_result WHERE geom IS NULL OR ST_IsEmpty(geom) ORDER BY fid
    `);
  }
  for (const t of CLIP_TMP) await x(`DROP TABLE IF EXISTS ${t}`);

  const count = async (t: string) =>
    Number(((await x(`SELECT count(*) AS n FROM ${t}`)).toArray()[0] as { n: bigint | number }).n);
  return { outputCount: await count(tableOut), emptyCount: await count(`${tableOut}_dropped`) };
}

// Clip and Mosaic's detached-piece pass over cl_clip (cl_assign's input
// features clipped to one overlay feature), writing cl_detached.
export async function mergeClipDetached(
  conn: AsyncDuckDBConnection,
  overlayFid: number,
  hasOriginal: boolean,
): Promise<{ merged: number; kept: number }> {
  const merged = await mergeDetachedParts(conn, "cl_clip", "cl_clip", {
    preClipSql:
      "SELECT c.fid, c.geom FROM input_layer_01 c JOIN cl_assign a ON a.input_fid = c.fid",
    overlaySql: `SELECT geom FROM overlay_layer_01 WHERE fid = ${overlayFid}`,
    overlayFid,
    originalTable: hasOriginal ? "original_layer_01" : null,
    issuesTable: "cl_detached",
  });
  const r = await conn.query("SELECT COUNT(*) AS n FROM cl_detached");
  return { merged, kept: Number((r.toArray()[0] as { n: bigint | number }).n) - merged };
}
