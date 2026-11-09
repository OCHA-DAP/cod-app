import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import { tableToGeoJSON } from "$lib/db/geojson";
import type { ClassifyOptions } from "$lib/tools/change/pipeline/classify";
import {
  buildOutlineGeoJSON,
  buildOverlayGeoJSON,
  computeBounds as computeOverlayBounds,
  stageRender,
} from "$lib/tools/change/pipeline/render";
import { stageTable, type TableRow } from "$lib/tools/change/pipeline/table";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { assignLevel, type ChangeRow } from "./assign";
import { classifyLevel } from "./classify";
import { dissolveLevel } from "./dissolve";
import { resolveSideLevels } from "./levels";
import { buildChangelogTable, writeOutputs } from "./outputs";
import { reparentLevel } from "./reparent";
import { layerBounds } from "$lib/db/layerView";

export type { CodeFormat } from "$lib/db/code";
export { parseMinWidth, resolveCodeFormat } from "$lib/db/code";
export type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
export type { ChangeRow } from "./assign";

export interface CodeUpdateOptions {
  schemaA: TargetSchema | null;
  schemaB: TargetSchema | null;
  rootCode: string | null;
  // null = detect from OLD; "" = codes have no delimiter.
  delimiter: string | null;
  minWidth: string | null;
  codeColumnA: string | null;
  codeColumnB: string | null;
  nameColumnA: string | null;
  nameColumnB: string | null;
  tauMatch: number;
  tauSame: number;
  linkByCode: boolean;
  linkByName: boolean;
  linkMode: "either" | "both";
}

// One level's classification, in the shape `change`'s map and table take.
export interface LevelView {
  level: number;
  overlayGeoJSON: string;
  outlineAGeoJSON: string;
  outlineBGeoJSON: string;
  tableRows: TableRow[];
  bounds: [number, number, number, number] | null;
}

export interface CodeUpdateResult {
  resultGeoJSON: string;
  bounds: [number, number, number, number] | null;
  levelCount: number;
  changelog: ChangeRow[];
  levelViews: LevelView[];
}

async function buildInputTable(conn: AsyncDuckDBConnection, side: "a" | "b"): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cu_${side}_input AS
    SELECT g.fid, g.geom, a.* EXCLUDE (fid)
    FROM cu_${side}_layer_01 g LEFT JOIN ${side === "a" ? "cu_a_layer_attr" : "cu_b_attr"} a ON g.fid = a.fid
  `);
}

const PER_LEVEL_TABLES = (n: number): string[] => [
  `cu_dsl_${n}_a`,
  "cw_a_keyed",
  "cw_b_keyed",
  "cw_pairs",
  "cw_pairs_classified",
  "cw_polygon_class",
  "cw_changelog",
  "cw_overlay_render",
  `cu_reparent_${n}_pairs`,
  `cu_reparent_${n}_assign`,
];

// NEW's codes are written into cu_b_attr, a fresh copy of cu_b_layer_attr per
// run, so a rerun with other settings starts from the loaded NEW layer again.
export async function runCodeUpdate(
  conn: AsyncDuckDBConnection,
  opts: CodeUpdateOptions,
): Promise<CodeUpdateResult> {
  await conn.query("CREATE OR REPLACE TABLE cu_b_attr AS SELECT * FROM cu_b_layer_attr");
  const { sideA, sideB, fmt } = await resolveSideLevels(
    conn,
    "cu_a_layer_attr",
    "cu_b_attr",
    ["cu_a_layer_01", "cu_b_layer_01"],
    opts.schemaA,
    opts.schemaB,
    opts.rootCode,
    opts.delimiter,
    opts.minWidth,
  );

  await buildInputTable(conn, "a");
  await buildInputTable(conn, "b");

  const classifyOpts: ClassifyOptions = {
    tauMatch: opts.tauMatch,
    tauSame: opts.tauSame,
    linkByCode: opts.linkByCode,
    linkByName: opts.linkByName,
    linkMode: opts.linkMode,
  };

  const newCodeByFid = new Map<number, Map<number, string>>();
  const rawValByFid = new Map<number, Map<number, string>>();
  const changelog: ChangeRow[] = [];
  const levelViews: LevelView[] = [];

  const levels = [...sideA.columns.keys()].sort((a, b) => a - b);
  let prevLevel: number | null = null;
  for (const n of levels) {
    await dissolveLevel(conn, "cu_a_input", "cu_b_input", n, sideA, sideB);

    const rawColB = sideB.columns.get(n)!;
    const rawRows = (
      await conn.query(`SELECT fid, ${quoteIdent(rawColB)} AS v FROM cu_dsl_${n}_b`)
    ).toArray() as Array<{ fid: number | bigint; v: string }>;
    const rawMap = new Map<number, string>();
    for (const r of rawRows) rawMap.set(Number(r.fid), r.v);
    rawValByFid.set(n, rawMap);

    await classifyLevel(
      conn,
      n,
      opts.codeColumnA ?? sideA.columns.get(n)!,
      opts.codeColumnB ?? sideB.columns.get(n)!,
      opts.nameColumnA ?? sideA.names.get(n) ?? null,
      opts.nameColumnB ?? sideB.names.get(n) ?? null,
      classifyOpts,
    );

    await stageRender(conn);
    const [overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, levelBounds] = await Promise.all([
      buildOverlayGeoJSON(conn),
      buildOutlineGeoJSON(conn, "a"),
      buildOutlineGeoJSON(conn, "b"),
      stageTable(conn),
      computeOverlayBounds(conn),
    ]);
    levelViews.push({ level: n, overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, bounds: levelBounds });

    if (prevLevel !== null) await reparentLevel(conn, n, prevLevel);

    await assignLevel(conn, n, prevLevel, sideA, sideB, fmt, newCodeByFid, changelog);

    for (const t of PER_LEVEL_TABLES(n)) await conn.query(`DROP TABLE IF EXISTS ${t}`);
    if (prevLevel !== null) await conn.query(`DROP TABLE IF EXISTS cu_dsl_${prevLevel}_b`);
    prevLevel = n;
  }

  await conn.query("DROP TABLE IF EXISTS cu_a_input");
  await conn.query("DROP TABLE IF EXISTS cu_b_input");

  await writeOutputs(conn, "cu_b_attr", sideA, sideB, newCodeByFid, rawValByFid, changelog, fmt);
  if (prevLevel !== null) await conn.query(`DROP TABLE IF EXISTS cu_dsl_${prevLevel}_b`);
  await buildChangelogTable(conn, changelog);

  const resultGeoJSON = await tableToGeoJSON(conn, "cu_b_layer_01", "cu_b_attr");
  const bounds = await layerBounds(conn, "cu_b_layer_01");
  return { resultGeoJSON, bounds, levelCount: levels.length, changelog, levelViews };
}
