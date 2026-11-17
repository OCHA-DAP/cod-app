import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { genericFamilies } from "$lib/db/adminColumns";
import { bboxColumnsSql } from "$lib/db/bbox";
import { SNAP_TOLERANCE, SUBDIVIDE_MAX_VERTICES } from "$lib/db/constants";
import { runDissolveCore } from "$lib/tools/package-polygons/pipeline/dissolveCore";
import { genericNamesByFamily } from "$lib/tools/schema-map/pipeline/identityNames";
import {
  detectLevelsWithRoot,
  fallbackFamilies,
  groupFamiliesByLevel,
  levelCodeColumns,
  verifyFunctionalCluster,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

// Ports topo-tools' core/package_lines/_02_boundaries.py.

// Grid cell size, in degrees, that boundaries are clipped to before noding.
export const TILE_DEG = 1.0;
// Tiles overlap by this much so a line cut at a tile edge still meets its node.
export const TILE_MARGIN_DEG = 0.00001;

const RESERVED_COLUMNS = new Set(["left_fid", "right_fid", "geom"]);

type Families = Map<string, Map<number, string>>;

async function tableColumns(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

function classificationSql(levels: number[], codeColumns: Array<string | null>): string {
  if (levels.length === 1) return String(levels[0]);
  const cases = levels
    .slice(0, -1)
    .flatMap((level, i) => {
      const col = codeColumns[i];
      return col === null ? [] : [`WHEN l."${col}" IS DISTINCT FROM r."${col}" THEN ${level} `];
    })
    .join("");
  return `CASE ${cases}ELSE ${levels[levels.length - 1]} END`;
}

async function checkEveryFidPresent(
  conn: AsyncDuckDBConnection,
  dissolved: string,
  lines: string,
): Promise<void> {
  const r = await conn.query(`--sql
    SELECT fid FROM "${dissolved}"
    WHERE fid NOT IN (
      SELECT left_fid FROM "${lines}"
      UNION
      SELECT right_fid FROM "${lines}" WHERE right_fid IS NOT NULL
    )
  `);
  const missing = (r.toArray() as Array<{ fid: bigint | number }>).map((row) => Number(row.fid));
  if (missing.length > 0) {
    throw new Error(`${lines}: fid(s) missing from every boundary row: ${missing.join(", ")}`);
  }
}

// The coarsest level if it has one unit (its outline), else one less.
async function outerDepth(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: number[],
  codeColumns: Array<string | null>,
): Promise<number> {
  const code = codeColumns[0];
  const coarsest = Math.min(...levels);
  if (code === null) return coarsest;
  const r = await conn.query(`SELECT COUNT(DISTINCT "${code}") AS n FROM "${table}"`);
  return Number((r.toArray()[0] as { n: bigint }).n) <= 1 ? coarsest : coarsest - 1;
}

// Each label's source column per row depth; outer edges use the coarsest.
function labelColumns(
  families: Families,
  levels: number[],
  codeColumns: Array<string | null>,
  dissolvedColumns: Set<string>,
  outer: number,
): Map<string, Map<number, string>> {
  const labelLevels = new Map(levels.map((l): [number, number] => [l, l]));
  labelLevels.set(outer, Math.min(...levels));
  if (families.size === 0) {
    const codes = new Map<number, string>();
    levels.forEach((l, i) => {
      if (codeColumns[i] !== null) codes.set(l, codeColumns[i]!);
    });
    families = new Map([["code", codes]]);
  }
  const labels = new Map<string, Map<number, string>>();
  for (const [generic, perLevel] of families) {
    const byDepth = new Map<number, string>();
    for (const [depth, lvl] of labelLevels) {
      const col = perLevel.get(lvl);
      if (col !== undefined && dissolvedColumns.has(col)) byDepth.set(depth, col);
    }
    if (byDepth.size) labels.set(generic, byDepth);
  }
  return labels.size ? labels : new Map([["code", new Map()]]);
}

// Dissolves at the detected finest level; returns codes, families and the root level.
async function autoDetect(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  dissolved: string,
  levels: number[],
): Promise<[Array<string | null>, Families, number | null]> {
  const levelColumns = await detectLevelsWithRoot(conn, tableIn);
  for (const n of levels) {
    const cols = levelColumns.get(n)!;
    if (!cols.groupBy.length && levelColumns.size > 1 && !cols.isRoot) {
      throw new Error(`no reliable group-by column detected for level ${n}`);
    }
  }
  const grouped = await groupFamiliesByLevel(conn, tableIn, levelColumns);
  let families = grouped.size ? grouped : fallbackFamilies(levelColumns, levels);
  const codeColumns = levelCodeColumns(levelColumns, families, levels);
  const finestGroupBy = levelColumns.get(Math.max(...levels))!.groupBy;
  if (finestGroupBy.length) {
    await verifyFunctionalCluster(
      conn,
      tableIn,
      codeColumns[codeColumns.length - 1]!,
      finestGroupBy,
    );
  }
  await runDissolveCore(conn, tableIn, dissolved, { groupBy: finestGroupBy });
  families = genericNamesByFamily(families, levels, codeColumns);
  const root = [...levelColumns].find(([, c]) => c.isRoot)?.[0] ?? null;
  return [codeColumns, families, root];
}

// Dissolves at the finest level, then extracts and classifies its noded boundary network.
export async function buildBoundaries(
  conn: AsyncDuckDBConnection,
  tableIn: string,
  name: string,
  levels: number[],
  schema: TargetSchema | null,
  depthColumn: string,
  minLevel: number | null = null,
): Promise<void> {
  if (RESERVED_COLUMNS.has(depthColumn)) {
    throw new Error(`depthColumn "${depthColumn}" collides with a fixed output column`);
  }
  if (minLevel !== null && minLevel > Math.max(...levels)) {
    throw new Error(`no admin level at or above min level ${minLevel}`);
  }

  const dissolved = `${name}_dissolved`;
  let codeColumns: Array<string | null>;
  let families: Families;
  let rootLevel: number | null = null;
  if (schema !== null) {
    codeColumns = levels.map((n) => schema.codeField.replace("{n}", String(n)));
    families = genericFamilies(
      await tableColumns(conn, tableIn),
      levels,
      schema.nameField,
      schema.codeField,
    );
    await runDissolveCore(conn, tableIn, dissolved, {
      groupBy: [codeColumns[codeColumns.length - 1]!],
      targetSchema: schema,
    });
  } else {
    [codeColumns, families, rootLevel] = await autoDetect(conn, tableIn, dissolved, levels);
  }

  const dissolvedColumns = new Set(await tableColumns(conn, dissolved));
  const outer = await outerDepth(conn, tableIn, levels, codeColumns);
  const labels = labelColumns(families, levels, codeColumns, dissolvedColumns, outer);

  await nodedLines(conn, name, dissolved);

  // A whole-table-constant root never separates two units; a NULL would.
  const classification = classificationSql(
    levels,
    levels.map((n, i) => (n === rootLevel ? null : codeColumns[i])),
  );
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_rows" AS
    SELECT s.left_fid, s.right_fid,
           CASE WHEN s.right_fid IS NULL THEN ${outer} ELSE ${classification} END AS depth, s.geom
    FROM "${name}_lines" s
    JOIN "${dissolved}" l ON l.fid = s.left_fid
    LEFT JOIN "${dissolved}" r ON r.fid = s.right_fid
  `);

  const label = (side: string, byDepth: Map<number, string>) => {
    const cases = [...byDepth]
      .map(([depth, col]) => `WHEN ${depth} THEN ${side}."${col}" `)
      .join("");
    return cases ? `CASE s.depth ${cases}END` : "NULL";
  };
  const labelSql = ["a", "b"]
    .flatMap((side) =>
      [...labels].map(([g, byDepth]) => `${label(side, byDepth)} AS "${side}_${g}"`),
    )
    .join(", ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}" AS
    SELECT s.left_fid, s.right_fid, ${labelSql}, s.depth AS "${depthColumn}", s.geom
    FROM "${name}_rows" s
    JOIN "${dissolved}" a ON a.fid = s.left_fid
    LEFT JOIN "${dissolved}" b ON b.fid = s.right_fid
  `);

  await checkEveryFidPresent(conn, dissolved, name);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}" AS SELECT * EXCLUDE (left_fid, right_fid) FROM "${name}"
    ${minLevel !== null ? `WHERE "${depthColumn}" >= ${minLevel}` : ""}
    ORDER BY left_fid, right_fid NULLS LAST, hash(geom)
  `);

  for (const suffix of ["lines", "rows", "dissolved"]) {
    await conn.query(`DROP TABLE IF EXISTS "${name}_${suffix}"`);
  }
}

// Moves each endpoint onto the least endpoint within tol; drops zero-length lines.
export async function snapEnds(
  conn: AsyncDuckDBConnection,
  table: string,
  key: string,
  tol: number,
): Promise<void> {
  const cell = TILE_MARGIN_DEG;
  const near = `(a.x - b.x) ** 2 + (a.y - b.y) ** 2 < ${tol} ** 2`;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${table}" AS
    WITH ends AS (
      SELECT ${key}, side, ST_X(pt) AS x, ST_Y(pt) AS y, pt,
             floor(ST_X(pt) / ${cell})::BIGINT AS gx,
             floor(ST_Y(pt) / ${cell})::BIGINT AS gy
      FROM (
        SELECT ${key}, UNNEST([0, 1]) AS side,
               UNNEST([ST_StartPoint(geom), ST_EndPoint(geom)]) AS pt
        FROM "${table}"
      )
    ),
    probes AS (
      SELECT ${key}, side, x, y, gx + dx AS gx, gy + dy AS gy
      FROM ends, (SELECT UNNEST([-1, 0, 1]) AS dx), (SELECT UNNEST([-1, 0, 1]) AS dy)
      WHERE (dx = 0 OR (dx = -1 AND x - gx * ${cell} < ${tol})
             OR (dx = 1 AND (gx + 1) * ${cell} - x < ${tol}))
        AND (dy = 0 OR (dy = -1 AND y - gy * ${cell} < ${tol})
             OR (dy = 1 AND (gy + 1) * ${cell} - y < ${tol}))
    ),
    targets AS (
      SELECT a.${key}, a.side, arg_min(b.pt, [b.x, b.y]) AS pt
      FROM probes a JOIN ends b ON a.gx = b.gx AND a.gy = b.gy
        AND a.${key} <> b.${key} AND ${near}
        AND (b.x < a.x OR (b.x = a.x AND b.y < a.y))
      GROUP BY a.${key}, a.side
    ),
    moves AS (
      SELECT ${key}, any_value(pt) FILTER (side = 0) AS first,
             any_value(pt) FILTER (side = 1) AS last
      FROM targets GROUP BY ${key}
    )
    SELECT * FROM (
      SELECT t.* REPLACE (CASE WHEN m.${key} IS NULL THEN t.geom
        ELSE ST_MakeLine(list_concat(
          [coalesce(m.first, ST_StartPoint(t.geom))],
          list_slice([p.geom FOR p IN ST_Dump(ST_Points(t.geom))], 2, -2),
          [coalesce(m.last, ST_EndPoint(t.geom))]
        )) END AS geom)
      FROM "${table}" t LEFT JOIN moves m USING (${key})
    )
    WHERE ST_Length(geom) > 0
  `);
}

