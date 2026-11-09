import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import {
  DEFAULT_TARGET_SCHEMA,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { resolveLevels, runFill } from "./fill";

export {
  DEFAULT_TARGET_SCHEMA,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { layerBounds } from "$lib/db/layerView";

export const DEFAULT_DEPTH_COLUMN = "adm_lvl";

export interface SchemaFillResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levels: number[];
  depthColumn: string;
}

// No topology gate: fill only touches attribute columns. A null schema
// triggers structural auto-detection of the hierarchy instead.
export async function runSchemaFill(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null = DEFAULT_TARGET_SCHEMA,
  depthColumn: string = DEFAULT_DEPTH_COLUMN,
): Promise<SchemaFillResult> {
  const levels = await resolveLevels(conn, "layer_attr", schema);
  await runFill(conn, "layer_attr", "sf_result_attr", { levels, schema, depthColumn });

  const resultGeoJSON = await tableToGeoJSON(conn, "layer_01", "sf_result_attr");
  const bounds = await layerBounds(conn);

  return { resultGeoJSON, bounds, levels, depthColumn };
}
