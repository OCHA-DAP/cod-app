import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, bboxOverlapSql, subdivideSql } from "./bbox";
import {
  DETACHED_MAX_ORIGINAL_SHARE,
  DETACHED_MERGE_MAX_RATIO,
  DETACHED_MIN_NECK_RATIO,
  NODING_FALLBACK_GRID,
  SNAP_TOLERANCE,
} from "./constants";
import { intersectPairs } from "./overlap";
import { degSqToM2, degToM } from "./units";

export async function emptyRegions(
  conn: AsyncDuckDBConnection,
  table: string,
  extra = "",
): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TABLE ${table} AS SELECT NULL::BIGINT AS n${extra}, NULL::GEOMETRY AS geom WHERE FALSE`,
  );
}

function gapHolesSql(targetTable: string, sourceTable: string, geomExpr: string): string {
  return `--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH
    union_cte AS (
      SELECT ST_Union_Agg(${geomExpr}) AS u
      FROM ${sourceTable} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    ),
    parts AS (
      SELECT (UNNEST(ST_Dump(u))).geom AS poly
      FROM union_cte WHERE u IS NOT NULL
    ),
    holes AS (
      SELECT UNNEST(ST_Dump(
        ST_Difference(ST_MakePolygon(ST_ExteriorRing(poly)), poly)
      )).geom AS geom
      FROM parts WHERE ST_NumInteriorRings(poly) > 0
    )
    SELECT row_number() OVER (ORDER BY hash(geom)) AS n, geom
    FROM holes
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `;
}

// Drops gap regions whose interior point lies outside every clip target: an
// overlay hole or another overlay feature's territory, not a gap to fill.
export async function dropGapsOutsideTargets(
  conn: AsyncDuckDBConnection,
  regionsTable: string,
  targetsSql: string,
): Promise<void> {
  await conn.query(`--sql
    DELETE FROM ${regionsTable} WHERE n NOT IN (
      WITH probes AS (
        SELECT n, ST_PointOnSurface(geom) AS p FROM ${regionsTable}
      ),
      pb AS (SELECT n, p, ${bboxColumnsSql("p")} FROM probes),
      t AS (SELECT geom, ${bboxColumnsSql("geom")} FROM (${targetsSql}))
      SELECT DISTINCT pb.n FROM pb JOIN t
        ON ${bboxOverlapSql("pb", "t")} AND ST_Intersects(t.geom, pb.p)
    )
  `);
}

// Gap regions = interior rings of the union of sourceTable's polygons, written
// to targetTable (n, geom). When the exact union throws, the union is retried
// on a fine grid and a hole whose interior point an input polygon covers is a
// grid artifact, dropped.
export async function buildGapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  try {
    await conn.query(gapHolesSql(targetTable, sourceTable, "geom"));
    return;
  } catch (e) {
    console.warn(`gap union failed; retrying on a ${NODING_FALLBACK_GRID} grid:`, e);
  }
  const holes = `${targetTable}_grid_holes`;
  const source = `${targetTable}_grid_source`;
  try {
    await conn.query(
      gapHolesSql(holes, sourceTable, `ST_ReducePrecision(geom, ${NODING_FALLBACK_GRID})`),
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${source} AS
      SELECT geom, ${bboxColumnsSql()} FROM ${sourceTable}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      WITH pts AS (
        SELECT n, geom, ST_PointOnSurface(geom) AS p FROM ${holes}
      ),
      probes AS (
        SELECT n, p, ST_X(p) AS xmin, ST_X(p) AS xmax, ST_Y(p) AS ymin, ST_Y(p) AS ymax
        FROM pts
      ),
      covered AS (
        SELECT DISTINCT h.n FROM probes h JOIN ${source} s
          ON ${bboxOverlapSql("h", "s")} AND ST_Intersects(s.geom, h.p)
      )
      SELECT row_number() OVER (ORDER BY n) AS n, geom
      FROM pts WHERE n NOT IN (SELECT n FROM covered)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${holes}`);
    await conn.query(`DROP TABLE IF EXISTS ${source}`);
  }
}

