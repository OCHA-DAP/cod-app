import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { checkNoOverlaps, mergeMicroPolygons } from "$lib/db/coverage";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import { detectLevelColumnsOrSingle } from "$lib/tools/schema-map/pipeline/levelColumns";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { buildBoundaries } from "./boundaries";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";

export interface PackageLinesResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levels: number[];
}

export async function runPackageLines(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  depthColumn: string = DEFAULT_DEPTH_COLUMN,
): Promise<PackageLinesResult> {
  await mergeMicroPolygons(conn, "layer_01", "layer_01", "pl_micro");
  await checkNoOverlaps(conn, "layer_01");
  await conn.query("DROP TABLE IF EXISTS pl_micro");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE pl_input AS
    SELECT a.fid, a.geom, b.* EXCLUDE (fid)
    FROM layer_01 a LEFT JOIN layer_attr b ON a.fid = b.fid
  `);

  const levels =
    schema !== null
      ? await detectLevels(conn, "layer_attr", schema)
      : [...(await detectLevelColumnsOrSingle(conn, "layer_attr")).keys()].sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new Error("no admin hierarchy level detected");
  }

  await buildBoundaries(conn, "pl_input", "pl_lines", levels, schema, depthColumn);
  await conn.query(`DROP TABLE IF EXISTS pl_input`);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE pl_combined AS SELECT row_number() OVER () AS fid, * FROM pl_lines
  `);
  await conn.query(`CREATE OR REPLACE TABLE pl_geom AS SELECT fid, geom FROM pl_combined`);
  await conn.query(`CREATE OR REPLACE TABLE pl_attr AS SELECT * EXCLUDE (geom) FROM pl_combined`);
  await conn.query(`DROP TABLE IF EXISTS pl_combined`);
  await conn.query(`DROP TABLE IF EXISTS pl_lines`);

  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM pl_geom WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  const bounds: [number, number, number, number] | null = [xmin, ymin, xmax, ymax].every((v) =>
    Number.isFinite(v),
  )
    ? [xmin, ymin, xmax, ymax]
    : null;
  if (bounds) setCentroidLat((bounds[1] + bounds[3]) / 2);

  const resultGeoJSON = await tableToGeoJSON(conn, "pl_geom", "pl_attr");

  return { resultGeoJSON, bounds, levels };
}
