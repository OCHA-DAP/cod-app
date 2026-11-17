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
import { gatedCoverageClean } from "$lib/db/coverageClean";
import { isOutOfMemory } from "$lib/db/errors";
import { runValidate, type ValidateResult } from "./validate";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type {
  PackagePolygonsLevelResult,
  PackagePolygonsResult,
} from "$lib/tools/package-polygons/pipeline/index";
export type { PackagePointsResult } from "$lib/tools/package-points/pipeline/index";
export type { PackageLinesResult } from "$lib/tools/package-lines/pipeline/index";

export type { ValidateResult } from "./validate";

export interface PackageOutputs {
  polygons: PackagePolygonsResult;
  points: PackagePointsResult;
  lines: PackageLinesResult;
}

export interface PackageResult {
  validation: ValidateResult;
  // Null when validation found an error and blocking was on.
  outputs: PackageOutputs | null;
}

export interface PackageOptions {
  minLevel?: number | null;
  // Whether layer_01 was coverage-cleaned on load; off skips the topology checks.
  clean?: boolean;
  block?: boolean;
  stem?: string;
}

// Coverage-cleans layer_01 when clean is on, then keeps a copy for restorePackageInput.
export async function preparePackageInput(
  conn: AsyncDuckDBConnection,
  clean: boolean,
): Promise<void> {
  if (clean) {
    try {
      await gatedCoverageClean(conn, "layer_01", { anyHole: true, rethrow: true });
    } catch (e) {
      if (!isOutOfMemory(e)) throw e;
      throw new Error(
        `The coverage clean ran out of memory. Turn Clean off under Advanced options and try again. (${(e as Error).message})`,
      );
    }
  }
  await conn.query("CREATE OR REPLACE TABLE pkg_input AS SELECT * FROM layer_01");
}

// The sub-tools merge micro-polygons into layer_01 in place, so each rerun starts from the copy.
export async function restorePackageInput(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query("CREATE OR REPLACE TABLE layer_01 AS SELECT * FROM pkg_input");
}

// The finest level is the input itself; views give it the same export source as a dissolved level.
async function exposeFinestLevel(
  conn: AsyncDuckDBConnection,
  level: number | undefined,
): Promise<void> {
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

// Validates layer_01, then packages it unless an error blocks; no table names collide
// across the three sub-pipelines (pp_/pkpt_/pl_ prefixes).
export async function runPackage(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  { minLevel = null, clean = true, block = true, stem = "layer" }: PackageOptions = {},
): Promise<PackageResult> {
  const validation = await runValidate(conn, schema, stem, !clean);
  if (validation.hasErrors && block) return { validation, outputs: null };
  await exposeFinestLevel(conn, undefined);
  const polygons = await runPackagePolygons(conn, schema, minLevel, clean);
  await exposeFinestLevel(conn, polygons.levels.find((l) => !l.exportable)?.level);
  const points = await runPackagePoints(conn, schema, undefined, minLevel, clean);
  const lines = await runPackageLines(conn, schema, undefined, minLevel, clean);
  return { validation, outputs: { polygons, points, lines } };
}