// True if sourceTable's coverage has an interior hole at or below maxWidth
// (degrees) — mirrors topo-tools' has_gaps(gap_maximum_width=...).
// sourceTable is expected to already have been cleaned with a matching
// gap-fill width, so a hole this small surviving means the fill silently
// failed; a wider hole may be a legitimate feature (see docs/adr/0028) and
// isn't flagged by this check.
export async function hasNoiseFloorGap(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  maxWidth: number = SNAP_TOLERANCE,
): Promise<boolean> {
  const scratch = `${sourceTable}_noise_gap_check`;
  try {
    await buildGapTable(conn, scratch, sourceTable);
    const r = await conn.query(`--sql
      SELECT EXISTS (
        SELECT 1 FROM ${scratch}
        WHERE (ST_MaximumInscribedCircle(geom)).radius * 2 <= ${maxWidth}
      ) AS bad
    `);
    return Boolean(r.toArray()[0].bad);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${scratch}`);
  }
}

export const MICRO_MERGED_REASON = "merged into neighbouring polygon";
export const MICRO_DROPPED_REASON = "dropped: touches no polygon";

// Ported from topo-tools' is_micro_sql: 2*area/perimeter bounds the
// inscribed-circle diameter from below, so CASE skips it for every wide part.
export function isMicroSql(geom: string, width: number = SNAP_TOLERANCE): string {
  return (
    `CASE WHEN ST_IsEmpty(${geom}) THEN FALSE ` +
    `WHEN 2 * ST_Area(${geom}) <= ${width} * ST_Perimeter(${geom}) ` +
    `THEN (ST_MaximumInscribedCircle(${geom})).radius * 2 <= ${width} ` +
    "ELSE FALSE END"
  );
}

// Ported from topo-tools' check_no_overlaps: throws if rows of two `groupColumn`
// values overlap past minWidth.
export async function checkNoOverlaps(
  conn: AsyncDuckDBConnection,
  table: string,
  { groupColumn = "fid", minWidth = SNAP_TOLERANCE }: { groupColumn?: string; minWidth?: number } = {},
): Promise<void> {
  const tmp = `${table}_tmp1`;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${tmp} AS
    SELECT g, geom, ${bboxColumnsSql("geom")} FROM (
      SELECT "${groupColumn}" AS g, UNNEST(${subdivideSql("geom")}) AS geom FROM ${table}
    )
  `);
  try {
    const rows = (
      await conn.query(`--sql
        WITH pairs AS (
          SELECT a.g AS g_a, b.g AS g_b,
                 ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3) AS geom
          FROM ${tmp} a JOIN ${tmp} b
            ON a.g < b.g AND a.xmin <= b.xmax AND a.xmax >= b.xmin
           AND a.ymin <= b.ymax AND a.ymax >= b.ymin
          WHERE ST_Intersects(a.geom, b.geom) AND NOT ST_Touches(a.geom, b.geom)
        ), parts AS (
          SELECT g_a, g_b, UNNEST(ST_Dump(geom)).geom AS geom FROM pairs
        )
        SELECT g_a, g_b, sum(ST_Area(geom)) AS area FROM parts
        WHERE NOT ST_IsEmpty(geom) AND NOT ${isMicroSql("geom", minWidth)}
        GROUP BY ALL ORDER BY area DESC
      `)
    ).toArray() as { g_a: unknown; g_b: unknown; area: number }[];
    if (rows.length) {
      const listed = rows
        .slice(0, 10)
        .map((r) => `${r.g_a} / ${r.g_b} (${r.area.toPrecision(3)} deg2)`)
        .join(", ");
      throw new Error(`${table}: ${rows.length} ${groupColumn} pair(s) overlap, e.g. ${listed}`);
    }
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${tmp}`);
  }
}

export async function hasMicroPolygons(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<boolean> {
  const r = await conn.query(`--sql
    SELECT EXISTS (
      SELECT 1 FROM (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM ${table}
                     WHERE geom IS NOT NULL)
      WHERE ${isMicroSql("geom")}
    ) AS bad
  `);
  return Boolean(r.toArray()[0].bad);
}

async function emptyMicroIssues(conn: AsyncDuckDBConnection, issuesTable: string): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT NULL::VARCHAR AS key, NULL::VARCHAR AS kind, NULL::BIGINT AS unit_a,
           NULL::BIGINT AS unit_b, NULL::VARCHAR AS reason, NULL::DOUBLE AS area_m2,
           NULL::DOUBLE AS max_width_m, NULL::BOOLEAN AS fixed, NULL::GEOMETRY AS geom,
           NULL::DOUBLE AS xmin, NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymin, NULL::DOUBLE AS ymax
    WHERE FALSE
  `);
}

