import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "./bbox";
import { CLIP_PAIR_VERTEX_BUDGET, GEOMETRY_TYPE, SNAP_TOLERANCE } from "./constants";
import { nearPartPairs } from "./gridPairs";

export const INVALID_EDGE_REASON = "edges overlap or do not match the neighbouring polygon";

// Ported from topo-tools' _invalid_part_pairs without its per-batch time limit (WASM can't
// interrupt a query): creates _ie_edges (pid, near_pid, geom) from the _ie_parts pairs `on`.
async function invalidPartPairs(conn: AsyncDuckDBConnection, on: string, first = false): Promise<void> {
  const x = (sql: string) => conn.query(sql);
  await nearPartPairs(conn, "_ie_parts", "_ie_parts", "_ie_near", { on });
  await x(`--sql
    CREATE OR REPLACE TABLE _ie_batch AS
    SELECT pid, near_pid, (sum(a.n + b.n) OVER (ORDER BY pid, near_pid) // ${CLIP_PAIR_VERTEX_BUDGET}) AS batch
    FROM _ie_near
    JOIN (SELECT pid, n FROM _ie_parts) a USING (pid)
    JOIN (SELECT pid AS near_pid, n FROM _ie_parts) b USING (near_pid)
  `);
  await x(`CREATE OR REPLACE TABLE _ie_edges (pid BIGINT, near_pid BIGINT, geom ${GEOMETRY_TYPE})`);
  const batches = (await x("SELECT DISTINCT batch FROM _ie_batch ORDER BY 1"))
    .toArray()
    .map((r) => Number((r as { batch: bigint | number }).batch));
  for (const batch of batches) {
    await x(`--sql
      INSERT INTO _ie_edges
      WITH g AS (
        SELECT p.pid, p.near_pid, x.geom FROM _ie_batch p
        JOIN _ie_parts x ON x.pid = p.pid WHERE p.batch = ${batch}
        UNION ALL
        SELECT p.pid, p.near_pid, x.geom FROM _ie_batch p
        JOIN _ie_parts x ON x.pid = p.near_pid WHERE p.batch = ${batch}
      )
      SELECT pid, near_pid, e FROM (
        SELECT pid, near_pid, ST_CoverageInvalidEdges_Agg(geom, ${SNAP_TOLERANCE}) AS e
        FROM g GROUP BY pid, near_pid
      )
      WHERE e IS NOT NULL AND ST_Length(e) > 0
    `);
  }
  // A pair alone flags edges its other neighbours match; recheck each flagged pair
  // with every part near either side, keeping only edges along both.
  const flagged = (await x("SELECT pid, near_pid FROM _ie_edges ORDER BY 1, 2")).toArray() as {
    pid: bigint | number;
    near_pid: bigint | number;
  }[];
  for (const { pid, near_pid } of flagged) {
    const [a, b] = [Number(pid), Number(near_pid)];
    await x(`--sql
      UPDATE _ie_edges SET geom = (
        WITH g AS (
          SELECT geom FROM _ie_parts WHERE pid IN (
            SELECT ${a} UNION SELECT ${b}
            UNION SELECT near_pid FROM _ie_near WHERE pid IN (${a}, ${b})
            UNION SELECT pid FROM _ie_near WHERE near_pid IN (${a}, ${b})
          )
        ),
        e AS (
          SELECT UNNEST(ST_Dump(ST_CoverageInvalidEdges_Agg(geom, ${SNAP_TOLERANCE}))).geom AS geom FROM g
        )
        SELECT CASE WHEN count(*) > 0 THEN ST_Collect(list(e.geom)) END
        FROM e
        WHERE ST_Length(e.geom) > 0 AND (
          SELECT bool_and(ST_DWithin(e.geom, x.geom, ${SNAP_TOLERANCE}))
          FROM _ie_parts x WHERE x.pid IN (${a}, ${b})
        )
      )
      WHERE pid = ${a} AND near_pid = ${b}
    `);
    if (first) {
      const hit = (await x(`SELECT geom IS NOT NULL AS hit FROM _ie_edges WHERE pid = ${a} AND near_pid = ${b}`))
        .toArray()[0] as { hit: boolean };
      if (hit.hit) break;
    }
  }
  await x("DELETE FROM _ie_edges WHERE geom IS NULL");
}

async function dropTmp(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of ["_ie_parts", "_ie_near", "_ie_batch", "_ie_edges"]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

// Ported from topo-tools' invalid_edge_issues: creates `out`, one 'invalid-edge'
// issue row per touching row pair of `table` (fid, geom) whose shared edges don't match.
export async function invalidEdgeIssues(
  conn: AsyncDuckDBConnection,
  table: string,
  out: string,
  where = "TRUE",
): Promise<number> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _ie_parts AS
    WITH r AS (SELECT row_number() OVER () AS rid, fid, geom FROM ${table} WHERE ${where}),
    d AS (SELECT rid, fid, UNNEST(ST_Dump(geom)).geom AS geom FROM r)
    SELECT row_number() OVER () AS pid, rid, fid, geom, ST_NPoints(geom) AS n, ${bboxColumnsSql("geom")}
    FROM d
  `);
  await invalidPartPairs(conn, "l.pid < r.pid AND l.rid != r.rid");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${out} AS
    WITH e AS (
      SELECT least(a.rid, b.rid) AS ra, greatest(a.rid, b.rid) AS rb,
             CASE WHEN a.rid < b.rid THEN a.fid ELSE b.fid END AS unit_a,
             CASE WHEN a.rid < b.rid THEN b.fid ELSE a.fid END AS unit_b,
             e.geom
      FROM _ie_edges e JOIN _ie_parts a ON a.pid = e.pid JOIN _ie_parts b ON b.pid = e.near_pid
    ),
    g AS (
      SELECT 'invalid-edge-' || ra || '-' || rb AS key, 'invalid-edge' AS kind,
             any_value(unit_a) AS unit_a, any_value(unit_b) AS unit_b, NULL::BIGINT AS overlay_fid,
             '${INVALID_EDGE_REASON}' AS reason,
             NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
             FALSE AS fixed,
             ST_Collect(flatten(list(list_transform(ST_Dump(geom), lambda d: d.geom)))) AS geom
      FROM e GROUP BY ra, rb ORDER BY ra, rb
    )
    SELECT *, ${bboxColumnsSql("geom")} FROM g
  `);
  await dropTmp(conn);
  const n = (await conn.query(`SELECT count(*) AS n FROM ${out}`)).toArray()[0] as { n: bigint | number };
  if (Number(n.n) > 0) console.warn(`${n.n} row pair(s) with invalid edges in ${table}`);
  return Number(n.n);
}

// Ported from topo-tools' has_invalid_edges: true at the first confirmed pair of
// `table`'s parts with overlapping or unmatched shared edges.
export async function hasInvalidEdges(conn: AsyncDuckDBConnection, table: string): Promise<boolean> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _ie_parts AS
    WITH d AS (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM ${table})
    SELECT row_number() OVER () AS pid, geom, ST_NPoints(geom) AS n, ${bboxColumnsSql("geom")} FROM d
  `);
  await invalidPartPairs(conn, "l.pid < r.pid", true);
  const r = (await conn.query("SELECT count(*) > 0 AS bad FROM _ie_edges")).toArray()[0] as { bad: boolean };
  await dropTmp(conn);
  return Boolean(r.bad);
}
