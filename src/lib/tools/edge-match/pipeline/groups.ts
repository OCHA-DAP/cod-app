import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { PipelineError, runPipeline } from "$lib/tools/edge-extend/pipeline/index";
import { clipEngine } from "$lib/db/clipEngine";
import { emptyDetachedIssues, mergeDetachedParts } from "$lib/db/coverage";
import { queryToGeoJSON } from "$lib/db/geojson";
import { buildTiles } from "$lib/db/clipTiles";

// Sentinel overlay_fid for the orphan passthrough pseudo-group (ported from
// topo-tools' PASSTHROUGH_OVERLAY_FID).
export const PASSTHROUGH_OVERLAY_FID = -1;

export interface GroupInfo {
  overlayFid: number;
  inputCount: number;
  label: string;
}

export interface GroupResult extends GroupInfo {
  status: "done" | "error";
  // This group's extended rows, colored by group_id like the final output.
  geojson?: string;
  error?: string;
  failedStage?: number;
}

export type GroupStageFn = (
  groupIndex: number,
  groupTotal: number,
  group: GroupInfo,
  stage: number,
  stageLabel: string,
) => void;

export type GroupDoneFn = (groupIndex: number, groupTotal: number, result: GroupResult) => void;

// Map preview only, so a failure leaves the group done without one. Clipped for display,
// since the real clip runs after every group.
async function groupGeoJSON(
  conn: AsyncDuckDBConnection,
  overlayFid: number,
): Promise<string | undefined> {
  const geom =
    overlayFid === PASSTHROUGH_OVERLAY_FID
      ? "e.geom"
      : `ST_Intersection(e.geom, (SELECT geom FROM overlay_layer_01 WHERE fid = ${overlayFid}))`;
  try {
    return await queryToGeoJSON(
      conn,
      `SELECT ST_AsGeoJSON(g) AS _geom, ${overlayFid} AS group_id FROM (
         SELECT ${geom} AS g FROM ge_extended e WHERE e.overlay_fid = ${overlayFid}
       ) WHERE NOT ST_IsEmpty(g)`,
    );
  } catch (e) {
    console.warn("group preview failed:", e);
    return undefined;
  }
}

// One row per non-empty group, joined against an optional human-readable
// label column on the overlay layer (see detectColumns in $lib/db/columns).
export async function listGroups(
  conn: AsyncDuckDBConnection,
  nameColumn: string | null,
): Promise<GroupInfo[]> {
  const nameExpr = nameColumn
    ? `CAST(a.${JSON.stringify(nameColumn)} AS VARCHAR)`
    : "NULL::VARCHAR";
  const rows = await conn.query(`--sql
    SELECT g.overlay_fid AS overlay_fid, g.input_count AS input_count, ${nameExpr} AS name
    FROM ge_groups g
    LEFT JOIN overlay_layer_attr a ON a.fid = g.overlay_fid
    ORDER BY (g.overlay_fid = ${PASSTHROUGH_OVERLAY_FID}), g.overlay_fid
  `);
  return (
    rows.toArray() as Array<{
      overlay_fid: bigint | number;
      input_count: bigint | number;
      name: string | null;
    }>
  ).map((r) => {
    const overlayFid = Number(r.overlay_fid);
    return {
      overlayFid,
      inputCount: Number(r.input_count),
      label:
        overlayFid === PASSTHROUGH_OVERLAY_FID
          ? "Input polygons outside the overlay"
          : r.name
            ? `${r.name} (fid ${overlayFid})`
            : `Group ${overlayFid}`,
    };
  });
}

