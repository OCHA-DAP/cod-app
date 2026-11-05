import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { gatedCoverageClean } from "$lib/db/coverageClean";
import { hasInvalidEdges } from "$lib/db/invalidEdges";
import { checkNoErosion, buildGapTable, hasMicroPolygons } from "$lib/db/coverage";
import { changedGeoJSON, tableToGeoJSON } from "$lib/db/geojson";
import { stageCleanInput } from "./clean";
import { computeEffectiveDistance } from "./distance";
import { stageLines } from "./lines";
import { stageMerge } from "./merge";
import { buildSegments, estimateCount, stagePoints } from "./points";
import { AssignmentError, stageVoronoi } from "./voronoi";

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

const MAX_ATTEMPTS = 10;
const MAX_POINTS = 10_000_000;

// Every table this pipeline creates downstream of the caller-supplied
// layer_01/layer_attr. Dropped defensively at the start of every run so
// runPipeline is safe to call repeatedly against changing input in the same
// session (e.g. once per group in Edge Matcher) without the caller having
// to track internal table names — a stale leftover here would otherwise be
// silently picked up by the next run's ST_Union_Agg/JOIN calls.
const INTERNAL_TABLES = [
  "layer_01_tmp_clean",
  "layer_02_tmp1",
  "layer_02_tmp2",
  "layer_02a",
  "layer_03_tmp1",
  "layer_03a",
  "layer_03b",
  "layer_03_tmp2",
  "layer_03_tmp3",
  "layer_03_tmp4",
  "layer_04_tmp0",
  "layer_04_tmp1",
  "layer_04_tmp2",
  "layer_04",
  "layer_05_tmp1",
  "layer_05_tmp2",
  "layer_05",
  "layer_05_cc_gated",
];

