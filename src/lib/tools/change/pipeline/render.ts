import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { layerBounds } from "$lib/db/layerView";

// Whole units, not intersection slivers, since classification is per cluster
// not per pair. Tiles the area once: every B-side unit, plus A-side 'removed' units.

export async function stageRender(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cw_overlay_render");

  await conn.query(`--sql
    CREATE TABLE cw_overlay_render AS
    SELECT
      ST_Multi(k.geom) AS geom,
      pc.cluster_id AS cluster_id,
      pc.relationship_class AS relationship_class,
      'b' AS piece_side,
      NULL::INTEGER AS a_fid,
      k.fid AS b_fid
    FROM cw_b_keyed k
    JOIN cw_polygon_class pc ON pc.side = 'b' AND pc.fid = k.fid

    UNION ALL

    SELECT
      ST_Multi(k.geom) AS geom,
      pc.cluster_id AS cluster_id,
      pc.relationship_class AS relationship_class,
      'a' AS piece_side,
      k.fid AS a_fid,
      NULL::INTEGER AS b_fid
    FROM cw_a_keyed k
    JOIN cw_polygon_class pc ON pc.side = 'a' AND pc.fid = k.fid
    WHERE pc.relationship_class = 'removed'
  `);
}

// Serialize the overlay table to a GeoJSON FeatureCollection string.
export async function buildOverlayGeoJSON(conn: AsyncDuckDBConnection): Promise<string> {
  const rows = (
    await conn.query(`--sql
      SELECT
        ST_AsGeoJSON(geom) AS _geom,
        cluster_id,
        relationship_class,
        piece_side,
        a_fid,
        b_fid
      FROM cw_overlay_render
      WHERE geom IS NOT NULL
    `)
  ).toArray() as Array<Record<string, unknown>>;

  const features = rows.map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom as string),
    properties: {
      cluster_id: r.cluster_id == null ? null : Number(r.cluster_id),
      relationship_class: r.relationship_class,
      piece_side: r.piece_side,
      a_fid: r.a_fid == null ? null : Number(r.a_fid),
      b_fid: r.b_fid == null ? null : Number(r.b_fid),
    },
  }));

  return JSON.stringify({ type: "FeatureCollection", features }, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
}

// Serialize one side's keyed layer for the outline overlay; carries cluster_id
// so clicking the outline still resolves to the right cluster selection.
export async function buildOutlineGeoJSON(
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
): Promise<string> {
  const rows = (
    await conn.query(`--sql
      SELECT
        ST_AsGeoJSON(k.geom) AS _geom,
        k.fid AS fid,
        pc.cluster_id AS cluster_id,
        pc.relationship_class AS relationship_class
      FROM cw_${side}_keyed k
      LEFT JOIN cw_polygon_class pc ON pc.side = '${side}' AND pc.fid = k.fid
      WHERE k.geom IS NOT NULL
    `)
  ).toArray() as Array<Record<string, unknown>>;

  const features = rows.map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom as string),
    properties: {
      fid: r.fid == null ? null : Number(r.fid),
      cluster_id: r.cluster_id == null ? null : Number(r.cluster_id),
      relationship_class: r.relationship_class,
      side,
    },
  }));

  return JSON.stringify({ type: "FeatureCollection", features }, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
}

export async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  return layerBounds(conn, "cw_overlay_render").catch(() => null);
}
