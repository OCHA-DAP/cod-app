import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignOne } from "$lib/db/assignOne";
import { carryOverlayColumns } from "$lib/db/carryColumns";
import { clipEngine, mergeClipDetached } from "$lib/db/clipEngine";
import { buildTiles } from "$lib/db/clipTiles";
import { checkNoOverlaps, mergeMicroPolygons } from "$lib/db/coverage";
import { checkValidTopology, coverageCleanRows } from "$lib/db/coverageClean";
import { changedGeoJSON, tableToGeoJSON } from "$lib/db/geojson";
import { invalidEdgeIssues } from "$lib/db/invalidEdges";
import { setCentroidLat } from "$lib/db/units";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { buildMosaicIssues, type MosaicIssueRow } from "./issues";
import { loadLayers } from "./load";

export type { MosaicIssueRow } from "./issues";

export type ProgressFn = (stage: number, label: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface MosaicResult {
  detachedMergedCount: number;
  detachedKeptCount: number;
  inputGeoJSON: string;
  overlayOutlineGeoJSON: string;
  mosaicGeoJSON: string;
  changedGeoJSON: string;
  bounds: [number, number, number, number] | null;
  overlayFid: number;
  issues: MosaicIssueRow[];
  issuesGeoJSON: string;
  invalidEdgeCount: number;
  gapCount: number;
  inputColumns: ColumnGuess;
  overlayColumns: ColumnGuess;
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ${table} WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    if ([xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))) {
      setCentroidLat((ymin + ymax) / 2);
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Ported from topo-tools' mosaic: assign-one, then a clip to the winning overlay
// polygon on shared border points, with no re-extension and no stitch.
export async function runMosaic(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  originalFiles: File[],
  onProgress: ProgressFn,
  matchColumns: MatchColumnOptions = {},
  carryColumns: string[] = [],
  clean = true,
): Promise<MosaicResult> {
  onProgress(1, "Loading input");
  await loadLayers(db, conn, inputFiles, overlayFiles, originalFiles);
  try {
    await checkValidTopology(conn, "input_layer_01", 0);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new PipelineError(`input ${inputFiles[0]?.name} is not a clean coverage: ${message}`, 1);
  }
  try {
    await checkNoOverlaps(conn, "overlay_layer_01");
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 1);
  }
  const inputGeoJSON = await tableToGeoJSON(conn, "input_layer_01", null);
  const overlayOutlineGeoJSON = await tableToGeoJSON(conn, "overlay_layer_01", null);
  const bounds = await computeBounds(conn, "input_layer_01");
  const inputColumns = await detectColumns(conn, "input_layer_attr");
  const overlayColumns = await detectColumns(conn, "overlay_layer_attr");

  onProgress(2, "Assigning to overlay polygon");
  let assign;
  try {
    assign = await assignOne(conn, matchColumns);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }
  if (assign.overlayFid === null) {
    throw new PipelineError(
      "No input polygons overlap any overlay polygon, so there is nothing to clip.",
      2,
    );
  }

  try {
    await carryOverlayColumns(conn, carryColumns, assign.overlayFid, inputColumns.all);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 2);
  }

  onProgress(3, "Clipping to overlay boundary");
  let engineResult;
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cl_clip_in AS
      SELECT c.fid, a.overlay_fid, c.geom FROM input_layer_01 c JOIN cl_assign a ON a.input_fid = c.fid
    `);
    await conn.query("DROP TABLE IF EXISTS cl_tiles_all");
    await buildTiles(conn, "overlay_layer_01", "SELECT overlay_fid FROM cl_clip_in", "cl_tiles_all");
    engineResult = await clipEngine(conn, "cl_clip_in", "cl_tiles_all", "cl_clip");
    await conn.query("DROP TABLE IF EXISTS cl_tiles_all");
    await conn.query("DROP TABLE IF EXISTS cl_clip_in");
    await conn.query("DROP TABLE IF EXISTS cl_clip_dropped");
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }
  if (engineResult.outputCount === 0) {
    throw new PipelineError("Clipping produced no output rows.", 3);
  }
  let detached;
  try {
    detached = await mergeClipDetached(conn, assign.overlayFid, originalFiles.length > 0);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 3);
  }

  onProgress(4, clean ? "Closing seams" : "Checking edges");
  let invalidEdgeCount;
  try {
    if (clean) await coverageCleanRows(conn, "cl_clip", "TRUE", "ms_micro");
    else await mergeMicroPolygons(conn, "cl_clip", "cl_clip", "ms_micro");
    invalidEdgeCount = await invalidEdgeIssues(conn, "cl_clip", "ms_invalid");
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  onProgress(5, "Assembling issues report");
  const { rows, geojson } = await buildMosaicIssues(conn, assign.overlayFid, {
    assignmentMethod: assign.assignmentMethod,
    spatialAgrees: assign.spatialAgrees,
  }, clean);
  const gapCount = rows.filter((r) => r.kind === "gap").length;

  return {
    inputGeoJSON,
    overlayOutlineGeoJSON,
    mosaicGeoJSON: await tableToGeoJSON(conn, "cl_clip", "input_layer_attr"),
    changedGeoJSON: await changedGeoJSON(conn, "cl_clip", "input_layer_01"),
    bounds,
    overlayFid: assign.overlayFid,
    detachedMergedCount: detached.merged,
    detachedKeptCount: detached.kept,
    issues: rows,
    issuesGeoJSON: geojson,
    invalidEdgeCount,
    gapCount,
    inputColumns,
    overlayColumns,
  };
}
