import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  buildGapTable,
  checkNoOverlaps,
  dropGapsOutsideTargets,
  mergeMicroPolygons,
} from "$lib/db/coverage";
import { coverageCleanRows } from "$lib/db/coverageClean";
import { gapIssuesSql } from "$lib/db/issues";
import { invalidEdgeIssues } from "$lib/db/invalidEdges";
import { queryToGeoJSON, tableToGeoJSON } from "$lib/db/geojson";
import { detectColumns, type ColumnGuess } from "$lib/db/columns";
import {
  CODE_FALLBACK_REASON,
  CODE_MISMATCH_REASON,
  type MatchColumnOptions,
} from "$lib/db/codeJoin";
import { setCentroidLat } from "$lib/db/units";
import { CLIP_EMPTY_REASON } from "$lib/db/assignOne";
import { dropInternalTables } from "$lib/tools/edge-extend/pipeline/index";
import { loadLayers } from "./load";
import { computeAssignment, type MatchMode } from "./assign";
import {
  clipGroups,
  listGroups,
  PASSTHROUGH_OVERLAY_FID,
  runGroups,
  type GroupInfo,
  type GroupResult,
} from "./groups";

export type EdgeMatchPhase =
  | { phase: "loading" }
  | { phase: "assigning" }
  | {
      phase: "groups-listed";
      groups: GroupInfo[];
      // Input features with the group_id they're assigned to (null when unassigned).
      inputGeojson: string;
      overlayOutlineGeojson: string;
      bounds: [number, number, number, number] | null;
    }
  | {
      phase: "group-stage";
      groupIndex: number;
      groupTotal: number;
      group: GroupInfo;
      stage: number;
      stageLabel: string;
    }
  | { phase: "group-done"; groupIndex: number; groupTotal: number; result: GroupResult }
  | { phase: "clipping" }
  | { phase: "cleaning" };

export type EdgeMatchProgressFn = (event: EdgeMatchPhase) => void;

export interface EdgeMatchResult {
  geojson: string;
  bounds: [number, number, number, number] | null;
  groupResults: GroupResult[];
  unassignedCount: number;
  droppedCount: number;
  passthroughCount: number;
  codeMismatchCount: number;
  codeFallbackCount: number;
  microCount: number;
  gapCount: number;
  invalidEdgeCount: number;
  clipEmptyCount: number;
  detachedMergedCount: number;
  detachedKeptCount: number;
  // Assign-one only: the winner overlay feature's label.
  assignedOverlayLabel: string | null;
  mode: "one" | "many";
  inputColumns: ColumnGuess;
  overlayColumns: ColumnGuess;
  // Overlay layer outline with `fid`, a reference layer over the per-group colored result.
  overlayOutlineGeojson: string;
}