function tileRange(low: string, high: string): string {
  const [first, last] = [low, high].map((v) => `floor(${v} / ${TILE_DEG})::BIGINT`);
  return `range(${first}, ${last} + 1)`;
}

function envelope(margin: number): string {
  return `ST_MakeEnvelope(tx * ${TILE_DEG} - ${margin}, ty * ${TILE_DEG} - ${margin}, (tx + 1) * ${TILE_DEG} + ${margin}, (ty + 1) * ${TILE_DEG} + ${margin})`;
}

// Clips geom to its tile, skipping the clip for a geom already inside it.
function clipToTile(margin: number): string {
  const inside = [
    `xmin >= tx * ${TILE_DEG} - ${margin}`,
    `xmax <= (tx + 1) * ${TILE_DEG} + ${margin}`,
    `ymin >= ty * ${TILE_DEG} - ${margin}`,
    `ymax <= (ty + 1) * ${TILE_DEG} + ${margin}`,
  ].join(" AND ");
  const clip = `ST_CollectionExtract(ST_Intersection(geom, ${envelope(margin)}), 2)`;
  return `CASE WHEN ${inside} THEN geom ELSE ${clip} END`;
}

// Nodes every unit boundary per grid tile and labels each edge by its one or two units.
// Writes `${name}_lines` (left_fid, right_fid NULL for an exterior edge, geom).
export async function nodedLines(
  conn: AsyncDuckDBConnection,
  name: string,
  dissolved: string,
  maxVertices = SUBDIVIDE_MAX_VERTICES,
): Promise<void> {
  const tol = SNAP_TOLERANCE * 10;
  const margin = TILE_MARGIN_DEG;
  const step = maxVertices - 1;
  // A whole boundary repeated per tile runs out of memory on a large unit, so
  // long parts are cut at their own vertices into runs sharing an end vertex.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp1" AS
    WITH parts AS (
      SELECT fid, row_number() OVER () AS part, geom
      FROM (
        SELECT fid, UNNEST(ST_Dump(ST_Boundary(geom))).geom AS geom
        FROM "${dissolved}"
      )
    ),
    verts AS (
      SELECT fid, part, generate_subscripts(pts, 1) AS i, UNNEST(pts) AS pt
      FROM (
        SELECT fid, part, [p.geom FOR p IN ST_Dump(ST_Points(geom))] AS pts
        FROM parts WHERE ST_NPoints(geom) > ${maxVertices}
      )
    ),
    runs AS (
      SELECT fid, part, i, pt, (i - 1) // ${step} AS k FROM verts
      UNION ALL
      SELECT fid, part, i, pt, (i - 1) // ${step} - 1 AS k FROM verts
      WHERE i > 1 AND (i - 1) % ${step} = 0
    )
    SELECT fid, geom, ${bboxColumnsSql("geom")}
    FROM (
      SELECT fid, geom FROM parts
      WHERE ST_NPoints(geom) <= ${maxVertices}
      UNION ALL
      SELECT fid, ST_MakeLine(list(pt ORDER BY i)) AS geom
      FROM runs GROUP BY fid, part, k HAVING count(*) > 1
    )
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp2" AS
    SELECT row_number() OVER () AS bid, fid, tx, ty, geom, ${bboxColumnsSql("geom")}
    FROM (
      SELECT fid, tx, ty, ${clipToTile(margin)} AS geom
      FROM (
        SELECT *, UNNEST(${tileRange(`(ymin - ${margin})`, `(ymax + ${margin})`)}) AS ty
        FROM (
          SELECT *, UNNEST(${tileRange(`(xmin - ${margin})`, `(xmax + ${margin})`)}) AS tx
          FROM "${name}_tmp1"
        )
      )
    )
    WHERE NOT ST_IsEmpty(geom)
  `);
  await conn.query(`DROP TABLE "${name}_tmp1"`);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp3" AS
    SELECT row_number() OVER () AS eid, tx, ty, geom
    FROM (
      SELECT tx, ty, UNNEST(ST_Dump(ST_LineMerge(ST_Union_Agg(geom)))).geom AS geom
      FROM "${name}_tmp2" GROUP BY tx, ty
    )
  `);
  await snapEnds(conn, `${name}_tmp3`, "eid", tol);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp3" AS
    SELECT row_number() OVER (
             ORDER BY tx, ty, ST_XMin(geom), ST_YMin(geom), ST_AsWKB(geom)
           ) AS eid, tx, ty, geom,
           ST_LineInterpolatePoint(geom, 0.5) AS mid,
           ${bboxColumnsSql("geom")}
    FROM (SELECT tx, ty, ST_Normalize(geom) AS geom FROM "${name}_tmp3")
  `);
  // Pairing on bbox columns alone first keeps geometry out of the join's hash table.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp4" AS
    SELECT e.eid, b.bid
    FROM (SELECT eid, tx, ty, ST_X(mid) AS mx, ST_Y(mid) AS my FROM "${name}_tmp3") e
    JOIN (SELECT bid, tx, ty, xmin, xmax, ymin, ymax FROM "${name}_tmp2") b
      ON b.tx = e.tx AND b.ty = e.ty
      AND e.mx BETWEEN b.xmin - ${tol} AND b.xmax + ${tol}
      AND e.my BETWEEN b.ymin - ${tol} AND b.ymax + ${tol}
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp4" AS
    WITH near AS (
      SELECT c.eid, b.fid, min(ST_Distance(b.geom, e.mid)) AS dist
      FROM "${name}_tmp4" c
      JOIN (SELECT eid, mid FROM "${name}_tmp3") e USING (eid)
      JOIN (SELECT bid, fid, geom FROM "${name}_tmp2") b USING (bid)
      WHERE ST_DWithin(b.geom, e.mid, ${tol})
      GROUP BY c.eid, b.fid
    ),
    ranked AS (
      SELECT eid, fid, row_number() OVER (PARTITION BY eid ORDER BY dist, fid) AS rank
      FROM near
    )
    SELECT eid, min(fid) AS left_fid,
           CASE WHEN count(*) = 2 THEN max(fid) END AS right_fid
    FROM ranked WHERE rank <= 2 GROUP BY eid
  `);
  await conn.query(`DROP TABLE "${name}_tmp2"`);
  // Each side's vertices go into the other's copy of a shared border.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp5" AS
    WITH labelled AS (
      SELECT l.eid, l.left_fid, l.right_fid, e.tx, e.ty, e.geom, e.xmin, e.xmax, e.ymin, e.ymax
      FROM "${name}_tmp4" l JOIN "${name}_tmp3" e USING (eid)
      WHERE l.right_fid IS NOT NULL
    )
    SELECT a.eid,
           ST_Snap(any_value(a.geom),
                   ST_Collect(list_append(list(b.geom ORDER BY b.eid), any_value(a.geom))),
                   ${tol}) AS geom
    FROM labelled a JOIN labelled b ON a.tx = b.tx AND a.ty = b.ty
      AND a.left_fid = b.left_fid AND a.right_fid = b.right_fid
      AND a.eid <> b.eid
      AND a.xmin <= b.xmax + ${tol} AND a.xmax >= b.xmin - ${tol}
      AND a.ymin <= b.ymax + ${tol} AND a.ymax >= b.ymin - ${tol}
    GROUP BY a.eid
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_tmp6" AS
    SELECT row_number() OVER (ORDER BY left_fid, right_fid, ST_AsWKB(geom)) AS pid,
           left_fid, right_fid, geom
    FROM (
      SELECT l.left_fid, l.right_fid, ${clipToTile(0)} AS geom
      FROM (
        SELECT e.eid, e.tx, e.ty, e.xmin, e.xmax, e.ymin, e.ymax,
               coalesce(s.geom, e.geom) AS geom
        FROM "${name}_tmp3" e LEFT JOIN "${name}_tmp5" s USING (eid)
      ) e
      JOIN "${name}_tmp4" l USING (eid)
    )
    WHERE NOT ST_IsEmpty(geom)
  `);
  for (const t of ["tmp3", "tmp4", "tmp5"]) await conn.query(`DROP TABLE "${name}_${t}"`);
  await snapEnds(conn, `${name}_tmp6`, "pid", tol);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE "${name}_lines" AS
    SELECT left_fid, right_fid, geom
    FROM (
      SELECT left_fid, right_fid,
             UNNEST(ST_Dump(ST_LineMerge(ST_Union_Agg(geom ORDER BY pid)))).geom AS geom
      FROM "${name}_tmp6" GROUP BY left_fid, right_fid
    )
    WHERE NOT ST_IsEmpty(geom)
  `);
  await conn.query(`DROP TABLE "${name}_tmp6"`);
}