// Per-row rebuild of `rebuilt` after the set-based union throws: a row that still
// throws is retried on the fallback grid, then with its kept parts snapped onto the incoming.
async function rebuildRowwise(
  conn: AsyncDuckDBConnection,
  parts: string,
  keep: string,
  dest: string,
  touched: string,
  rebuilt: string,
): Promise<number> {
  const rnids = (await conn.query(`SELECT rnid FROM ${touched}`)).toArray() as Array<{
    rnid: bigint | number;
  }>;
  await conn.query(`CREATE OR REPLACE TABLE ${rebuilt} (rnid BIGINT, geom GEOMETRY)`);
  let snapped = 0;
  for (const { rnid } of rnids) {
    const insert = (combine: string) => `--sql
      INSERT INTO ${rebuilt}
      WITH own AS (SELECT ST_Union_Agg(geom) AS g FROM ${parts} WHERE rnid = ${rnid} AND ${keep}),
      incoming AS (SELECT ST_Union_Agg(geom) AS g FROM ${dest} WHERE dest_rnid = ${rnid})
      SELECT * FROM (SELECT ${rnid}, ${combine} AS geom FROM own, incoming)
      WHERE NOT ST_IsEmpty(geom)
    `;
    try {
      await queryOrGrid(conn, `rebuild row ${rnid}`, (g) =>
        insert(`COALESCE(ST_Union(${g("own.g")}, ${g("incoming.g")}), own.g, incoming.g)`),
      );
    } catch {
      await conn.query(
        insert(`ST_Union(ST_Snap(own.g, incoming.g, ${SNAP_TOLERANCE}), incoming.g)`),
      );
      snapped++;
    }
  }
  return snapped;
}

