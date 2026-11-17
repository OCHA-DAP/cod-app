import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { checkNoOverlaps, mergeMicroPolygons } from "$lib/db/coverage";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { runDissolveCore } from "$lib/tools/package-polygons/pipeline/dissolveCore";
import { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { resolvePointLevelPlans, type LevelPlan } from "./points";
import { layerBounds } from "$lib/db/layerView";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";

export interface PackagePointsResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levels: number[];
  rootLevel: number | null;
}

async function rowCount(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  const r = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(r.toArray()[0].n);
}

async function distinctTupleCount(
  conn: AsyncDuckDBConnection,
  table: string,
  groupBy: string[],
): Promise<number> {
  if (groupBy.length === 0) return 1;
  const cols = groupBy.map((c) => `"${c}"`).join(", ");
  const r = await conn.query(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${cols} FROM ${table})`);
  return Number(r.toArray()[0].n);
}

interface LevelOutput {
  geomTable: string;
  attrTable: string;
}

// Points carry only their own level's identity; other attributes stay on polygons.
async function buildLevelOutput(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  plan: LevelPlan,
  depthColumn: string,
): Promise<LevelOutput> {
  const dissolveTable = `pkpt_dissolved_${plan.level}`;
  const keep = new Set([...plan.groupBy, ...plan.rename.keys(), "fid", "geom"]);
  const columns = (await conn.query(`DESCRIBE ${sourceTable}`)).toArray() as Array<{
    column_name: string;
  }>;
  await runDissolveCore(conn, sourceTable, dissolveTable, {
    groupBy: plan.groupBy,
    exclude: columns.map((r) => r.column_name).filter((c) => !keep.has(c)),
  });

  const expected = await distinctTupleCount(conn, sourceTable, plan.groupBy);
  const actual = await rowCount(conn, dissolveTable);
  if (actual !== expected) {
    throw new Error(
      `level ${plan.level}: dissolved to ${actual} row(s), expected ${expected} distinct group(s)`,
    );
  }

  const selectCols = [...plan.rename].map(([col, generic]) => `"${col}" AS "${generic}", `);
  const geomTable = `pkpt_geom_${plan.level}`;
  const attrTable = `pkpt_attr_${plan.level}`;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${geomTable} AS
    SELECT fid, (ST_MaximumInscribedCircle(geom)).center AS geom FROM ${dissolveTable}
  `);

  const violations = await conn.query(`--sql
    SELECT COUNT(*) AS n FROM ${dissolveTable} d JOIN ${geomTable} p USING (fid)
    WHERE NOT ST_Covers(d.geom, p.geom)
  `);
  if (Number(violations.toArray()[0].n) > 0) {
    throw new Error(
      `level ${plan.level}: representative point not covered by its own source polygon`,
    );
  }

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${attrTable} AS
    SELECT fid, ${selectCols.join("")}${plan.level} AS "${depthColumn}"
    FROM ${dissolveTable}
  `);

  await conn.query(`DROP TABLE IF EXISTS ${dissolveTable}`);
  return { geomTable, attrTable };
}

export async function runPackagePoints(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  depthColumn: string = DEFAULT_DEPTH_COLUMN,
  minLevel: number | null = null,
): Promise<PackagePointsResult> {
  const attrCols = await conn.query(`DESCRIBE layer_attr`);
  const hasDepthColumn = (attrCols.toArray() as Array<{ column_name: string }>).some(
    (r) => r.column_name === depthColumn,
  );
  // Each point is stamped with the level it labels, so an input depth column is replaced.
  const attrSource = hasDepthColumn ? "pkpt_layer_attr" : "layer_attr";
  if (hasDepthColumn) {
    await conn.query(`--sql
      CREATE OR REPLACE VIEW pkpt_layer_attr AS SELECT * EXCLUDE ("${depthColumn}") FROM layer_attr
    `);
  }

  await mergeMicroPolygons(conn, "layer_01", "layer_01", "pkpt_micro");
  await checkNoOverlaps(conn, "layer_01");
  await conn.query("DROP TABLE IF EXISTS pkpt_micro");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE pkpt_input AS
    SELECT a.fid, a.geom, b.* EXCLUDE (fid)
    FROM layer_01 a LEFT JOIN ${attrSource} b ON a.fid = b.fid
  `);

  const plans = await resolvePointLevelPlans(conn, attrSource, schema, depthColumn, minLevel);
  if (plans.length === 0) {
    throw new Error("no admin hierarchy level detected");
  }
  const outputs: LevelOutput[] = [];
  for (const plan of [...plans].sort((a, b) => a.level - b.level)) {
    outputs.push(await buildLevelOutput(conn, "pkpt_input", plan, depthColumn));
  }
  await conn.query(`DROP TABLE IF EXISTS pkpt_input`);
  await conn.query("DROP VIEW IF EXISTS pkpt_layer_attr");

  const unionSql = outputs
    .map(
      ({ geomTable, attrTable }) => `--sql
      SELECT g.geom, a.* EXCLUDE (fid) FROM ${geomTable} g JOIN ${attrTable} a USING (fid)
    `,
    )
    .join(" UNION ALL BY NAME ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE pkpt_combined AS
    SELECT row_number() OVER () AS fid, * FROM (${unionSql})
  `);
  for (const { geomTable, attrTable } of outputs) {
    await conn.query(`DROP TABLE IF EXISTS ${geomTable}`);
    await conn.query(`DROP TABLE IF EXISTS ${attrTable}`);
  }

  await conn.query(`CREATE OR REPLACE TABLE pkpt_geom AS SELECT fid, geom FROM pkpt_combined`);
  await conn.query(
    `CREATE OR REPLACE TABLE pkpt_attr AS SELECT * EXCLUDE (geom) FROM pkpt_combined`,
  );
  await conn.query(`DROP TABLE IF EXISTS pkpt_combined`);

  const bounds = await layerBounds(conn, "pkpt_geom");
  if (bounds) setCentroidLat((bounds[1] + bounds[3]) / 2);

  const resultGeoJSON = await tableToGeoJSON(conn, "pkpt_geom", "pkpt_attr");

  return {
    resultGeoJSON,
    bounds,
    levels: plans.map((p) => p.level).sort((a, b) => a - b),
    rootLevel: plans.find((p) => p.isRoot)?.level ?? null,
  };
}
