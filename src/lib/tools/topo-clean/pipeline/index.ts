import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { changedGeoJSON, tableToGeoJSON } from "$lib/db/geojson";
import { computeBounds } from "$lib/tools/topo-detect/pipeline/index";
import { buildNotchRegions, readIssues } from "$lib/db/issues";
import { buildClean, buildInput, buildNotched, countRows, inputHasViolations } from "./clean";
import {
  buildGapRegions,
  buildIssues,
  buildOverlapRegions,
  checkFixedIssues,
  measureThinFillM,
  resolveGapFillWidths,
  syncOutputMicroIssues,
  type IssueKind,
  type IssueRow,
} from "./issues";
import { GAP_MAXIMUM_WIDTH_ALL_DEG, metersToDegrees } from "./units";
import { verifyExport, type ExportCheck } from "./verify";

export type { IssueKind, IssueRow } from "./issues";
export { resolveGapFillWidths } from "./issues";
export type { ExportCheck } from "./verify";

export type ProgressFn = (stage: number, label: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
    // Set when detection finished but the clean was rejected, so a reclean can retry it.
    public readonly analysis?: AnalysisResult,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export type GapMode = "minimal" | "thin" | "all" | "manual";

export interface CleanOptions {
  mode: GapMode;
  gapWidthM: number; // Manual mode's width, meters (0 = no gap filling)
}

// All uses the fixed GAP_MAXIMUM_WIDTH_ALL_DEG sentinel, not a width derived from the gaps.
function fillWidthDeg(opts: CleanOptions, issues: IssueRow[]): number {
  if (opts.mode === "all") return GAP_MAXIMUM_WIDTH_ALL_DEG;
  if (opts.mode === "manual") return metersToDegrees(opts.gapWidthM);
  if (opts.mode === "thin") return metersToDegrees(cachedThinFillM);
  return metersToDegrees(resolveGapFillWidths(issues).minimalFillM);
}

export interface AnalysisResult {
  originalGeoJSON: string;
  issues: IssueRow[];
  issuesGeoJSON: string;
  thinFillM: number;
  bounds: [number, number, number, number] | null;
  totalCount: number;
  // Kinds whose detection query failed (even after retry) and was degraded to
  // an empty table — a 0 count for these means "couldn't check," not "clean."
  detectionFailed: Set<IssueKind>;
}

export interface CleanResult extends AnalysisResult {
  cleanedGeoJSON: string;
  modifiedGeoJSON: string;
  collapsedCount: number;
  fixedKeys: Set<string>;
  // Independent validation of the exact table that gets exported (tc_clean),
  // run automatically on every clean/reclean. See verify.ts.
  exportCheck: ExportCheck;
}

export interface RecleanResult {
  cleanedGeoJSON: string;
  modifiedGeoJSON: string;
  collapsedCount: number;
  fixedKeys: Set<string>;
  issues: IssueRow[];
  issuesGeoJSON: string;
  detectionFailed: Set<IssueKind>;
  exportCheck: ExportCheck;
}

// Carried from the full run to cheap re-runs. Gap/overlap detection is static
// (built once per load, independent of the gap-width slider), so the issues
// table, its GeoJSON, and its failure state are all cached here and reused
// as-is by every reclean.
let totalCount = 0;
let cachedIssues: IssueRow[] = [];
let cachedIssuesGeoJSON = "";
let cachedThinFillM = 0;
let cachedFailedKinds = new Set<IssueKind>();
// The clean's source table is static per load, so its violations check (see clean.ts's
// buildClean skip-gate) is computed once in runFromLoaded and reused by every
// reclean instead of re-running ST_CoverageInvalidEdges_Agg on every slider drag.
let cachedHasViolations = true;

// Refreshes the rows that describe tc_clean, and returns the fixed issue keys.
async function syncOutputIssues(conn: AsyncDuckDBConnection): Promise<Set<string>> {
  const synced = await syncOutputMicroIssues(conn, cachedFailedKinds);
  const fixedKeys = await checkFixedIssues(conn, synced.rows, cachedFailedKinds);
  const issuesRes = await readIssues(conn, "tc_issues", cachedFailedKinds);
  cachedIssues = issuesRes.rows;
  cachedIssuesGeoJSON = issuesRes.geojson;
  return fixedKeys;
}

// Re-clean at the current gap-fill mode. Snapping tolerance is runCoverageClean's
// own SNAP_TOLERANCE default. Gap + overlap regions are static (built once per
// load) and are NOT recomputed here; only the rows that describe the output are.
export async function recleanOnly(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult> {
  await buildClean(conn, "tc_clean", fillWidthDeg(opts, cachedIssues), cachedHasViolations);
  const kept = await countRows(conn, "tc_clean");
  const fixedKeys = await syncOutputIssues(conn);
  const exportCheck = await verifyExport(conn);

  return {
    cleanedGeoJSON: await tableToGeoJSON(conn, "tc_clean", "layer_attr"),
    modifiedGeoJSON: await changedGeoJSON(conn, "tc_clean", "layer_01"),
    collapsedCount: Math.max(0, totalCount - kept),
    fixedKeys,
    issues: cachedIssues,
    issuesGeoJSON: cachedIssuesGeoJSON,
    detectionFailed: cachedFailedKinds,
    exportCheck,
  };
}

// Full run from already-loaded layer_01/layer_attr: freeze the input, enumerate
// issues (gaps + overlaps), then clean at the requested gap-fill mode.
export async function runFromLoaded(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
  onProgress: ProgressFn,
): Promise<CleanResult> {
  onProgress(2, "Analyzing coverage");
  const notchOk = await buildNotchRegions(conn, "tc_notch_regions", "layer_01");
  const source = await buildNotched(conn);
  totalCount = await buildInput(conn, source);
  if (totalCount === 0) {
    throw new PipelineError("No polygons found to clean.", 2);
  }
  const inputViolations = await inputHasViolations(conn, "layer_01");
  cachedHasViolations =
    source === "layer_01" ? inputViolations : await inputHasViolations(conn, source);

  const bounds = await computeBounds(conn);
  const originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);

  onProgress(3, "Finding gaps & overlaps");
  // Region tables: gaps + overlaps are a property of the input, built once.
  // Best-effort — failures degrade to an empty region table, never abort the
  // clean (their failure state is recorded instead).
  const gapOk = await buildGapRegions(conn);
  const overlapOk = await buildOverlapRegions(conn, inputViolations);
  const failedKinds = new Set<IssueKind>();
  if (!gapOk) failedKinds.add("gap");
  if (!overlapOk) failedKinds.add("overlap");
  if (!notchOk) failedKinds.add("notch");

  onProgress(4, "Fixing topology");
  // Assemble issues (gap widths via ST_MaximumInscribedCircle), then run a
  // single ST_CoverageClean at the requested mode's gap width.
  try {
    const issuesRes = await buildIssues(conn, failedKinds);
    cachedFailedKinds = issuesRes.failedKinds;
    cachedIssues = issuesRes.rows;
    cachedIssuesGeoJSON = issuesRes.geojson;
    cachedThinFillM = await measureThinFillM(conn, source);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }
  const analysis: AnalysisResult = {
    originalGeoJSON,
    issues: cachedIssues,
    issuesGeoJSON: cachedIssuesGeoJSON,
    thinFillM: cachedThinFillM,
    bounds,
    totalCount,
    detectionFailed: cachedFailedKinds,
  };

  let cleanedGeoJSON: string;
  let modified: string;
  let collapsedCount: number;
  let fixedKeys: Set<string>;
  let exportCheck: ExportCheck;
  try {
    await buildClean(conn, "tc_clean", fillWidthDeg(opts, cachedIssues), cachedHasViolations);

    const kept = await countRows(conn, "tc_clean");
    fixedKeys = await syncOutputIssues(conn);
    exportCheck = await verifyExport(conn);
    cleanedGeoJSON = await tableToGeoJSON(conn, "tc_clean", "layer_attr");
    modified = await changedGeoJSON(conn, "tc_clean", "layer_01");
    collapsedCount = Math.max(0, totalCount - kept);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4, analysis);
  }

  return {
    originalGeoJSON,
    cleanedGeoJSON,
    modifiedGeoJSON: modified,
    issues: cachedIssues,
    issuesGeoJSON: cachedIssuesGeoJSON,
    thinFillM: cachedThinFillM,
    bounds,
    totalCount,
    collapsedCount,
    fixedKeys,
    detectionFailed: cachedFailedKinds,
    exportCheck,
  };
}