// Ported from topo-tools' merge_micro_polygons, which holds the merge rule;
// writes one micro-polygon row per part to issuesTable and returns the count.
export async function mergeMicroPolygons(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  issuesTable: string,
): Promise<number> {
  if (!(await hasMicroPolygons(conn, tableIn))) {
    await emptyMicroIssues(conn, issuesTable);
    if (tableOut !== tableIn) {
      await conn.query(`CREATE OR REPLACE TABLE ${tableOut} AS SELECT * FROM ${tableIn}`);
    }
    return 0;
  }
  const tol = SNAP_TOLERANCE;
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  const all = `${issuesTable}_all`;
  const parts = `${issuesTable}_parts`;
  const dest = `${issuesTable}_dest`;
  const touched = `${issuesTable}_touched`;
  const rebuilt = `${issuesTable}_rebuilt`;
  const microBuf = `${issuesTable}_mbuf`;
  const nonMicro = `${issuesTable}_nonmicro`;
  const weights = `${issuesTable}_weights`;
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE ${all} AS SELECT row_number() OVER () AS rnid, * FROM ${tableIn}`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${parts} AS
      WITH p AS (
        SELECT rnid, fid, UNNEST(ST_Dump(geom)).geom AS geom FROM ${all} WHERE geom IS NOT NULL
      )
      SELECT row_number() OVER () AS pid, *, ${isMicroSql("geom")} AS micro, ${bboxColumnsSql()}
      FROM p
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${microBuf} AS
      SELECT pid AS id, geom, ${bboxColumnsSql("geom")}
      FROM (SELECT pid, ST_Buffer(geom, ${tol}) AS geom FROM ${parts} WHERE micro)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${nonMicro} AS
      SELECT pid AS id, geom, xmin, xmax, ymin, ymax FROM ${parts} WHERE NOT micro
    `);
    await intersectPairs(conn, "mergeMicroPolygons", microBuf, nonMicro, weights);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${dest} AS
      WITH pairs AS (
        SELECT w.a_id AS pid, n.rnid AS dest_rnid, n.fid AS dest_fid, ST_Area(w.geom) AS w
        FROM ${weights} w JOIN ${parts} n ON n.pid = w.b_id
      )
      SELECT m.pid, m.rnid, m.fid, m.geom, p.dest_rnid, p.dest_fid
      FROM (SELECT * FROM ${parts} WHERE micro) m LEFT JOIN (
        SELECT * FROM pairs WHERE w > 0
        QUALIFY row_number() OVER (PARTITION BY pid ORDER BY w DESC, dest_fid) = 1
      ) p USING (pid)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${issuesTable} AS
      SELECT 'micro-polygon-' || row_number() OVER (ORDER BY fid, hash(geom)) AS key,
             'micro-polygon' AS kind,
             fid AS unit_a, dest_fid AS unit_b,
             CASE WHEN dest_rnid IS NULL THEN '${MICRO_DROPPED_REASON}'
                  ELSE '${MICRO_MERGED_REASON}' END AS reason,
             ST_Area(geom) * ${areaFactor} AS area_m2,
             (ST_MaximumInscribedCircle(geom)).radius * 2 * ${widthFactor} AS max_width_m,
             TRUE AS fixed, geom, ${bboxColumnsSql()}
      FROM ${dest} ORDER BY fid, hash(geom)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${touched} AS
      SELECT rnid FROM ${dest}
      UNION SELECT dest_rnid FROM ${dest} WHERE dest_rnid IS NOT NULL
    `);
    try {
      await conn.query(`--sql
        CREATE OR REPLACE TABLE ${rebuilt} AS
        WITH pieces AS (
          SELECT p.rnid, p.geom FROM ${parts} p SEMI JOIN ${touched} USING (rnid) WHERE NOT p.micro
          UNION ALL
          SELECT dest_rnid, geom FROM ${dest} WHERE dest_rnid IS NOT NULL
        )
        SELECT rnid, ST_Union_Agg(geom) AS geom FROM pieces GROUP BY rnid
      `);
    } catch {
      // WASM GEOS throws "non-noded intersection" on some near-coincident edges.
      const snapped = await rebuildRowwise(conn, parts, "NOT micro", dest, touched, rebuilt);
      if (snapped > 0) console.warn(`mergeMicroPolygons: ${snapped} row(s) unioned after snapping`);
    }
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${tableOut} AS
      SELECT t.* EXCLUDE (geom, rnid), COALESCE(r.geom, t.geom) AS geom
      FROM ${all} t LEFT JOIN ${rebuilt} r USING (rnid)
      WHERE r.rnid IS NOT NULL OR t.rnid NOT IN (SELECT rnid FROM ${touched})
    `);
    const r = await conn.query(`SELECT COUNT(*) AS n FROM ${issuesTable}`);
    const count = Number((r.toArray()[0] as { n: bigint | number }).n);
    console.log(`merged or dropped ${count} micro-polygon part(s) in ${tableIn}`);
    return count;
  } finally {
    for (const t of [all, parts, dest, touched, rebuilt, microBuf, nonMicro, weights])
      await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

export interface DetachedPartsOptions {
  preClipSql: string; // SELECT fid, geom: the rows before clipping
  overlaySql: string; // SELECT geom: the one overlay feature they were clipped to
  overlayFid: number;
  originalTable: string | null; // pre-extension layer (fid, geom), when known
  issuesTable: string;
}

export async function emptyDetachedIssues(
  conn: AsyncDuckDBConnection,
  issuesTable: string,
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${issuesTable} AS
    SELECT NULL::VARCHAR AS key, NULL::VARCHAR AS kind, NULL::BIGINT AS unit_a,
           NULL::BIGINT AS unit_b, NULL::BIGINT AS overlay_fid, NULL::VARCHAR AS reason,
           NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m, NULL::DOUBLE AS thinness_ratio,
           NULL::BOOLEAN AS fixed, NULL::GEOMETRY AS geom,
           NULL::DOUBLE AS xmin, NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymin, NULL::DOUBLE AS ymax
    WHERE FALSE
  `);
}

// Runs `build(g)` with exact geometry, then once more on the fallback grid
// when WASM GEOS throws a noding error that native GEOS doesn't.
async function queryOrGrid(
  conn: AsyncDuckDBConnection,
  label: string,
  build: (g: (expr: string) => string) => string,
): Promise<void> {
  try {
    await conn.query(build((expr) => expr));
  } catch (e) {
    console.warn(`${label} failed; retrying on a ${NODING_FALLBACK_GRID} grid:`, e);
    await conn.query(build((expr) => `ST_ReducePrecision(${expr}, ${NODING_FALLBACK_GRID})`));
  }
}

// Ported from topo-tools' merge_detached_parts, which holds the merge rule;
// writes one detached-part row per non-isolated piece to issuesTable and
// returns the merged count. Without originalTable nothing merges.
export async function mergeDetachedParts(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  tableOut: string,
  opts: DetachedPartsOptions,
): Promise<number> {
  const { preClipSql, overlaySql, overlayFid, originalTable, issuesTable } = opts;
  const multi = await conn.query(
    `SELECT COUNT(*) AS n FROM ${tableIn} WHERE ST_NumGeometries(geom) > 1`,
  );
  if (Number((multi.toArray()[0] as { n: bigint | number }).n) === 0) {
    await emptyDetachedIssues(conn, issuesTable);
    if (tableOut !== tableIn) {
      await conn.query(`CREATE OR REPLACE TABLE ${tableOut} AS SELECT * FROM ${tableIn}`);
    }
    return 0;
  }
  const tol = SNAP_TOLERANCE;
  const areaFactor = degSqToM2(1).toExponential();
  const widthFactor = degToM(1).toExponential();
  const t = (name: string) => `${issuesTable}_${name}`;
  const [all, parts, pre, pts, q, group, rank, dest, moved, touched, rebuilt] = [
    "all",
    "parts",
    "pre",
    "pts",
    "q",
    "group",
    "rank",
    "dest",
    "moved",
    "touched",
    "rebuilt",
  ].map(t);
  const scratch = [
    all,
    parts,
    pre,
    pts,
    q,
    group,
    rank,
    dest,
    moved,
    touched,
    rebuilt,
    t("oparts"),
  ];
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE ${all} AS SELECT row_number() OVER () AS rnid, * FROM ${tableIn}`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${parts} AS
      WITH p AS (
        SELECT rnid, fid, ST_NumGeometries(geom) > 1 AS multi,
               UNNEST(ST_Dump(geom)).geom AS geom
        FROM ${all} WHERE geom IS NOT NULL
      )
      SELECT row_number() OVER () AS pid, *, ST_Area(geom) AS area, ${bboxColumnsSql()}
      FROM p
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${pre} AS
      WITH p AS (
        SELECT fid, UNNEST(ST_Dump(geom)).geom AS geom FROM (${preClipSql})
        WHERE fid IN (SELECT fid FROM ${parts} WHERE multi)
      )
      SELECT row_number() OVER () AS qid, fid, geom, ST_Area(geom) AS qarea, ${bboxColumnsSql()}
      FROM p
    `);
    // Each output piece lies inside one pre-clip part, so a point test finds it.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${pts} AS
      SELECT pid, fid, pt, ST_X(pt) AS px, ST_Y(pt) AS py
      FROM (SELECT pid, fid, ST_PointOnSurface(geom) AS pt FROM ${parts} WHERE multi)
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${q} AS
      SELECT p.pid, p.fid, COALESCE(q.qid, -p.pid) AS qid
      FROM ${pts} p LEFT JOIN ${pre} q
        ON q.fid = p.fid AND q.xmin <= p.px AND q.xmax >= p.px
       AND q.ymin <= p.py AND q.ymax >= p.py AND ST_Intersects(q.geom, p.pt)
      QUALIFY row_number() OVER (PARTITION BY p.pid ORDER BY q.qarea DESC NULLS LAST, q.qid) = 1
    `);
    if (originalTable === null) {
      await conn.query(`CREATE OR REPLACE TABLE ${group} AS SELECT *, TRUE AS on_src FROM ${q}`);
    } else {
      await groupOnOriginal(conn, issuesTable, originalTable, { parts, pre, pts, q, group });
    }
    // Per pre-clip part, the largest piece on the original footprint is kept,
    // so an extension-only piece never outranks a unit's real footprint.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${rank} AS
      WITH flagged AS (
        SELECT g.*, p.area,
               row_number() OVER (
                 PARTITION BY g.fid, g.qid ORDER BY g.on_src DESC, p.area DESC, g.pid
               ) = 1 AS kept
        FROM ${group} g JOIN ${parts} p USING (pid)
      )
      SELECT pid, area, kept,
             max(area) FILTER (WHERE kept) OVER (PARTITION BY fid, qid) AS kept_area
      FROM flagged
    `);
    // A point contact measures about 2*tol of neighbour boundary; an edge far more.
    await queryOrGrid(
      conn,
      "mergeDetachedParts contact",
      (g) => `--sql
      CREATE OR REPLACE TABLE ${dest} AS
      WITH d AS (
        SELECT p.*, r.area / NULLIF(r.kept_area, 0) < ${DETACHED_MERGE_MAX_RATIO} AS small
        FROM ${rank} r JOIN ${parts} p USING (pid)
        WHERE NOT r.kept
      ),
      n AS (
        SELECT * FROM ${parts} WHERE pid NOT IN (SELECT pid FROM d WHERE small IS NOT FALSE)
      ),
      pairs AS (
        SELECT s.pid, n.pid AS dest_pid, n.rnid AS dest_rnid, n.fid AS dest_fid,
               ST_Length(ST_Intersection(
                 ST_Boundary(${g("n.geom")}), ST_Buffer(${g("s.geom")}, ${tol})
               )) AS contact
        FROM d s JOIN n
          ON n.rnid <> s.rnid
         AND n.xmin <= s.xmax + ${tol} AND n.xmax >= s.xmin - ${tol}
         AND n.ymin <= s.ymax + ${tol} AND n.ymax >= s.ymin - ${tol}
      ),
      best AS (
        SELECT * FROM pairs WHERE contact > ${10 * tol}
        QUALIFY row_number() OVER (PARTITION BY pid ORDER BY contact DESC, dest_fid) = 1
      )
      SELECT d.pid, d.rnid, d.fid, d.area, d.geom, b.dest_rnid, b.dest_fid,
             CASE WHEN b.dest_pid IS NULL THEN 'isolated'
                  WHEN d.small IS NOT TRUE THEN 'too-large'
                  WHEN ST_NumGeometries(ST_Union(${g("d.geom")}, ${g("np.geom")})) = 1
                    THEN 'candidate'
                  ELSE 'unattached' END AS outcome
      FROM d LEFT JOIN best b USING (pid)
      LEFT JOIN ${parts} np ON np.pid = b.dest_pid
    `,
    );
    if (originalTable === null) {
      await conn.query(`UPDATE ${dest} SET outcome = 'no-original' WHERE outcome = 'candidate'`);
    } else {
      await classifyDetachedCandidates(conn, issuesTable, overlaySql, dest);
    }
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${issuesTable} AS
      SELECT 'detached-part-' || fid || '-'
               || row_number() OVER (PARTITION BY fid ORDER BY pid) AS key,
             'detached-part' AS kind, fid AS unit_a, dest_fid AS unit_b,
             ${overlayFid}::BIGINT AS overlay_fid,
             CASE outcome WHEN 'merged' THEN '${MICRO_MERGED_REASON}'
                          WHEN 'too-large' THEN 'kept: too large to merge'
                          WHEN 'no-original' THEN 'kept: no original layer'
                          WHEN 'lobe' THEN 'kept: matches original shape'
                          ELSE 'kept: merge did not attach' END AS reason,
             area * ${areaFactor} AS area_m2,
             (ST_MaximumInscribedCircle(geom)).radius * 2 * ${widthFactor} AS max_width_m,
             4 * pi() * ST_Area(geom) / POWER(ST_Perimeter(geom), 2) AS thinness_ratio,
             outcome = 'merged' AS fixed, geom, ${bboxColumnsSql()}
      FROM ${dest} WHERE outcome <> 'isolated' ORDER BY pid
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${moved} AS
      SELECT pid, rnid, dest_rnid, geom FROM ${dest} WHERE outcome = 'merged'
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${touched} AS
      SELECT rnid FROM ${moved} UNION SELECT dest_rnid FROM ${moved}
    `);
    const keep = `pid NOT IN (SELECT pid FROM ${moved})`;
    try {
      await conn.query(`--sql
        CREATE OR REPLACE TABLE ${rebuilt} AS
        WITH pieces AS (
          SELECT p.rnid, p.geom FROM ${parts} p SEMI JOIN ${touched} USING (rnid) WHERE ${keep}
          UNION ALL
          SELECT dest_rnid, geom FROM ${moved}
        )
        SELECT rnid, ST_Union_Agg(geom) AS geom FROM pieces GROUP BY rnid
      `);
    } catch {
      // WASM GEOS throws "non-noded intersection" on some near-coincident edges.
      const snapped = await rebuildRowwise(conn, parts, keep, moved, touched, rebuilt);
      if (snapped > 0) console.warn(`mergeDetachedParts: ${snapped} row(s) unioned after snapping`);
    }
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${tableOut} AS
      SELECT t.* EXCLUDE (geom, rnid),
             COALESCE(ST_Multi(ST_CollectionExtract(r.geom, 3)), t.geom) AS geom
      FROM ${all} t LEFT JOIN ${rebuilt} r USING (rnid)
      ORDER BY t.rnid
    `);
    const r = await conn.query(`SELECT COUNT(*) AS n FROM ${moved}`);
    const count = Number((r.toArray()[0] as { n: bigint | number }).n);
    if (count > 0) console.log(`merged ${count} clip-detached piece(s) in ${tableIn}`);
    return count;
  } finally {
    for (const s of scratch) await conn.query(`DROP TABLE IF EXISTS ${s}`);
  }
}

// Writes `group` (pid, fid, qid, on_src): a piece is on the original footprint
// when its interior point lies on an owned original part or at least
// DETACHED_MAX_ORIGINAL_SHARE of it is original land.
async function groupOnOriginal(
  conn: AsyncDuckDBConnection,
  prefix: string,
  originalTable: string,
  tables: { parts: string; pre: string; pts: string; q: string; group: string },
): Promise<void> {
  const { parts, pre, pts, q, group } = tables;
  const t = (name: string) => `${prefix}_${name}`;
  const [split, oparts, onsrc, offsrc, shared] = [
    "split",
    "oparts",
    "onsrc",
    "offsrc",
    "shared",
  ].map(t);
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${split} AS
      SELECT pid AS id, p.fid, p.geom, p.xmin, p.xmax, p.ymin, p.ymax
      FROM ${parts} p JOIN ${q} q USING (pid)
      WHERE q.qid IN (SELECT qid FROM ${q} GROUP BY qid HAVING count(*) > 1)
    `);
    await loadOwnedOriginal(conn, originalTable, split, pre, oparts);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${onsrc} AS
      SELECT DISTINCT s.id AS pid
      FROM ${split} s JOIN ${pts} t ON t.pid = s.id JOIN ${oparts} o
        ON o.fid = s.fid AND o.xmin <= t.px AND o.xmax >= t.px
       AND o.ymin <= t.py AND o.ymax >= t.py AND ST_Intersects(o.geom, t.pt)
    `);
    // An interior point can land in a hole of a piece mostly on the original.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${offsrc} AS
      SELECT * FROM ${split} WHERE id NOT IN (SELECT pid FROM ${onsrc})
    `);
    await intersectPairs(
      conn,
      "mergeDetachedParts share",
      offsrc,
      oparts,
      shared,
      "a.fid = b.fid AND ST_Intersects(a.geom, b.geom)",
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${group} AS
      WITH share AS (
        SELECT s.a_id AS pid FROM ${shared} s JOIN ${parts} p ON p.pid = s.a_id
        GROUP BY s.a_id, p.area
        HAVING sum(ST_Area(s.geom)) >= ${DETACHED_MAX_ORIGINAL_SHARE} * p.area
      )
      SELECT q.*, q.pid IN (SELECT pid FROM ${onsrc}) OR q.pid IN (SELECT pid FROM share) AS on_src
      FROM ${q} q
    `);
  } finally {
    for (const s of [split, onsrc, offsrc, shared]) await conn.query(`DROP TABLE IF EXISTS ${s}`);
  }
}

// Writes `oparts` (id, fid, geom, bbox): original parts near a probe, each
// owned by the pre-clip part holding its feature's interior point, so no key
// column is shared with the input.
async function loadOwnedOriginal(
  conn: AsyncDuckDBConnection,
  originalTable: string,
  probeTable: string,
  pre: string,
  oparts: string,
): Promise<void> {
  const tol = SNAP_TOLERANCE;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${oparts} AS
    WITH o AS (SELECT geom, ${bboxColumnsSql()} FROM ${originalTable} WHERE geom IS NOT NULL),
    near AS (
      SELECT row_number() OVER () AS oid, geom FROM o
      WHERE EXISTS (
        SELECT 1 FROM ${probeTable} p
        WHERE p.xmin - ${tol} <= o.xmax AND p.xmax + ${tol} >= o.xmin
          AND p.ymin - ${tol} <= o.ymax AND p.ymax + ${tol} >= o.ymin
      )
    ),
    pos AS (
      SELECT oid, pt, ST_X(pt) AS px, ST_Y(pt) AS py
      FROM (SELECT oid, ST_PointOnSurface(geom) AS pt FROM near)
    ),
    owner AS (
      SELECT f.oid, q.fid FROM pos f JOIN ${pre} q
        ON q.xmin <= f.px AND q.xmax >= f.px
       AND q.ymin <= f.py AND q.ymax >= f.py AND ST_Intersects(q.geom, f.pt)
      QUALIFY row_number() OVER (PARTITION BY f.oid ORDER BY q.qid) = 1
    ),
    dumped AS (
      SELECT o.fid, UNNEST(ST_Dump(n.geom)).geom AS geom
      FROM near n JOIN owner o USING (oid)
    )
    SELECT row_number() OVER () AS id, fid, geom, ${bboxColumnsSql()} FROM dumped
  `);
}

