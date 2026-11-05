import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql } from "./bbox";
import {
  NODING_FALLBACK_GRID,
  NOTCH_MAX_GAP_RATIO,
  NOTCH_MIN_SCORE,
  NOTCH_SPACING,
  NOTCH_WINDOW_MARGIN,
} from "./constants";

// Ported from topo-tools' core/coverage.py (detect_notches, close_notches).
// A notch is two units' unshared edges running within NOTCH_SPACING / 8 of each other.

// Two edges this close count as touching, not as a notch.
const NOTCH_TOUCH = 1e-9;
const NOTCH_TMP = [
  "_notch_all",
  "_notch_ext",
  "_notch_near",
  "_notch_ends",
  "_notch_moves",
  "_notch_runs",
  "_notch_fseg",
];
const NOTCH_FIX_TMP = [
  "_notch_flags",
  "_notch_pairs",
  "_notch_w",
  "_notch_one",
  "_notch_holes",
  ...["a", "b"].flatMap((s) =>
    ["parts", "rings", "v", "seg", "near", "moved", "out"].map((t) => `_notch_${s}_${t}`),
  ),
];

async function dropTables(conn: AsyncDuckDBConnection, tables: string[]): Promise<void> {
  for (const t of tables) await conn.query(`DROP TABLE IF EXISTS ${t}`);
}