// Exported so a caller looping runPipeline over many groups (Edge Matcher)
// can free the last iteration's scratch tables once the loop ends, not just
// at the top of the next call — otherwise they linger through whatever
// memory-heavy step runs after the loop (e.g. a final whole-batch
// CoverageClean + GeoJSON export), right when peak memory matters most.
export async function dropInternalTables(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of INTERNAL_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

export interface PipelineResult {
  geojson: string;
  changedGeoJSON: string;
  bounds: [number, number, number, number] | null;
}

export async function getOriginalGeojson(conn: AsyncDuckDBConnection): Promise<string> {
  return tableToGeoJSON(conn, "layer_01", null);
}

async function runValidation(
  conn: AsyncDuckDBConnection,
  finalTable: string,
  origTable: string,
): Promise<void> {
  // Each check is wrapped independently so a single failure (e.g. ST_Union_Agg
  // in the gap check OOMing on a huge result) doesn't abort the others.
  try {
    if (await hasInvalidEdges(conn, finalTable)) console.warn(`OVERLAPS in ${finalTable}`);
  } catch (e) {
    console.warn("overlap check failed:", e);
  }

  try {
    await buildGapTable(conn, "ee_validate_gaps", finalTable);
    const r = await conn.query("SELECT COUNT(*) AS n FROM ee_validate_gaps");
    const n = Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
    if (n > 0) console.warn(`GAPS in ${finalTable}: ${n} regions`);
  } catch (e) {
    console.warn("gap check failed:", e);
  } finally {
    await conn.query("DROP TABLE IF EXISTS ee_validate_gaps");
  }

  try {
    if (await hasMicroPolygons(conn, finalTable)) console.warn(`MICRO-POLYGONS in ${finalTable}`);
  } catch (e) {
    console.warn("micro-polygon check failed:", e);
  }

  try {
    const [a, b] = await Promise.all([
      conn.query(`SELECT COUNT(*) AS n FROM ${finalTable}`),
      conn.query(`SELECT COUNT(*) AS n FROM ${origTable}`),
    ]);
    const na = Number((a.toArray()[0] as { n: bigint | number }).n);
    const nb = Number((b.toArray()[0] as { n: bigint | number }).n);
    if (na !== nb) console.warn(`ROW MISMATCH: ${finalTable}=${na} vs ${origTable}=${nb}`);
  } catch (e) {
    console.warn("row count check failed:", e);
  }
}

export interface RunPipelineOptions {
  // Edge Matcher calls runPipeline once per group, then clips and
  // accumulates every group's output into one final assembled result before
  // running its own single gatedCoverageClean pass over the whole batch —
  // cleaning per-group here as well would just be redundant middle-of-the-
  // pipeline cleaning of geometry that gets reshaped again before the real
  // final output exists. Plain Edge Extender (a single, non-looped
  // runPipeline call) leaves this false: layer_05 genuinely is (one of) its
  // final outputs, so cleaning here is cleaning at the end, not the middle.
  skipOutputClean?: boolean;
  // Edge Matcher already closed the whole input's notches and cleaned it with the any-hole trigger.
  skipInputHoleCheck?: boolean;
  maxPoints?: number;
}

export async function runPipeline(
  conn: AsyncDuckDBConnection,
  onProgress: ProgressFn,
  {
    skipOutputClean = false,
    skipInputHoleCheck = false,
    maxPoints = MAX_POINTS,
  }: RunPipelineOptions = {},
): Promise<PipelineResult> {
  // Defensive sweep in case a prior run in this session left tables behind
  // (e.g. an Edge Matcher loop iterating over multiple groups).
  await dropInternalTables(conn);

  // Repair input coverage violations (overlaps/gaps) before the algorithm runs
  // — Voronoi generation assumes a clean starting coverage. No-op, and no
  // progress update, when the input already has no invalid edges.
  console.log("[EE-DEBUG] === stageCleanInput ===");
  await stageCleanInput(conn, !skipInputHoleCheck, !skipInputHoleCheck);

  // Stage 2: lines (single attempt; _02a is stable across retries)
  console.log("[EE-DEBUG] === stageLines ===");
  onProgress(2, "Extracting boundary lines");
  await stageLines(conn);

  // Segments are distance-independent — build once, reuse across every retry attempt below.
  console.log("[EE-DEBUG] === buildSegments ===");
  await buildSegments(conn);

  // Stages 3+4: points → MAX_POINTS check → voronoi, retry with doubling.
  // A distance estimated over the limit is skipped unbuilt.
  let succeeded = false;
  let skipped = 0;
  let lastFailedStage = "";
  let lastDistance: number;
  try {
    const startDistance = await computeEffectiveDistance(conn);
    lastDistance = startDistance;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const d = startDistance * Math.pow(2, i);
      lastDistance = d;
      const estimate = await estimateCount(conn, d);
      if (estimate > maxPoints) {
        console.info(`skip: distance=${d}, about ${estimate.toLocaleString()} points estimated`);
        skipped++;
        continue;
      }
      let inVoronoi = false;
      try {
        console.log(`[EE-DEBUG] === stagePoints (attempt ${i + 1}, distance=${d}) ===`);
        onProgress(
          3,
          !lastFailedStage
            ? "Interpolating points"
            : `Interpolating points (retry ${i}, distance=${d.toFixed(6)}, ${lastFailedStage} failed)`,
        );
        await stagePoints(conn, d);

        const cnt = Number(
          (await conn.query("SELECT COUNT(*) AS n FROM layer_03b")).toArray()[0].n,
        );
        if (cnt > maxPoints) throw new Error(`too many points: ${cnt.toLocaleString()}`);

        inVoronoi = true;
        console.log(`[EE-DEBUG] === stageVoronoi (attempt ${i + 1}, distance=${d}) ===`);
        onProgress(4, "Building Voronoi diagram");
        await stageVoronoi(conn);

        succeeded = true;
        break;
      } catch (e) {
        if (e instanceof AssignmentError) {
          throw new PipelineError(`distance=${d}: ${e.message}`, 4);
        }
        lastFailedStage = inVoronoi ? "voronoi" : "points";
        console.warn(`Attempt ${i + 1} failed at ${lastFailedStage} stage (distance=${d}):`, e);
        // Drop only points/voronoi tables; preserve _02a/_02b across retries.
        for (const t of [
          "layer_03a",
          "layer_03b",
          "layer_04_tmp0",
          "layer_04_tmp1",
          "layer_04_tmp2",
          "layer_04",
        ]) {
          await conn.query(`DROP TABLE IF EXISTS ${t}`);
        }
      }
    }
  } finally {
    await conn.query("DROP TABLE IF EXISTS layer_03_tmp1");
  }
  if (skipped === MAX_ATTEMPTS) {
    throw new PipelineError(
      `Failed to generate Voronoi polygons: every distance estimated over ${maxPoints.toLocaleString()} points.`,
      3,
    );
  }
  if (!succeeded) {
    const failedStageNum = lastFailedStage === "voronoi" ? 4 : 3;
    throw new PipelineError(
      `Failed to generate Voronoi polygons after ${MAX_ATTEMPTS} attempts (last distance=${lastDistance.toFixed(6)}). The dataset may be too large or have topology errors.`,
      failedStageNum,
    );
  }

  // Stage 5: merge
  console.log("[EE-DEBUG] === stageMerge ===");
  onProgress(5, "Merging polygons");
  await stageMerge(conn);
  console.log("[EE-DEBUG] === stageMerge done, runPipeline continuing ===");

  await checkNoErosion(conn, "layer_01", "layer_05");

  if (!skipOutputClean) {
    console.log("[EE-DEBUG] === stageOutputClean ===");
    await gatedCoverageClean(conn, "layer_05");
  }

  // Topology validation (warn-only)
  await runValidation(conn, "layer_05", "layer_01");

  // Bounds for map fit
  let bounds: [number, number, number, number] | null = null;
  try {
    const bboxResult = await conn.query(`--sql
      SELECT
        MIN(ST_XMin(geom)) AS xmin,
        MIN(ST_YMin(geom)) AS ymin,
        MAX(ST_XMax(geom)) AS xmax,
        MAX(ST_YMax(geom)) AS ymax
      FROM layer_05
      WHERE geom IS NOT NULL
    `);
    const row = bboxResult.toArray()[0] as Record<string, number>;
    const { xmin, ymin, xmax, ymax } = row;
    if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
      bounds = [xmin, ymin, xmax, ymax];
    }
  } catch {
    // bounds stays null
  }

  const geojson = await tableToGeoJSON(conn, "layer_05", "layer_attr");
  const changed = await changedGeoJSON(conn, "layer_05", "layer_01");

  return { geojson, changedGeoJSON: changed, bounds };
}