// Marks each 'candidate' in `dest` as 'merged' or 'lobe'. Original land the
// overlay clipped away beside a piece (the "neck") is large when the clip
// sliced across the unit, near zero for a drawn lobe.
async function classifyDetachedCandidates(
  conn: AsyncDuckDBConnection,
  prefix: string,
  overlaySql: string,
  dest: string,
): Promise<void> {
  const tol = SNAP_TOLERANCE;
  const t = (name: string) => `${prefix}_${name}`;
  const [cand, src, su, shared, rule] = ["cand", "src", "su", "cshared", "rule"].map(t);
  const oparts = t("oparts");
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${cand} AS
      SELECT pid AS id, fid, area, geom, ${bboxColumnsSql()}
      FROM ${dest} WHERE outcome = 'candidate'
    `);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${src} AS
      WITH probe AS (
        SELECT id, fid, b, ${bboxColumnsSql("b")}
        FROM (SELECT id, fid, ST_Buffer(geom, ${tol}) AS b FROM ${cand})
      )
      SELECT p.id AS pid, o.geom FROM probe p JOIN ${oparts} o
        ON o.fid = p.fid AND ${bboxOverlapSql("p", "o")}
      WHERE ST_Intersects(o.geom, p.b)
    `);
    await queryOrGrid(
      conn,
      "mergeDetachedParts original union",
      (g) => `--sql
      CREATE OR REPLACE TABLE ${su} AS
      SELECT pid AS id, geom, ${bboxColumnsSql()}
      FROM (SELECT pid, ST_Union_Agg(${g("geom")}) AS geom FROM ${src} GROUP BY pid)
    `,
    );
    await intersectPairs(
      conn,
      "mergeDetachedParts candidate share",
      cand,
      su,
      shared,
      "a.id = b.id",
    );
    await queryOrGrid(
      conn,
      "mergeDetachedParts neck",
      (g) => `--sql
      CREATE OR REPLACE TABLE ${rule} AS
      WITH ov AS (SELECT ST_Union_Agg(geom) AS geom FROM (${overlaySql})),
      outside AS (
        SELECT su.id AS pid, UNNEST(ST_Dump(ST_Difference(
          ${g("su.geom")},
          ST_CollectionExtract(ST_Intersection(${g("ov.geom")}, ST_MakeEnvelope(
            su.xmin - 0.01, su.ymin - 0.01, su.xmax + 0.01, su.ymax + 0.01
          )), 3)
        ))).geom AS geom
        FROM ${su} su, ov
      ),
      neck AS (
        SELECT c.id AS pid, sum(ST_Area(o.geom)) AS neck_area
        FROM ${cand} c JOIN outside o ON o.pid = c.id
        WHERE ST_Dimension(o.geom) = 2 AND ST_Intersects(o.geom, ST_Buffer(c.geom, ${tol}))
        GROUP BY c.id
      ),
      share AS (SELECT a_id AS pid, sum(ST_Area(geom)) AS a FROM ${shared} GROUP BY a_id)
      SELECT c.id AS pid, COALESCE(s.a, 0) / c.area AS share,
             COALESCE(n.neck_area, 0) / c.area AS neck
      FROM ${cand} c LEFT JOIN share s ON s.pid = c.id LEFT JOIN neck n ON n.pid = c.id
    `,
    );
    await conn.query(`--sql
      UPDATE ${dest} d SET outcome = CASE
        WHEN r.share < ${DETACHED_MAX_ORIGINAL_SHARE} OR r.neck >= ${DETACHED_MIN_NECK_RATIO}
          THEN 'merged' ELSE 'lobe' END
      FROM ${rule} r WHERE r.pid = d.pid
    `);
  } finally {
    for (const s of [cand, src, su, shared, rule]) await conn.query(`DROP TABLE IF EXISTS ${s}`);
  }
}