// Builds _notch_runs(ua, ub, blob, score) over table's rowids.
async function buildNotchRuns(conn: AsyncDuckDBConnection, table: string): Promise<void> {
  const s = NOTCH_SPACING;
  const r = s / 8;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_all AS
    SELECT rowid AS rnid, fid, geom FROM ${table}
  `);
  // Unshared segments only: a segment whose endpoints another unit also has is shared.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_ext AS
    WITH rings AS (
      SELECT rnid, UNNEST(ST_Dump(ST_Boundary(geom))).geom AS g FROM _notch_all
    ),
    pts AS (
      SELECT rnid,
             list_transform(ST_Dump(ST_Points(g)), lambda x: [ST_X(x.geom), ST_Y(x.geom)]) AS xy
      FROM rings
    ),
    segs AS (
      SELECT rnid, e, least(e[1], e[2]) AS k1, greatest(e[1], e[2]) AS k2
      FROM (
        SELECT rnid, UNNEST(list_transform(range(1, len(xy)), lambda i: [xy[i], xy[i + 1]])) AS e
        FROM pts
      )
    ),
    shared AS (
      SELECT k1, k2 FROM segs GROUP BY k1, k2 HAVING count(DISTINCT rnid) > 1
    ),
    ext AS (
      SELECT row_number() OVER () AS sid, rnid,
             ST_MakeLine(ST_Point(e[1][1], e[1][2]), ST_Point(e[2][1], e[2][2])) AS geom
      FROM segs ANTI JOIN shared USING (k1, k2)
    )
    SELECT *, ${bboxColumnsSql("geom")} FROM ext
  `);
  // Per segment, its length within r of the other unit minus the length touching it, as merged
  // intervals of one-segment buffers: WASM GEOS can't buffer near-collinear multi-segment lines.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_near AS
    WITH sp AS (
      SELECT a.sid, a.rnid AS own, b.rnid AS other, b.sid AS osid, a.geom AS ag, b.geom AS bg
      FROM _notch_ext a JOIN _notch_ext b
        ON a.rnid <> b.rnid
       AND b.xmin <= a.xmax + ${r} AND b.xmax >= a.xmin - ${r}
       AND b.ymin <= a.ymax + ${r} AND b.ymax >= a.ymin - ${r}
       AND ST_DWithin(a.geom, b.geom, ${r})
    ),
    cut AS (
      SELECT sid, own, other, ag, near, ST_Intersection(ag, ST_Buffer(bg, rad, 2)) AS p
      FROM sp, (VALUES (TRUE, ${r}), (FALSE, ${NOTCH_TOUCH})) v(near, rad)
    ),
    iv AS (
      SELECT sid, own, other, ag, near, least(f0, f1) AS f0, greatest(f0, f1) AS f1
      FROM (
        SELECT *, ST_LineLocatePoint(ag, ST_StartPoint(p)) AS f0,
               ST_LineLocatePoint(ag, ST_EndPoint(p)) AS f1
        FROM cut WHERE ST_GeometryType(p) = 'LINESTRING'
      )
    ),
    starts AS (
      SELECT *, coalesce(f0 > max(f1) OVER (
               PARTITION BY sid, other, near ORDER BY f0, f1
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), TRUE)::INT AS new
      FROM iv
    ),
    merged AS (
      SELECT sid, own, other, near, any_value(ag) AS ag, min(f0) AS f0, max(f1) AS f1
      FROM (SELECT *, sum(new) OVER (PARTITION BY sid, other, near ORDER BY f0, f1) AS isl
            FROM starts)
      GROUP BY sid, own, other, near, isl
    )
    SELECT m.sid, m.own, m.other, any_value(o.osids) AS osids,
           least(m.own, m.other) AS ua, greatest(m.own, m.other) AS ub,
           ST_Collect(list(ST_LineSubstring(m.ag, m.f0, m.f1)) FILTER (WHERE m.near)) AS piece,
           ST_Length(any_value(m.ag))
             * (sum(m.f1 - m.f0) FILTER (WHERE m.near)
                - coalesce(sum(m.f1 - m.f0) FILTER (WHERE NOT m.near), 0)) AS len
    FROM merged m
    JOIN (SELECT sid, other, list(DISTINCT osid) AS osids FROM sp GROUP BY sid, other) o
      USING (sid, other)
    GROUP BY m.sid, m.own, m.other
    HAVING count(*) FILTER (WHERE m.near) > 0
  `);
  // closeNotches moves an endpoint touching no third unit onto the other unit
  // when it lies within NOTCH_MAX_GAP_RATIO of its longest flagged segment.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_ends AS
    SELECT n.sid, n.own, n.other, ST_Length(e.geom) AS seglen,
           UNNEST([ST_StartPoint(e.geom), ST_EndPoint(e.geom)]) AS p
    FROM _notch_near n JOIN _notch_ext e USING (sid)
    WHERE n.len > 1e-12
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_moves AS
    WITH v AS (
      SELECT own, other, x, y, any_value(p) AS p, max(seglen) * ${NOTCH_MAX_GAP_RATIO} AS lim
      FROM (SELECT *, ST_X(p) AS x, ST_Y(p) AS y FROM _notch_ends)
      GROUP BY own, other, x, y
    ),
    vd AS (
      SELECT v.own, v.other, v.x, v.y,
             coalesce(min(ST_Distance(v.p, s.geom)) FILTER (WHERE s.rnid = v.other), 'inf'::DOUBLE)
               BETWEEN ${NOTCH_TOUCH} AND v.lim
             AND NOT coalesce(bool_or(s.rnid <> v.other AND ST_DWithin(v.p, s.geom, ${NOTCH_TOUCH})),
                              FALSE) AS moves
      FROM v JOIN _notch_ext s
        ON s.rnid <> v.own
       AND s.xmin <= v.x + v.lim AND s.xmax >= v.x - v.lim
       AND s.ymin <= v.y + v.lim AND s.ymax >= v.y - v.lim
      GROUP BY v.own, v.other, v.x, v.y, v.lim
    )
    SELECT e.sid, e.other, bool_or(coalesce(vd.moves, FALSE)) AS moves
    FROM _notch_ends e LEFT JOIN vd
      ON vd.own = e.own AND vd.other = e.other AND vd.x = ST_X(e.p) AND vd.y = ST_Y(e.p)
    GROUP BY e.sid, e.other
  `);
  // Gridded first: WASM GEOS hits non-noded intersections unioning the raw buffers.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_runs AS
    WITH k AS (SELECT sid, other FROM _notch_moves WHERE moves),
    moved AS (
      SELECT n.sid, n.other FROM _notch_near n SEMI JOIN k USING (sid, other)
      UNION
      SELECT n.sid, n.other
      FROM (SELECT sid, own, other, UNNEST(osids) AS osid FROM _notch_near) n
      JOIN k ON k.sid = n.osid AND k.other = n.own
    ),
    h AS (
      SELECT n.*, m.sid IS NOT NULL AS moved FROM _notch_near n
      LEFT JOIN moved m USING (sid, other)
      WHERE len > 1e-12
    ),
    b AS (
      SELECT row_number() OVER () AS bid, ua, ub, blob FROM (
        SELECT ua, ub,
               UNNEST(ST_Dump(ST_Union_Agg(
                 ST_ReducePrecision(ST_Buffer(piece, ${s * 1.5}, 2), ${NODING_FALLBACK_GRID})
               ))).geom AS blob
        FROM h GROUP BY ua, ub
      )
    )
    SELECT b.ua, b.ub, any_value(b.blob) AS blob, sum(h.len) / ${s} AS score
    FROM h JOIN b ON h.ua = b.ua AND h.ub = b.ub AND ST_Intersects(h.piece, b.blob)
    GROUP BY b.bid, b.ua, b.ub
    -- A run is a notch only if closeNotches moves an end of one of its segments.
    HAVING sum(h.len) / ${s} >= ${NOTCH_MIN_SCORE} AND bool_or(h.moved)
  `);
}

// Writes outTable(n, unit_a, unit_b, score, geom) per notch; returns the count.
export async function detectNotches(
  conn: AsyncDuckDBConnection,
  table: string,
  outTable: string,
): Promise<number> {
  await buildNotchRuns(conn, table);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${outTable} AS
    SELECT row_number() OVER (ORDER BY a.fid, b.fid, hash(r.blob)) AS n,
           a.fid AS unit_a, b.fid AS unit_b, r.score, r.blob AS geom
    FROM _notch_runs r
    JOIN _notch_all a ON a.rnid = r.ua JOIN _notch_all b ON b.rnid = r.ub
  `);
  await dropTables(conn, NOTCH_TMP);
  const res = await conn.query(`SELECT count(*) AS n FROM ${outTable}`);
  return Number((res.toArray()[0] as { n: bigint | number }).n);
}

