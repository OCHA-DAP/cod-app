import { beforeAll, expect, test } from "vitest";
import { runPipeline, type PipelineOptions, type TableRow } from "$lib/tools/change/pipeline";
import { detectUnitColumns } from "$lib/tools/change/pipeline/columns";
import { db, ready, write } from "./helpers";

// Nine spatially separated regions, one relationship class (or pair) each.
const OLD: [string, string][] = [
  ["U1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  ["N1", "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  ["M1", "POLYGON((20 0, 21 0, 21 1, 20 1, 20 0))"],
  ["SP1", "POLYGON((30 0, 33 0, 33 1, 30 1, 30 0))"],
  ["MG1", "POLYGON((40 0, 41 0, 41 1, 40 1, 40 0))"],
  ["MG2", "POLYGON((41 0, 43 0, 43 1, 41 1, 41 0))"],
  ["RM1", "POLYGON((60 0, 61 0, 61 1, 60 1, 60 0))"],
  ["RL1", "POLYGON((70 0, 71 0, 71 1, 70 1, 70 0))"],
  ["GD1", "POLYGON((90 0, 93 0, 93 1, 90 1, 90 0))"],
];
const NEW: [string, string][] = [
  ["U1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  ["N1B", "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  ["M1", "POLYGON((20 0, 21 0, 21 0.9, 20 0.9, 20 0))"],
  ["SP1", "POLYGON((30 0, 31 0, 31 1, 30 1, 30 0))"],
  ["SP2", "POLYGON((31 0, 33 0, 33 1, 31 1, 31 0))"],
  ["MG1", "POLYGON((40 0, 43 0, 43 1, 40 1, 40 0))"],
  ["CR1", "POLYGON((50 0, 51 0, 51 1, 50 1, 50 0))"],
  ["RL1", "POLYGON((70.9 0, 71.9 0, 71.9 1, 70.9 1, 70.9 0))"],
  ["GD1", "POLYGON((90 0, 91 0, 91 1, 90 1, 90 0))"],
  ["GD2", "POLYGON((91 0, 93 0, 93 1, 91 1, 91 0))"],
];

const DEFAULTS: PipelineOptions = {
  tauMatch: 0.8,
  tauSame: 0.98,
  aCodeCol: [],
  aNameCol: null,
  bCodeCol: [],
  bNameCol: null,
  linkByCode: false,
  linkByName: false,
  linkMode: "either",
};
const CODES: Partial<PipelineOptions> = { aCodeCol: ["pcode"], bCodeCol: ["pcode"] };

beforeAll(async () => {
  await ready();
}, 60_000);

const values = (rs: [string, string][]) =>
  rs.map(([c, w]) => `('${c}', ST_GeomFromText('${w}'))`).join(", ");
const flat = (rs: [string, string][], name: string) =>
  write(`SELECT * FROM (VALUES ${values(rs)}) AS t(pcode, geom)`, name);
// Two-level COD-AB layer: each unit's code under an adm1 parent, plus names.
const hierarchy = (rs: [string, string][], name: string) =>
  write(
    `SELECT 'P' || left(pcode, 1) AS adm1_pcode, 'Region ' || left(pcode, 1) AS adm1_name,
      pcode AS adm2_pcode, 'Town ' || pcode AS adm2_name, geom
    FROM (VALUES ${values(rs)}) AS t(pcode, geom)`,
    name,
  );

async function change(
  opts: Partial<PipelineOptions> = {},
  files = [flat(OLD, "old.parquet"), flat(NEW, "new.parquet")],
) {
  const [a, b] = await Promise.all(files);
  const { db: instance, conn } = db();
  return (await runPipeline(instance, conn, [a], [b], { ...DEFAULTS, ...opts }, () => {}))
    .tableRows;
}

const classOf = (rows: TableRow[], a?: string, b?: string) =>
  rows.find((r) => (a === undefined || r.a_code === a) && (b === undefined || r.b_code === b))
    ?.relationship_class ?? null;

test("full run", async () => {
  expect(new Set((await change()).map((r) => r.relationship_class))).toEqual(
    new Set(["unchanged", "modified", "split", "merge", "created", "removed"]),
  );
});

test("tau_match threshold", async () => {
  const strict = await change(CODES);
  expect(classOf(strict, "RL1")).toBe("removed");
  expect(classOf(strict, undefined, "RL1")).toBe("created");
  expect(classOf(await change({ ...CODES, tauMatch: 0.05 }), "RL1", "RL1")).toBe("modified");
});

test("tau_same threshold", async () => {
  expect(classOf(await change(CODES), "M1")).toBe("modified");
  expect(classOf(await change({ ...CODES, tauSame: 0.5 }), "M1")).toBe("unchanged");
});

test("link by code", async () => {
  const rows = await change({ ...CODES, linkByCode: true });
  expect(classOf(rows, "N1", "N1B")).toBe("renamed");
  expect(classOf(rows, "RL1", "RL1")).toBe("relocated");
});

test("identity-claim guard keeps a genuine split", async () => {
  const rows = await change({ ...CODES, linkByCode: true });
  expect(classOf(rows, "GD1", "GD1")).toBe("split");
  expect(classOf(rows, "GD1", "GD2")).toBe("split");
});

test.each([false, true])(
  "the finest level's columns are detected (link by code %s)",
  async (linkByCode) => {
    const files = [hierarchy(OLD, "old.parquet"), hierarchy(NEW, "new.parquet")];
    const { conn } = db();
    await change({}, files);
    const guess = await detectUnitColumns(conn, "cw_a_layer_attr");
    const cols = {
      aCodeCol: [guess.code!],
      aNameCol: guess.name,
      bCodeCol: [guess.code!],
      bNameCol: guess.name,
    };
    const rows = await change({ ...cols, linkByCode }, files);
    const unchanged = rows.find((r) => r.a_code === "U1");
    expect(unchanged).toMatchObject({
      a_code: "U1",
      a_name: "Town U1",
      b_code: "U1",
      b_name: "Town U1",
    });
    expect(classOf(rows, "N1", "N1B")).toBe(linkByCode ? "renamed" : "unchanged");
  },
);

test("a layer with no admin levels detects no columns", async () => {
  await change({}, [flat(OLD, "old.parquet"), flat(NEW, "new.parquet")]);
  expect(await detectUnitColumns(db().conn, "cw_a_layer_attr")).toEqual({ code: null, name: null });
});

test.todo("name/code field templates pick the levels (the UI's column pickers cover this)");
test.todo("link by code without a detected column raises (UI disables it, no TS counterpart)");
test.todo("CSV changelog starts with a BOM (export shape)");
test.todo("default output paths (file output, no TS counterpart)");
test.todo("invalid output and overlay formats raise (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
