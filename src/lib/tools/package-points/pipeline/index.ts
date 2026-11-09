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
  rootInjected: boolean;
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

// Called coarsest-to-finest: the first real level's surviving columns seed the
// generalizable-columns gate, since a column a coarser dissolve drops can't generalize.
async function buildLevelOutput(
  conn: AsyncDuckDBConnection,
  sourceTable: string,
  plan: LevelPlan,
  isRoot: boolean,
  generalizable: Set<string> | null,
  depthColumn: string,
): Promise<{ output: LevelOutput; generalizable: Set<string> | null }> {
  const dissolveTable = `pkpt_dissolved_${plan.level}`;
  const { kept, summed, overridden } = await runDissolveCore(conn, sourceTable, dissolveTable, {
    groupBy: plan.groupBy,
    exclude: plan.exclude,
  });

  const expected = await distinctTupleCount(conn, sourceTable, plan.groupBy);
  const actual = await rowCount(conn, dissolveTable);
  if (actual !== expected) {
    throw new Error(
      `level ${plan.level}: dissolved to ${actual} row(s), expected ${expected} distinct group(s)`,
    );
  }

  const identitySet = new Set(plan.rename.keys());
  let extraCols = [...kept, ...summed, ...overridden].filter((c) => !identitySet.has(c));
  let nextGeneralizable = generalizable;
  if (!isRoot) {
    if (nextGeneralizable === null) nextGeneralizable = new Set(extraCols);
    else extraCols = extraCols.filter((c) => nextGeneralizable!.has(c));
  }

  const identitySelect = [...plan.rename.entries()].map(
    ([col, generic]) => `"${col}" AS "${generic}"`,
  );
  const extraSelect = extraCols.map((c) => `"${c}"`);
  const selectCols = [...identitySelect, ...extraSelect];

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
    SELECT fid, ${selectCols.length > 0 ? selectCols.join(", ") + "," : ""} ${plan.level} AS "${depthColumn}"
    FROM ${dissolveTable}
  `);

  await conn.query(`DROP TABLE IF EXISTS ${dissolveTable}`);
  return { output: { geomTable, attrTable }, generalizable: nextGeneralizable };
}

export async function runPackagePoints(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  depthColumn: string = DEFAULT_DEPTH_COLUMN,
): Promise<PackagePointsResult> {
  const attrCols = await conn.query(`DESCRIBE layer_attr`);
  const hasDepthColumn = (attrCols.toArray() as Array<{ column_name: string }>).some(
    (r) => r.column_name === depthColumn,
  );
  if (hasDepthColumn) {
    throw new Error(`depthColumn "${depthColumn}" already exists on layer_attr`);
  }

  await mergeMicroPolygons(conn, "layer_01", "layer_01", "pkpt_micro");
  await checkNoOverlaps(conn, "layer_01");
  await conn.query("DROP TABLE IF EXISTS pkpt_micro");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE pkpt_input AS
    SELECT a.fid, a.geom, b.* EXCLUDE (fid)
    FROM layer_01 a LEFT JOIN layer_attr b ON a.fid = b.fid
  `);

  const { plans, rootInjected } = await resolvePointLevelPlans(conn, "layer_attr", schema);
  if (plans.length === 0) {
    throw new Error("no admin hierarchy level detected");
  }
  const rootLevel = Math.min(...plans.map((p) => p.level));
  const sortedAsc = [...plans].sort((a, b) => a.level - b.level);

  let generalizable: Set<string> | null = null;
  const outputs: LevelOutput[] = [];
  for (const plan of sortedAsc) {
    const result = await buildLevelOutput(
      conn,
      "pkpt_input",
      plan,
      rootInjected && plan.level === rootLevel,
      generalizable,
      depthColumn,
    );
    outputs.push(result.output);
    generalizable = result.generalizable;
  }
  await conn.query(`DROP TABLE IF EXISTS pkpt_input`);

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
    rootInjected,
  };
}