// Rebuilds window part src, moving its flagged endpoints exactly onto line.
function projectNotchSideSql(
  side: string,
  src: string,
  line: string,
  lim: number,
  [ua, ub]: [number, number],
  own: number,
): string[] {
  const p = `_notch_${side}`;
  return [
    `CREATE OR REPLACE TABLE ${p}_parts AS SELECT row_number() OVER () AS pid, g
     FROM (SELECT UNNEST(ST_Dump(${src})).geom AS g FROM _notch_w)`,
    `CREATE OR REPLACE TABLE ${p}_rings AS
     SELECT pid, 0 AS rn, ST_ExteriorRing(g) AS r FROM ${p}_parts
     UNION ALL
     SELECT pid, i, ST_InteriorRingN(g, i::INTEGER) FROM ${p}_parts,
            generate_series(1, ST_NumInteriorRings(g)) t(i)`,
    // Closing vertex dropped; each ring is re-closed from its moved first vertex.
    `CREATE OR REPLACE TABLE ${p}_v AS
     SELECT row_number() OVER () AS vid, pid, rn, d.path[1] AS k, d.geom AS g
     FROM (SELECT pid, rn, ST_NPoints(r) AS np, UNNEST(ST_Dump(ST_Points(r))) AS d
           FROM ${p}_rings)
     WHERE d.path[1] < np`,
    `CREATE OR REPLACE TABLE ${p}_seg AS
     SELECT ST_MakeLine(xs[i], xs[i + 1]) AS s
     FROM (SELECT list_transform(ST_Dump(ST_Points(l)), lambda x: x.geom) AS xs
           FROM (SELECT UNNEST(ST_Dump(${line})).geom AS l FROM _notch_w)),
          generate_series(1, len(xs) - 1) t(i)`,
    `CREATE OR REPLACE TABLE ${p}_near AS
     SELECT v.vid, ST_ClosestPoint(s.s, v.g) AS cp, ST_Distance(v.g, s.s) AS dd
     FROM ${p}_v v JOIN ${p}_seg s ON ST_DWithin(v.g, s.s, ${lim})
     QUALIFY row_number() OVER (PARTITION BY v.vid ORDER BY ST_Distance(v.g, s.s)) = 1`,
    `CREATE OR REPLACE TABLE ${p}_moved AS
     SELECT v.pid, v.rn, v.k,
            CASE WHEN ST_Distance(v.g, ST_Boundary(w.win)) <= ${NOTCH_TOUCH}
                   OR ST_DWithin(v.g, w.others, ${NOTCH_TOUCH}) THEN v.g
                 WHEN n.dd > ${NOTCH_TOUCH} AND n.dd <= f.seglen * ${NOTCH_MAX_GAP_RATIO}
                 THEN n.cp ELSE v.g END AS g
     FROM ${p}_v v
     LEFT JOIN ${p}_near n USING (vid)
     LEFT JOIN _notch_flags f
       ON f.ua = ${ua} AND f.ub = ${ub} AND f.own = ${own}
      AND f.x = ST_X(v.g) AND f.y = ST_Y(v.g),
     _notch_w w`,
    `CREATE OR REPLACE TABLE ${p}_out AS
     SELECT ST_MakeValid(ST_Union_Agg(ST_MakePolygon(shell, holes))) AS g FROM (
       SELECT pid, any_value(line) FILTER (WHERE rn = 0) AS shell,
              COALESCE(list(line ORDER BY rn) FILTER (WHERE rn > 0), []) AS holes
       FROM (
         SELECT pid, rn, ST_MakeLine(list_append(l, l[1])) AS line
         FROM (SELECT pid, rn, list(g ORDER BY k) AS l FROM ${p}_moved GROUP BY pid, rn)
       )
       GROUP BY pid
     )`,
  ];
}

