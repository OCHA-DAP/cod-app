import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { ROW_ORDER_COLUMN } from "./export";

export type Bounds = [number, number, number, number];

// Combined extent of one or more geometry tables, or null when they have none.
export async function layerBounds(
  conn: AsyncDuckDBConnection,
  tables: string | string[] = "layer_01",
): Promise<Bounds | null> {
  const from = [tables].flat().map((t) => `SELECT geom FROM ${t}`).join(" UNION ALL ");
  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM (${from}) WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  const b: Bounds = [xmin, ymin, xmax, ymax];
  return b.every((v) => Number.isFinite(v)) ? b : null;
}

// Attributes of the first feature containing a point, as strings.
export async function attributesAt(
  conn: AsyncDuckDBConnection,
  [lng, lat]: [number, number],
  geomTable = "layer_01",
  attrTable = "layer_attr",
): Promise<Record<string, string | null> | null> {
  const r = await conn.query(`--sql
    SELECT a.* EXCLUDE (fid) FROM ${geomTable} g JOIN ${attrTable} a USING (fid)
    WHERE ST_Intersects(g.geom, ST_Point(${lng}, ${lat}))
    ORDER BY fid LIMIT 1
  `);
  const row = r.toArray()[0]?.toJSON() as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k]) => k !== ROW_ORDER_COLUMN)
      .map(([k, v]) => [k, v == null ? null : String(v)]),
  );
}