// Combines every excluded/flagged input feature (unassigned, dropped-group, and
// code-mismatch/code-fallback per docs/adr/0045) into one exportable table.
async function buildIssuesTable(conn: AsyncDuckDBConnection): Promise<{
  dropped: number;
  passthrough: number;
  clipEmpty: number;
  detachedMerged: number;
  detachedKept: number;
}> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_issues AS
    SELECT 'unassigned-' || fid AS key, 'unassigned' AS kind,
           fid AS unit_a, NULL::BIGINT AS unit_b, NULL::BIGINT AS overlay_fid,
           NULL::VARCHAR AS reason, NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m,
           NULL::DOUBLE AS thinness_ratio, NULL::BOOLEAN AS fixed, geom
    FROM ge_unassigned
    WHERE fid NOT IN (SELECT input_fid FROM ge_assignment)
    UNION ALL
    SELECT 'dropped_group-' || unit_a AS key, 'dropped_group' AS kind,
           unit_a, NULL, overlay_fid AS overlay_fid, reason, NULL, NULL, NULL, NULL, geom
    FROM ge_dropped
    UNION ALL
    SELECT 'passthrough-' || ga.input_fid AS key, 'passthrough' AS kind,
           ga.input_fid AS unit_a, NULL, ga.overlay_fid AS overlay_fid, NULL::VARCHAR AS reason, NULL, NULL, NULL, NULL, c.geom
    FROM ge_assignment ga JOIN input_layer_01 c ON c.fid = ga.input_fid
    WHERE ga.overlay_fid = ${PASSTHROUGH_OVERLAY_FID} AND ga.input_fid IN (SELECT fid FROM ge_results)
    UNION ALL
    SELECT 'code_mismatch-' || a.input_fid AS key, 'code-mismatch' AS kind,
           a.input_fid AS unit_a, NULL, a.overlay_fid AS overlay_fid, '${CODE_MISMATCH_REASON}' AS reason, NULL, NULL, NULL, NULL, c.geom
    FROM ge_assignment a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.assignment_method = 'code' AND a.spatial_agrees = FALSE
    UNION ALL
    SELECT 'code_fallback-' || a.input_fid AS key, 'code-fallback' AS kind,
           a.input_fid AS unit_a, NULL, a.overlay_fid AS overlay_fid, '${CODE_FALLBACK_REASON}' AS reason, NULL, NULL, NULL, NULL, c.geom
    FROM ge_assignment a JOIN input_layer_01 c ON c.fid = a.input_fid
    WHERE a.assignment_method = 'spatial_fallback'
    UNION ALL
    SELECT 'clip-empty-' || unit_a AS key, 'clip-empty' AS kind,
           unit_a, NULL, overlay_fid, '${CLIP_EMPTY_REASON}' AS reason, NULL, NULL, NULL, NULL, geom
    FROM ge_clip_empty
    UNION ALL
    SELECT key, kind, unit_a, unit_b, overlay_fid, reason, area_m2, max_width_m,
           thinness_ratio, fixed, geom
    FROM ge_detached
  `);
  await conn.query("DROP TABLE IF EXISTS ge_clip_empty");
  const detached = (
    await conn.query(`--sql
      SELECT COUNT(*) FILTER (WHERE fixed) AS merged, COUNT(*) FILTER (WHERE NOT fixed) AS kept
      FROM ge_detached
    `)
  ).toArray()[0] as { merged: bigint | number; kept: bigint | number };
  await conn.query("DROP TABLE IF EXISTS ge_detached");
  const [droppedRes, passthroughRes, clipEmptyRes] = await Promise.all([
    conn.query("SELECT COUNT(*) AS n FROM ge_dropped"),
    conn.query(`SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'passthrough'`),
    conn.query(`SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'clip-empty'`),
  ]);
  return {
    dropped: Number((droppedRes.toArray()[0] as { n: bigint | number }).n),
    passthrough: Number((passthroughRes.toArray()[0] as { n: bigint | number }).n),
    clipEmpty: Number((clipEmptyRes.toArray()[0] as { n: bigint | number }).n),
    detachedMerged: Number(detached.merged),
    detachedKept: Number(detached.kept),
  };
}

// Appends micro-polygon or invalid-edge rows from `table`, if built, to ge_issues.
async function appendIssues(conn: AsyncDuckDBConnection, table: string): Promise<number> {
  const exists = await conn.query(
    `SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name = '${table}'`,
  );
  if (Number((exists.toArray()[0] as { n: bigint | number }).n) === 0) return 0;
  await conn.query(`--sql
    INSERT INTO ge_issues BY NAME
    SELECT key, kind, unit_a, unit_b, reason, area_m2, max_width_m, fixed, geom FROM ${table}
  `);
  const n = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
  await conn.query(`DROP TABLE ${table}`);
  return Number((n.toArray()[0] as { n: bigint | number }).n);
}

// Appends gaps in `coverageSql`'s rows whose interior point lies in a clip target.
async function appendGapIssues(conn: AsyncDuckDBConnection, coverageSql: string): Promise<number> {
  try {
    await conn.query(`CREATE OR REPLACE TABLE ge_coverage AS ${coverageSql}`);
    await buildGapTable(conn, "ge_gap_regions", "ge_coverage");
    await dropGapsOutsideTargets(
      conn,
      "ge_gap_regions",
      `SELECT geom FROM overlay_layer_01 WHERE fid IN (
         SELECT overlay_fid FROM ge_assignment WHERE overlay_fid <> ${PASSTHROUGH_OVERLAY_FID})`,
    );
    await conn.query(`--sql
      INSERT INTO ge_issues BY NAME
      SELECT key, kind, reason, area_m2, max_width_m, thinness_ratio, fixed, geom
      FROM (${gapIssuesSql("ge_gap_regions")})
    `);
    const r = await conn.query("SELECT COUNT(*) AS n FROM ge_issues WHERE kind = 'gap'");
    return Number((r.toArray()[0] as { n: bigint | number }).n);
  } finally {
    await conn.query("DROP TABLE IF EXISTS ge_gap_regions");
    await conn.query("DROP TABLE IF EXISTS ge_coverage");
  }
}

async function buildResultsAttrTable(conn: AsyncDuckDBConnection): Promise<void> {
  const overlayDesc = await conn.query("DESCRIBE overlay_layer_attr");
  const overlayCols = (overlayDesc.toArray() as Array<{ column_name: string }>)
    .map((r) => r.column_name)
    .filter((c) => c !== "fid");
  // Overlay feature attribute columns are prefixed to avoid silently colliding with
  // (and shadowing) an input-layer column of the same name in the SELECT *.
  const overlayExprs = overlayCols.map(
    (c) => `ca.${JSON.stringify(c)} AS ${JSON.stringify(`overlay_${c}`)}`,
  );
  const overlaySelect = overlayExprs.length > 0 ? ", " + overlayExprs.join(", ") : "";

  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_results_attr AS
    SELECT fa.*, ga.overlay_fid AS group_id${overlaySelect}
    FROM input_layer_attr fa
    JOIN ge_assignment ga ON ga.input_fid = fa.fid
    LEFT JOIN overlay_layer_attr ca ON ca.fid = ga.overlay_fid
  `);
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
  table = "ge_results",
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM ${table} WHERE geom IS NOT NULL
    `);
    const row = r.toArray()[0] as Record<string, number>;
    const { xmin, ymin, xmax, ymax } = row;
    if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // bounds stays null
  }
  return null;
}

export async function runEdgeMatch(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  inputFiles: File[],
  overlayFiles: File[],
  onProgress: EdgeMatchProgressFn,
  matchColumns: MatchColumnOptions = {},
  passthrough = false,
  mode: MatchMode = "one",
  clean = true,
): Promise<EdgeMatchResult> {
  onProgress({ phase: "loading" });
  await loadLayers(db, conn, inputFiles, overlayFiles);
  await checkNoOverlaps(conn, "overlay_layer_01");
  const overlayOutlineGeojson = await queryToGeoJSON(
    conn,
    "SELECT ST_AsGeoJSON(geom) AS _geom, fid FROM overlay_layer_01 WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)",
  );

  const inputBounds = await computeBounds(conn, "input_layer_01");
  if (inputBounds) setCentroidLat((inputBounds[1] + inputBounds[3]) / 2);

  onProgress({ phase: "assigning" });
  const assignment = await computeAssignment(conn, matchColumns, passthrough, mode);
  const inputGeojson = await queryToGeoJSON(
    conn,
    `SELECT ST_AsGeoJSON(i.geom) AS _geom, ga.overlay_fid AS group_id FROM input_layer_01 i
     LEFT JOIN ge_assignment ga ON ga.input_fid = i.fid
     WHERE i.geom IS NOT NULL AND NOT ST_IsEmpty(i.geom)`,
  );

  const nameGuess = await detectColumns(conn, "overlay_layer_attr");
  const inputColumns = await detectColumns(conn, "input_layer_attr");
  const overlayColumns = nameGuess;
  const groups = await listGroups(conn, nameGuess.name);
  onProgress({
    phase: "groups-listed",
    groups,
    inputGeojson,
    overlayOutlineGeojson,
    bounds: await computeBounds(conn, "overlay_layer_01"),
  });
  // ge_groups only exists to build the groups list above — nothing later
  // reads it.
  await conn.query("DROP TABLE IF EXISTS ge_groups");

  const groupResults = await runGroups(
    conn,
    groups,
    (groupIndex, groupTotal, group, stage, stageLabel) =>
      onProgress({ phase: "group-stage", groupIndex, groupTotal, group, stage, stageLabel }),
    (groupIndex, groupTotal, result) =>
      onProgress({ phase: "group-done", groupIndex, groupTotal, result }),
  );
  onProgress({ phase: "clipping" });
  await clipGroups(conn);
  // The orphan group is kept unclipped, overlapping neighbours by design.
  const coverageWhere = `fid NOT IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${PASSTHROUGH_OVERLAY_FID})`;
  await conn.query("DROP TABLE IF EXISTS ge_micro");
  if (clean) {
    onProgress({ phase: "cleaning" });
    await coverageCleanRows(conn, "ge_results", coverageWhere, "ge_micro");
  } else {
    await mergeMicroPolygons(conn, "ge_results", "ge_results", "ge_micro");
  }
  await invalidEdgeIssues(conn, "ge_results", "ge_invalid", coverageWhere);

  const {
    dropped: droppedCount,
    passthrough: passthroughCount,
    clipEmpty: clipEmptyCount,
    detachedMerged: detachedMergedCount,
    detachedKept: detachedKeptCount,
  } = await buildIssuesTable(conn);
  const microCount = await appendIssues(conn, "ge_micro");
  const invalidEdgeCount = await appendIssues(conn, "ge_invalid");
  let gapCount = 0;
  if (clean) {
    try {
      gapCount = await appendGapIssues(conn, `SELECT fid, geom FROM ge_results WHERE ${coverageWhere}`);
    } catch (e) {
      console.warn("gap issues failed:", e);
    }
  }
  const assignedOverlayLabel =
    groups.find((g) => g.overlayFid === assignment.overlayFid)?.label ?? null;

  // A group OOM above leaves the connection poisoned for the rest of the
  // session, so attribute enrichment below may also throw. It's a
  // nice-to-have — fall back to a geometry-only export rather than losing
  // every already-computed group to a downstream error.
  let hasAttrTable = false;
  try {
    // The last group's scratch tables are only cleaned at the *start* of the
    // next runPipeline call, and there is no next call after the loop ends —
    // free them now, before the two heaviest remaining steps.
    await dropInternalTables(conn);

    await buildResultsAttrTable(conn);

    // input_layer_attr/ge_unassigned/ge_dropped/ge_issues are deliberately
    // NOT dropped here: DownloadMenu's "unassigned"/"issues" exports read
    // them live, on demand, which can happen well after this function
    // returns.
    await conn.query("DROP TABLE IF EXISTS input_layer_01");
    await conn.query("DROP TABLE IF EXISTS overlay_layer_01");
    await conn.query("DROP TABLE IF EXISTS overlay_layer_attr");
    await conn.query("DROP TABLE IF EXISTS ge_assignment");
    hasAttrTable = true;
  } catch (e) {
    console.warn("Attribute join/scratch cleanup failed, falling back to geometry-only export:", e);
  }
  const attrTable = hasAttrTable ? "ge_results_attr" : null;

  const geojson = await tableToGeoJSON(conn, "ge_results", attrTable);
  const bounds = await computeBounds(conn);

  return {
    geojson,
    bounds,
    groupResults,
    unassignedCount: assignment.unassignedCount,
    droppedCount,
    passthroughCount,
    codeMismatchCount: assignment.codeMismatchCount,
    codeFallbackCount: assignment.codeFallbackCount,
    microCount,
    gapCount,
    invalidEdgeCount,
    clipEmptyCount,
    detachedMergedCount,
    detachedKeptCount,
    assignedOverlayLabel,
    mode: assignment.mode,
    inputColumns,
    overlayColumns,
    overlayOutlineGeojson,
  };
}