// Merges holes the fix enclosed between ua and ub into the unit with more border.
async function fillEnclosedNotchGaps(
  conn: AsyncDuckDBConnection,
  ua: number,
  ub: number,
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_holes AS
    WITH nbr AS (
      SELECT coalesce(ST_Union_Agg(x.geom), 'POLYGON EMPTY'::GEOMETRY) AS g
      FROM _notch_all x, _notch_w w
      WHERE x.rnid NOT IN (${ua}, ${ub}) AND ST_Intersects(x.geom, w.win)
    ),
    u AS (
      SELECT FALSE AS before, ST_Union(ST_Union(na, nb), nbr.g) AS g FROM _notch_one, nbr
      UNION ALL
      SELECT TRUE, ST_Union(ST_Union(a.geom, b.geom), nbr.g)
      FROM _notch_all a, _notch_all b, nbr WHERE a.rnid = ${ua} AND b.rnid = ${ub}
    ),
    parts AS (SELECT before, UNNEST(ST_Dump(g)).geom AS p FROM u),
    holes AS (
      SELECT before,
             UNNEST(ST_Dump(ST_Difference(ST_MakePolygon(ST_ExteriorRing(p)), p))).geom AS h
      FROM parts
    )
    SELECT h FROM holes n
    WHERE NOT n.before AND NOT ST_IsEmpty(n.h)
      AND NOT EXISTS (
        SELECT 1 FROM holes o WHERE o.before AND ST_Intersects(o.h, ST_PointOnSurface(n.h))
      )
  `);
  await conn.query(`--sql
    DELETE FROM _notch_holes n WHERE EXISTS (
      SELECT 1 FROM _notch_all x
      WHERE x.rnid NOT IN (${ua}, ${ub}) AND ST_Intersects(x.geom, n.h)
        AND ST_Area(ST_Intersection(x.geom, n.h)) > 0
    )
  `);
  await conn.query(`--sql
    UPDATE _notch_one o SET
      na = ST_CollectionExtract(ST_MakeValid(ST_Union(o.na, f.ga)), 3),
      nb = ST_CollectionExtract(ST_MakeValid(ST_Union(o.nb, f.gb)), 3)
    FROM (
      SELECT coalesce(ST_Union_Agg(h) FILTER (WHERE to_a), 'POLYGON EMPTY') AS ga,
             coalesce(ST_Union_Agg(h) FILTER (WHERE NOT to_a), 'POLYGON EMPTY') AS gb
      FROM (
        SELECT h,
               ST_Length(ST_Intersection(ST_Boundary(h), ST_Boundary(na)))
               >= ST_Length(ST_Intersection(ST_Boundary(h), ST_Boundary(nb))) AS to_a
        FROM _notch_holes, _notch_one
      )
    ) f
  `);
}

// Closes table's notches in place by moving flagged endpoints onto the other unit
// inside a per-pair window; returns the number of unit pairs touched.
export async function closeNotches(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  await buildNotchRuns(conn, table);
  const pairs = (
    (await conn.query("SELECT DISTINCT ua, ub FROM _notch_runs")).toArray() as Array<{
      ua: bigint | number;
      ub: bigint | number;
    }>
  ).map((r) => [Number(r.ua), Number(r.ub)] as [number, number]);
  if (pairs.length === 0) {
    await dropTables(conn, NOTCH_TMP);
    return 0;
  }
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_fseg AS
    SELECT DISTINCT n.ua, n.ub, n.own, e.sid, e.geom, ST_Length(e.geom) AS seglen
    FROM _notch_near n
    JOIN _notch_ext e USING (sid)
    JOIN _notch_runs r ON r.ua = n.ua AND r.ub = n.ub AND ST_Intersects(n.piece, r.blob)
    WHERE n.len > 1e-12
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_flags AS
    SELECT ua, ub, own, ST_X(p) AS x, ST_Y(p) AS y, max(seglen) AS seglen
    FROM (
      SELECT ua, ub, own, seglen, ST_StartPoint(geom) AS p FROM _notch_fseg
      UNION ALL
      SELECT ua, ub, own, seglen, ST_EndPoint(geom) FROM _notch_fseg
    )
    GROUP BY ALL
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE _notch_pairs AS
    SELECT ua, ub,
           ST_Expand(ST_Extent(ST_Collect(list(g))), ${NOTCH_WINDOW_MARGIN})::GEOMETRY AS win,
           max(seglen) * ${NOTCH_MAX_GAP_RATIO} AS lim
    FROM (
      SELECT ua, ub, blob AS g, 0 AS seglen FROM _notch_runs
      UNION ALL
      SELECT ua, ub, geom, seglen FROM _notch_fseg
    )
    GROUP BY ua, ub
  `);
  for (const [ua, ub] of pairs) {
    const limRes = await conn.query(`SELECT lim FROM _notch_pairs WHERE ua = ${ua} AND ub = ${ub}`);
    const lim = Number((limRes.toArray()[0] as { lim: number }).lim);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE _notch_w AS
      SELECT p.win, ST_Intersection(ST_Boundary(b.geom), p.win) AS tb,
             NULL::GEOMETRY AS ta,
             ST_Intersection(a.geom, p.win) AS ai,
             ST_Difference(a.geom, p.win) AS ao,
             ST_Intersection(b.geom, p.win) AS bi,
             ST_Difference(b.geom, p.win) AS bo,
             (SELECT ST_Union_Agg(ST_Boundary(x.geom)) FROM _notch_all x
              WHERE x.rnid NOT IN (${ua}, ${ub}) AND ST_Intersects(x.geom, p.win)) AS others
      FROM _notch_pairs p
      JOIN _notch_all a ON a.rnid = p.ua JOIN _notch_all b ON b.rnid = p.ub
      WHERE p.ua = ${ua} AND p.ub = ${ub}
    `);
    for (const q of projectNotchSideSql("a", "ai", "tb", lim, [ua, ub], ua)) await conn.query(q);
    await conn.query(`--sql
      UPDATE _notch_w
      SET ta = ST_Intersection(ST_Boundary((SELECT g FROM _notch_a_out)), win)
    `);
    for (const q of projectNotchSideSql("b", "bi", "ta", lim, [ua, ub], ub)) await conn.query(q);
    // Each side's vertices go into the other's segments, so closed edges are shared.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE _notch_one AS
      WITH n AS (
        SELECT ST_MakeValid(ST_Snap(b.g, a.g, ${NOTCH_TOUCH})) AS nb, a.g AS fa
        FROM _notch_a_out a, _notch_b_out b
      )
      SELECT ST_CollectionExtract(ST_MakeValid(ST_Union(
               w.ao, ST_MakeValid(ST_Snap(n.fa, n.nb, ${NOTCH_TOUCH}))
             )), 3) AS na,
             ST_CollectionExtract(ST_MakeValid(ST_Union(w.bo, n.nb)), 3) AS nb
      FROM _notch_w w, n
    `);
    await fillEnclosedNotchGaps(conn, ua, ub);
    for (const [rnid, col] of [
      [ua, "na"],
      [ub, "nb"],
    ] as const) {
      await conn.query(`--sql
        UPDATE _notch_all SET geom = (SELECT ${col} FROM _notch_one) WHERE rnid = ${rnid}
      `);
    }
  }
  await conn.query(`--sql
    UPDATE ${table} t SET geom = a.geom FROM _notch_all a
    WHERE t.rowid = a.rnid
      AND a.rnid IN (SELECT ua FROM _notch_pairs UNION SELECT ub FROM _notch_pairs)
  `);
  await dropTables(conn, [...NOTCH_TMP, ...NOTCH_FIX_TMP]);
  return pairs.length;
}

// closeNotches, but a failure warns and leaves table untouched (its only write is the last UPDATE).
export async function tryCloseNotches(conn: AsyncDuckDBConnection, table: string): Promise<void> {
  try {
    await closeNotches(conn, table);
  } catch (e) {
    console.warn(`notch closing failed on ${table}, leaving as-is:`, e);
    await dropTables(conn, [...NOTCH_TMP, ...NOTCH_FIX_TMP]);
  }
}
