import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { hasInvalidEdges } from "$lib/db/invalidEdges";
import { tableToGeoJSON } from "$lib/db/geojson";
import {
  assembleIssues,
  buildGapRegions,
  buildMicroRegions,
  buildNotchRegions,
  buildOverlapRegions,
  type IssueKind,
  type IssueRow,
} from "$lib/db/issues";
import { setCentroidLat } from "$lib/db/units";
import { layerBounds } from "$lib/db/layerView";

export type { IssueKind, IssueRow } from "$lib/db/issues";

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

export interface DetectResult {
  originalGeoJSON: string;
  bounds: [number, number, number, number] | null;
  issues: IssueRow[];
  issuesGeoJSON: string;
  // Kinds whose detection query failed (even after retry) and was degraded to
  // an empty table — a 0 count for these means "couldn't check," not "clean."
  failedKinds: Set<IssueKind>;
}

export async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  const bounds = await layerBounds(conn).catch(() => null);
  if (bounds) setCentroidLat((bounds[1] + bounds[3]) / 2);
  return bounds;
}

// Read-only scan of layer_01 for gap/overlap/micro-polygon/notch defects; detect never modifies
// geometry, it only reports (see docs/reference/topo-detect.md). Overlap detection
// is skipped (reported as zero) whenever the input already has no coverage
// violations, matching topo-clean's own has-violations pre-check.
export async function runDetect(
  conn: AsyncDuckDBConnection,
  onProgress: ProgressFn,
): Promise<DetectResult> {
  onProgress(2, "Loading input");
  const bounds = await computeBounds(conn);
  const originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);

  onProgress(3, "Finding gaps & overlaps");
  const scan = await scanTopology(conn, () => onProgress(4, "Assembling issues report"));
  return { originalGeoJSON, bounds, ...scan };
}

// Writes dt_issues: layer_01's gap, overlap, micro-polygon and notch regions.
export async function scanTopology(
  conn: AsyncDuckDBConnection,
  onAssemble: () => void = () => {},
): Promise<Pick<DetectResult, "issues" | "issuesGeoJSON" | "failedKinds">> {
  const hasViolations = await hasInvalidEdges(conn, "layer_01");
  const gapOk = await buildGapRegions(conn, "dt_gap_regions", "layer_01");
  const overlapOk = await buildOverlapRegions(
    conn,
    "dt_overlap_regions",
    "layer_01",
    hasViolations,
  );
  const microOk = await buildMicroRegions(conn, "dt_micro_regions", "layer_01");
  const notchOk = await buildNotchRegions(conn, "dt_notch_regions", "layer_01");
  const failedKinds = new Set<IssueKind>();
  if (!gapOk) failedKinds.add("gap");
  if (!overlapOk) failedKinds.add("overlap");
  if (!microOk) failedKinds.add("micro-polygon");
  if (!notchOk) failedKinds.add("notch");

  onAssemble();
  try {
    const {
      rows,
      geojson,
      failedKinds: finalFailedKinds,
    } = await assembleIssues(
      conn,
      {
        issuesTable: "dt_issues",
        gapRegionsTable: "dt_gap_regions",
        overlapRegionsTable: "dt_overlap_regions",
        microRegionsTable: "dt_micro_regions",
        notchRegionsTable: "dt_notch_regions",
      },
      failedKinds,
    );
    return {
      issues: rows,
      issuesGeoJSON: geojson,
      failedKinds: finalFailedKinds,
    };
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }
}
