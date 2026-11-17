import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { runPackageLines, type PackageLinesResult } from "$lib/tools/package-lines/pipeline/index";
import {
  runPackagePoints,
  type PackagePointsResult,
} from "$lib/tools/package-points/pipeline/index";
import {
  runPackagePolygons,
  type PackagePolygonsResult,
} from "$lib/tools/package-polygons/pipeline/index";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type {
  PackagePolygonsLevelResult,
  PackagePolygonsResult,
} from "$lib/tools/package-polygons/pipeline/index";
export type { PackagePointsResult } from "$lib/tools/package-points/pipeline/index";
export type { PackageLinesResult } from "$lib/tools/package-lines/pipeline/index";

export interface PackageResult {
  polygons: PackagePolygonsResult;
  points: PackagePointsResult;
  lines: PackageLinesResult;
}

// The finest level is the input itself; views give it the same export source as a dissolved level.
async function exposeFinestLevel(conn: AsyncDuckDBConnection, level: number | undefined): Promise<void> {
  const views = await conn.query(
    `SELECT view_name FROM duckdb_views() WHERE regexp_full_match(view_name, 'pp_(geom|attr)_[0-9]+')`,
  );
  for (const { view_name } of views.toArray() as Array<{ view_name: string }>) {
    await conn.query(`DROP VIEW "${view_name}"`);
  }
  if (level === undefined) return;
  await conn.query(`CREATE VIEW pp_geom_${level} AS SELECT fid, geom FROM layer_01`);
  await conn.query(`CREATE VIEW pp_attr_${level} AS SELECT * FROM layer_attr`);
}

// No table names collide across the three sub-pipelines (pp_/pkpt_/pl_ prefixes).
export async function runPackage(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  minLevel: number | null = null,
): Promise<PackageResult> {
  await exposeFinestLevel(conn, undefined);
  const polygons = await runPackagePolygons(conn, schema, minLevel);
  await exposeFinestLevel(conn, polygons.levels.find((l) => !l.exportable)?.level);
  const points = await runPackagePoints(conn, schema, undefined, minLevel);
  const lines = await runPackageLines(conn, schema);
  return { polygons, points, lines };
}