// Ported from topo-tools' check_no_erosion; hard error, since a footprint
// shrunk by extend/merge is data loss, not a cosmetic topology defect.
export async function checkNoErosion(
  conn: AsyncDuckDBConnection,
  tableBefore: string,
  tableAfter: string,
  buffer: number = SNAP_TOLERANCE,
): Promise<void> {
  const r = await conn.query(`--sql
    SELECT b.fid AS fid
    FROM ${tableBefore} b
    LEFT JOIN ${tableAfter} a USING (fid)
    WHERE a.geom IS NULL OR NOT ST_Covers(ST_Buffer(a.geom, ${buffer}), b.geom)
  `);
  const rows = r.toArray() as Array<{ fid: bigint | number }>;
  if (rows.length > 0) {
    const fids = rows.map((row) => Number(row.fid));
    const shown = fids.slice(0, 20).join(", ");
    const suffix = fids.length > 20 ? ", ..." : "";
    throw new Error(
      `extension eroded the original footprint of ${fids.length} fid(s): ${shown}${suffix}`,
    );
  }
}

// Overlap regions = polygonal pairwise intersections of sourceTable's polygons,
// written to targetTable (n, fa, fb, geom). ST_Overlaps/ST_Contains, not
// ST_Intersects, which would also match every ordinary touching-edge pair.
export async function buildOverlapTable(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  sourceTable: string,
): Promise<void> {
  const bboxed = `${targetTable}_bbox`;
  const pieces = `${targetTable}_pieces`;
  await conn.query(
    `CREATE OR REPLACE TABLE ${bboxed} AS SELECT fid AS id, geom, ${bboxColumnsSql()} FROM ${sourceTable}`,
  );
  try {
    await intersectPairs(
      conn,
      "buildOverlapTable",
      bboxed,
      bboxed,
      pieces,
      `a.id < b.id AND (ST_Overlaps(a.geom, b.geom) OR ST_Contains(a.geom, b.geom) OR ST_Contains(b.geom, a.geom))`,
    );
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${targetTable} AS
      SELECT row_number() OVER (ORDER BY a_id, b_id) AS n, a_id AS fa, b_id AS fb, geom
      FROM ${pieces}
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${bboxed}`);
    await conn.query(`DROP TABLE IF EXISTS ${pieces}`);
  }
}
