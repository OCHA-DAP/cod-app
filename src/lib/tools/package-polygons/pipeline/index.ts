import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { checkNoOverlaps, mergeMicroPolygons } from "$lib/db/coverage";
import { tableToGeoJSON } from "$lib/db/geojson";
import { setCentroidLat } from "$lib/db/units";
import {
  detectLevelCodes,
  detectLevelColumns,
  verifyFunctionalCluster,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import {
  validateTargetSchema,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import { runDissolveCore } from "./dissolveCore";
import { buildPolygonIssues, type PolygonIssueRow } from "./issues";

export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { PolygonIssueRow } from "./issues";

export interface PackagePolygonsLevelResult {
  level: number;
  groupBy: string[];
  exportable: boolean;
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  keptColumns: string[];
  summedColumns: string[];
  droppedColumns: string[];
  issues: PolygonIssueRow[];
  issuesGeoJSON: string;
}

export interface PackagePolygonsResult {
  levels: PackagePolygonsLevelResult[];
}

interface LevelPlan {
  level: number;
  groupBy: string[];
  exclude: string[];
}

// Auto-detect excludes every finer level's own identity columns, so an
// ancestor never survives dissolve under its own numbered name.
async function resolveLevelPlans(
  conn: AsyncDuckDBConnection,
  attrTable: string,
  schema: TargetSchema | null,
): Promise<LevelPlan[]> {
  if (schema !== null) {
    validateTargetSchema(schema);
    const levels = await detectLevels(conn, attrTable, schema);
    return levels.map((level) => ({
      level,
      groupBy: [schema.codeField.replace("{n}", String(level))],
      exclude: [],
    }));
  }

  const levelColumns = await detectLevelColumns(conn, attrTable);
  const levelCodes = await detectLevelCodes(conn, attrTable);
  const levels = [...levelColumns.keys()].sort((a, b) => a - b);
  const plans: LevelPlan[] = [];
  for (const level of levels) {
    const cols = levelColumns.get(level)!;
    // groupBy is unfiltered by naming anchor and can sweep in incidental
    // numeric columns at row-unique cardinality; identityColumns is safe.
    const identitySet = new Set(cols.identityColumns);
    const groupBy = cols.groupBy.filter((c) => identitySet.has(c));
    if (groupBy.length === 0) {
      throw new Error(`level ${level} has no code column to group by in ${attrTable}`);
    }
    const canonical = levelCodes.get(level);
    if (canonical === undefined) {
      throw new Error(`no canonical code column resolved for level ${level} in ${attrTable}`);
    }
    await verifyFunctionalCluster(conn, attrTable, canonical, groupBy);
    const exclude = levels
      .filter((l) => l > level)
      .flatMap((l) => levelColumns.get(l)!.identityColumns);
    plans.push({ level, groupBy, exclude });
  }
  return plans;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<[number, number, number, number] | null> {
  const r = await conn.query(`--sql
    SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
           MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
    FROM ${table} WHERE geom IS NOT NULL
  `);
  const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
  if (![xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))) return null;
  setCentroidLat((ymin + ymax) / 2);
  return [xmin, ymin, xmax, ymax];
}

// The finest level needs no dissolve: its output is the original input,
// not offered as a separate download.
export async function runPackagePolygons(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<PackagePolygonsResult> {
  await mergeMicroPolygons(conn, "layer_01", "layer_01", "pp_micro");
  await checkNoOverlaps(conn, "layer_01");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE pp_input AS
    SELECT a.fid, a.geom, b.* EXCLUDE (fid)
    FROM layer_01 a LEFT JOIN layer_attr b ON a.fid = b.fid
  `);

  const plans = await resolveLevelPlans(conn, "layer_attr", schema);
  if (plans.length === 0) {
    throw new Error("no admin hierarchy level detected");
  }
  const finestLevel = Math.max(...plans.map((p) => p.level));

  const levels: PackagePolygonsLevelResult[] = [];
  for (const plan of plans) {
    const exportable = plan.level !== finestLevel;
    const geomTable = exportable ? `pp_geom_${plan.level}` : "layer_01";
    const attrTable = exportable ? `pp_attr_${plan.level}` : "layer_attr";

    let keptColumns: string[] = [];
    let summedColumns: string[] = [];
    let droppedColumns: string[] = [];

    if (exportable) {
      const dissolveTable = `pp_dissolved_${plan.level}`;
      const { kept, summed, overridden, dropped } = await runDissolveCore(
        conn,
        "pp_input",
        dissolveTable,
        { groupBy: plan.groupBy, exclude: plan.exclude, targetSchema: schema ?? undefined },
      );
      keptColumns = [...kept, ...overridden];
      summedColumns = summed;
      droppedColumns = dropped;

      const attrCols = [...plan.groupBy, ...keptColumns, ...summedColumns]
        .map((c) => `"${c}"`)
        .join(", ");
      await conn.query(
        `CREATE OR REPLACE TABLE ${geomTable} AS SELECT fid, geom FROM ${dissolveTable}`,
      );
      await conn.query(
        `CREATE OR REPLACE TABLE ${attrTable} AS SELECT fid, ${attrCols} FROM ${dissolveTable}`,
      );
      await conn.query(`DROP TABLE IF EXISTS ${dissolveTable}`);
    }

    const bounds = await computeBounds(conn, geomTable);
    const resultGeoJSON = await tableToGeoJSON(conn, geomTable, attrTable);
    const { rows, geojson } = await buildPolygonIssues(
      conn,
      geomTable,
      plan.level,
      exportable ? null : "pp_micro",
    );

    levels.push({
      level: plan.level,
      groupBy: plan.groupBy,
      exportable,
      resultGeoJSON,
      bounds,
      keptColumns,
      summedColumns,
      droppedColumns,
      issues: rows,
      issuesGeoJSON: geojson,
    });
  }

  await conn.query(`DROP TABLE IF EXISTS pp_input`);
  await conn.query(`DROP TABLE IF EXISTS pp_micro`);

  return { levels };
}
