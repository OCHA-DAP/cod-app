import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql } from "./bbox";
import { CRS, GEOMETRY_TYPE, NODING_FALLBACK_GRID, SNAP_TOLERANCE } from "./constants";

// Drop intersection crumbs below SNAP_TOLERANCE², in deg² (matches topo-tools ADR-0030).
export const SLIVER = SNAP_TOLERANCE ** 2;

const AREA = (g: string) => `ST_Area(ST_Transform(${g}, '${CRS}', 'EPSG:8857', true))`;

async function withLooseMemoryLimit<T>(
  conn: AsyncDuckDBConnection,
  fn: () => Promise<T>,
): Promise<T> {
  // ST_Intersects/ST_Within in a JOIN ON triggers DuckDB's SPATIAL_JOIN, which
  // pre-reserves ~1x memory_limit; loosen it for the join and restore after.
  const prevMem = (
    (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0] as {
      v: string;
    }
  ).v;
  await conn.query("SET memory_limit = '999GB'");
  try {
    return await fn();
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }
}

const INTERSECTION = (a: string, b: string) =>
  `ST_MakeValid(ST_CollectionExtract(ST_Intersection(${a}, ${b}), 3))`;

// Per-pair rebuild of `outTable` after the set-based intersection throws: a pair
// that still throws is retried with `a` snapped onto `b`, then on the fallback grid.
async function intersectPairwise(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  outTable: string,
  pairPredicate: string,
): Promise<{ snapped: number; gridded: number }> {
  const candidates = (
    await conn.query(`--sql
      SELECT a.id AS a_id, b.id AS b_id FROM ${aTable} a JOIN ${bTable} b
        ON ${bboxOverlapSql("a", "b")} AND ${pairPredicate}
    `)
  ).toArray() as Array<{ a_id: bigint | number; b_id: bigint | number }>;
  await conn.query(`CREATE OR REPLACE TABLE ${outTable} (a_id BIGINT, b_id BIGINT, geom ${GEOMETRY_TYPE})`);
  let snapped = 0;
  let gridded = 0;
  for (const { a_id: aId, b_id: bId } of candidates) {
    const insert = (aGeom: string, bGeom = "b.geom") => `--sql
      INSERT INTO ${outTable}
      SELECT a.id, b.id, ${INTERSECTION(aGeom, bGeom)}
      FROM ${aTable} a, ${bTable} b WHERE a.id = ${aId} AND b.id = ${bId}
    `;
    try {
      await conn.query(insert("a.geom"));
    } catch {
      try {
        await conn.query(insert(`ST_Snap(a.geom, b.geom, ${SNAP_TOLERANCE})`));
        snapped++;
      } catch {
        const grid = (g: string) => `ST_ReducePrecision(${g}, ${NODING_FALLBACK_GRID})`;
        await conn.query(insert(grid("a.geom"), grid("b.geom")));
        gridded++;
      }
    }
  }
  return { snapped, gridded };
}

// Writes `outTable` (a_id, b_id, geom), the polygonal intersection of every pair
// matching `pairPredicate`; both tables need unique `id`, `geom` and bbox columns.
export async function intersectPairs(
  conn: AsyncDuckDBConnection,
  label: string,
  aTable: string,
  bTable: string,
  outTable: string,
  pairPredicate = "ST_Intersects(a.geom, b.geom)",
): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS ${outTable}`);
  await withLooseMemoryLimit(conn, async () => {
    try {
      await conn.query(`--sql
        CREATE TABLE ${outTable} AS
        SELECT a.id AS a_id, b.id AS b_id, ${INTERSECTION("a.geom", "b.geom")} AS geom
        FROM ${aTable} a JOIN ${bTable} b
          ON ${bboxOverlapSql("a", "b")}
         AND ${pairPredicate}
      `);
    } catch {
      // WASM GEOS throws "non-noded intersection" on some near-coincident edges.
      const { snapped, gridded } = await intersectPairwise(
        conn,
        aTable,
        bTable,
        outTable,
        pairPredicate,
      );
      console.warn(
        `${label}: ${snapped} pair(s) intersected after snapping, ${gridded} on the ${NODING_FALLBACK_GRID} grid`,
      );
    }
  });
}

// Computes, for every intersecting (a_fid, b_fid) pair, the shared area
// (equal-area EPSG:8857) plus each side's coverage fraction and IoU. Writes
// `pairsTable`.
export async function computeOverlapPairs(
  conn: AsyncDuckDBConnection,
  aTable: string,
  bTable: string,
  pairsTable: string,
): Promise<void> {
  const overlapTable = `${pairsTable}_overlap`;
  const aBbox = `${pairsTable}_a_bbox`;
  const bBbox = `${pairsTable}_b_bbox`;
  const aAreas = `${pairsTable}_a_areas`;
  const bAreas = `${pairsTable}_b_areas`;
  const pairAreas = `${pairsTable}_pair_areas`;

  // Bbox-prefiltered (not a plain ST_Intersects self-join) so a heavy parent
  // table doesn't choke DuckDB's SPATIAL_JOIN plan; see $lib/db/bbox.
  await conn.query(
    `CREATE OR REPLACE TABLE ${aBbox} AS SELECT fid AS id, geom, ${bboxColumnsSql()} FROM ${aTable}`,
  );
  await conn.query(
    `CREATE OR REPLACE TABLE ${bBbox} AS SELECT fid AS id, geom, ${bboxColumnsSql()} FROM ${bTable}`,
  );

  await intersectPairs(conn, "computeOverlapPairs", aBbox, bBbox, overlapTable);
  await conn.query(
    `DELETE FROM ${overlapTable} WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`,
  );
  await conn.query(`DROP TABLE IF EXISTS ${aBbox}`);
  await conn.query(`DROP TABLE IF EXISTS ${bBbox}`);

  for (const t of [aAreas, bAreas, pairAreas, pairsTable]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await conn.query(`CREATE TABLE ${aAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${aTable}`);
  await conn.query(`CREATE TABLE ${bAreas} AS SELECT fid, ${AREA("geom")} AS area FROM ${bTable}`);
  await conn.query(`--sql
    CREATE TABLE ${pairAreas} AS
    SELECT a_id AS a_fid, b_id AS b_fid, SUM(${AREA("geom")}) AS shared_area
    FROM ${overlapTable} GROUP BY a_id, b_id
  `);
  await conn.query(`--sql
    CREATE TABLE ${pairsTable} AS
    SELECT p.a_fid, p.b_fid, p.shared_area,
           p.shared_area / NULLIF(aa.area, 0)                           AS coverage_a,
           p.shared_area / NULLIF(ba.area, 0)                           AS coverage_b,
           p.shared_area / NULLIF(aa.area + ba.area - p.shared_area, 0) AS iou
    FROM ${pairAreas} p
    JOIN ${aAreas} aa ON aa.fid = p.a_fid
    JOIN ${bAreas} ba ON ba.fid = p.b_fid
  `);

  await conn.query(`DROP TABLE IF EXISTS ${overlapTable}`);
  await conn.query(`DROP TABLE IF EXISTS ${aAreas}`);
  await conn.query(`DROP TABLE IF EXISTS ${bAreas}`);
  await conn.query(`DROP TABLE IF EXISTS ${pairAreas}`);
}