// Runs edge-extend's pipeline once per group into ge_extended; a failing group
// is recorded in ge_dropped and skipped, so one bad group doesn't block the rest.
export async function runGroups(
  conn: AsyncDuckDBConnection,
  groups: GroupInfo[],
  onStage: GroupStageFn,
  onDone: GroupDoneFn,
): Promise<GroupResult[]> {
  await conn.query("CREATE OR REPLACE TABLE ge_results (fid BIGINT, geom GEOMETRY)");
  await conn.query(
    "CREATE OR REPLACE TABLE ge_dropped (unit_a BIGINT, overlay_fid BIGINT, reason VARCHAR, geom GEOMETRY)",
  );
  await conn.query(
    "CREATE OR REPLACE TABLE ge_extended (fid BIGINT, overlay_fid BIGINT, geom GEOMETRY)",
  );
  const results: GroupResult[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let result: GroupResult;
    console.log(`[EE-DEBUG] ##### GROUP START: ${group.label} (${i + 1}/${groups.length}) #####`);
    try {
      console.log("[EE-DEBUG] group:1 populate layer_01/layer_attr");
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_01 AS
        SELECT fid, geom FROM input_layer_01
        WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
      `);
      await conn.query(`--sql
        CREATE OR REPLACE TABLE layer_attr AS
        SELECT * FROM input_layer_attr
        WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
      `);

      await runPipeline(
        conn,
        (stage, stageLabel) => onStage(i, groups.length, group, stage, stageLabel),
        { skipOutputClean: true, skipInputHoleCheck: true },
      );

      await conn.query(`--sql
        INSERT INTO ge_extended
        SELECT fid, ${group.overlayFid}, geom FROM layer_05 WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      `);

      console.log(`[EE-DEBUG] ##### GROUP DONE (success): ${group.label} #####`);
      result = { ...group, status: "done", geojson: await groupGeoJSON(conn, group.overlayFid) };
    } catch (e) {
      console.log(
        `[EE-DEBUG] ##### GROUP DONE (error): ${group.label}: ${e instanceof Error ? e.message : String(e)} #####`,
      );
      const msg = e instanceof Error ? e.message : String(e);
      const failedStage = e instanceof PipelineError ? e.failedStage : undefined;
      result = { ...group, status: "error", error: msg, failedStage };
      // Record this group's input features as dropped, for the downstream issues
      // export. Reads from input_layer_01 filtered by ge_assignment (not the
      // group's own scratch layer_01) so it works even if the group failed
      // before layer_01 was fully built. Best-effort: a failure here
      // shouldn't abort the batch over a nice-to-have.
      try {
        const escapedMsg = msg.replace(/'/g, "''");
        await conn.query(`--sql
          INSERT INTO ge_dropped
          SELECT fid AS unit_a, ${group.overlayFid} AS overlay_fid,
                 '${escapedMsg}' AS reason, geom
          FROM input_layer_01
          WHERE fid IN (SELECT input_fid FROM ge_assignment WHERE overlay_fid = ${group.overlayFid})
        `);
      } catch (recordError) {
        console.warn(`Failed to record dropped group ${group.label}:`, recordError);
      }
    } finally {
      // If the group above failed because the connection is OOM-poisoned,
      // these cleanup queries fail too — and since that throw would otherwise
      // escape this finally block, it replaces the already-caught error above
      // and aborts the whole loop instead of recording one failed group and
      // continuing (WASM linear memory can't recover mid-session either way).
      try {
        await conn.query("DROP TABLE IF EXISTS layer_01");
        await conn.query("DROP TABLE IF EXISTS layer_attr");
        await conn.query("DROP TABLE IF EXISTS layer_05");
      } catch (cleanupError) {
        console.warn(`Cleanup after group ${group.label} failed:`, cleanupError);
      }
    }
    results.push(result);
    onDone(i, groups.length, result);
  }

  return results;
}

// Clips every extended group to its own overlay polygon, then merges clip-detached
// pieces per group.
export async function clipGroups(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query(
    "CREATE OR REPLACE TABLE ge_clip_empty (unit_a BIGINT, overlay_fid BIGINT, geom GEOMETRY)",
  );
  await emptyDetachedIssues(conn, "ge_detached");
  // The orphan passthrough group has no overlay boundary, so it stays unclipped.
  await conn.query(`--sql
    INSERT INTO ge_results SELECT fid, geom FROM ge_extended WHERE overlay_fid = ${PASSTHROUGH_OVERLAY_FID}
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ge_clip_in AS
    SELECT * FROM ge_extended WHERE overlay_fid <> ${PASSTHROUGH_OVERLAY_FID}
  `);
  const fids = (await conn.query("SELECT DISTINCT overlay_fid FROM ge_clip_in ORDER BY 1"))
    .toArray()
    .map((r) => Number((r as { overlay_fid: bigint | number }).overlay_fid));
  if (fids.length > 0) {
    await conn.query("DROP TABLE IF EXISTS ge_tiles");
    await buildTiles(conn, "overlay_layer_01", "SELECT overlay_fid FROM ge_clip_in", "ge_tiles");
    await clipEngine(conn, "ge_clip_in", "ge_tiles", "ge_clip");
    await conn.query(`--sql
      INSERT INTO ge_clip_empty
      SELECT d.fid, d.overlay_fid, d.geom FROM ge_clip_dropped d
    `);
  }
  for (const g of fids) {
    const preClipSql = `SELECT fid, geom FROM ge_extended WHERE overlay_fid = ${g}`;
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ge_group_clip AS
      SELECT fid, geom FROM ge_clip WHERE fid IN (SELECT fid FROM (${preClipSql}))
    `);
    await mergeDetachedParts(conn, "ge_group_clip", "ge_group_clip", {
      preClipSql,
      overlaySql: `SELECT geom FROM overlay_layer_01 WHERE fid = ${g}`,
      overlayFid: g,
      originalTable: "input_layer_01",
      issuesTable: "ge_group_detached",
    });
    await conn.query("INSERT INTO ge_detached SELECT * FROM ge_group_detached");
    await conn.query(`--sql
      INSERT INTO ge_results
      SELECT fid, geom FROM ge_group_clip WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `);
  }
  for (const t of ["ge_extended", "ge_clip_in", "ge_tiles", "ge_clip", "ge_clip_dropped", "ge_group_clip", "ge_group_detached"]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
}
