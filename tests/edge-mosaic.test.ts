import { beforeAll, expect, test } from "vitest";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { runMosaic } from "$lib/tools/edge-mosaic/pipeline";
import { db, exportColumns, ready, rows, scalar, write } from "./helpers";

// Inputs 1+2 tile Overlay A and win the majority vote, so 3 (Overlay B) and 4 (far) drop.
const INPUT: [number, string][] = [
  [1, "POLYGON((-5 -5, 1.5 -5, 1.5 5, -5 5, -5 -5))"],
  [2, "POLYGON((1.5 -5, 8 -5, 8 5, 1.5 5, 1.5 -5))"],
  [3, "POLYGON((8 -5, 20 -5, 20 20, 8 20, 8 5, 8 -5))"],
  [4, "POLYGON((100 80, 101 80, 101 81, 100 81, 100 80))"],
];
const OVERLAY: [number, string][] = [
  [1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))"],
  [2, "POLYGON((10 0, 13 0, 13 3, 10 3, 10 0))"],
];

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

type Row = [number, string, string?];
const synthetic = (wkt: Row[], name: string) => {
  const code = wkt.some((r) => r[2] !== undefined);
  const values = wkt
    .map(([fid, w, c]) => `(${fid}, ST_GeomFromText('${w}')${code ? `, '${c}'` : ""})`)
    .join(", ");
  return write(`SELECT * FROM (VALUES ${values}) AS t(id, geom${code ? ", pcode" : ""})`, name);
};

// Rows with adm1_pcode/adm1_name codes from id ('C' || id), like topo-tools' tests;
// an id of null gives a null code, and keepId false drops the id column.
const coded = (wkt: [number | null, string][], name: string, keepId = true) => {
  const values = wkt
    .map(([id, w]) => `(${id ?? "NULL::INTEGER"}, ST_GeomFromText('${w}'))`)
    .join(", ");
  return write(
    `SELECT ${keepId ? "id, " : ""}'C' || id AS adm1_pcode, 'N' || id AS adm1_name, geom
    FROM (VALUES ${values}) AS t(id, geom)`,
    name,
  );
};

async function mosaic(
  inputs: Row[] = INPUT,
  overlays: Row[] = OVERLAY,
  opts: {
    columns?: MatchColumnOptions;
    carry?: string[];
    clean?: boolean;
    inputFile?: File;
    overlayFile?: File;
    originalFile?: File;
  } = {},
) {
  const { db: instance } = db();
  const result = await runMosaic(
    instance,
    conn,
    [opts.inputFile ?? (await synthetic(inputs, "input.parquet"))],
    [opts.overlayFile ?? (await synthetic(overlays, "overlay.parquet"))],
    opts.originalFile ? [opts.originalFile] : [],
    () => {},
    opts.columns ?? {},
    opts.carry ?? [],
    opts.clean ?? true,
  );
  const columns = await exportColumns("mosaic");
  const ids = (await rows<{ id: number }>("SELECT id FROM '_export.parquet' ORDER BY id")).map(
    (r) => Number(r.id),
  );
  return { ...result, columns, ids };
}

test("full run", async () => {
  expect((await mosaic()).ids).toEqual([1, 2]);
});

test("the issues record clip-empty inputs", async () => {
  const { issues } = await mosaic();
  expect(issues.map((i) => i.unitA).sort()).toEqual([3, 4]);
  for (const i of issues) {
    expect(i.kind).toBe("clip-empty");
    expect(i.overlayFid).toBe(1);
    expect(i.reason).not.toBeNull();
  }
});

test("no issues when nothing is dropped", async () => {
  expect((await mosaic([INPUT[2]], [OVERLAY[1]])).issues).toEqual([]);
});

test("tolerates an overlay-layer enclave", async () => {
  const r = await mosaic(
    [
      [1, "POLYGON((0 0, 5 0, 5 10, 0 10, 0 0))"],
      [2, "POLYGON((5 0, 10 0, 10 10, 5 10, 5 0))"],
    ],
    [[1, "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0), (4 4, 6 4, 6 6, 4 6, 4 4))"]],
  );
  expect(r.ids).toEqual([1, 2]);
});

test("clip bounds the output to the overlay", async () => {
  await mosaic();
  const area = await scalar<number>(
    "SELECT ST_Area(ST_Union_Agg(geometry)) FROM '_export.parquet' WHERE id IN (1, 2)",
  );
  expect(area).toBeCloseTo(9, 6);
});

test("all unassigned raises", async () => {
  await expect(mosaic([INPUT[3]])).rejects.toThrow(/no input polygon/i);
});

test("a code overrides spatial and reports the mismatch", async () => {
  const r = await mosaic(
    [
      [1, "POLYGON((1 0, 10.5 0, 10.5 1, 3 1, 1 1, 1 0))", "P2"],
      [2, "POLYGON((1 1, 3 1, 3 2, 1 2, 1 1))", "P2"],
    ],
    [
      [1, OVERLAY[0][1], "P1"],
      [2, OVERLAY[1][1], "P2"],
    ],
    { columns: { matchColumn: "pcode" } },
  );
  expect(await scalar<number>("SELECT ST_Area(geometry) FROM '_export.parquet'")).toBeCloseTo(
    0.5,
    6,
  );
  expect(r.issues.map((i) => i.kind).sort()).toEqual([
    "clip-empty",
    "code-mismatch",
    "code-mismatch",
    "gap",
  ]);
});

test("falls back to spatial when the code is unmatched", async () => {
  const r = await mosaic(
    [[1, "POLYGON((0.5 0.5, 1 0.5, 1 1, 0.5 1, 0.5 0.5))", "NOPE"]],
    [[1, OVERLAY[0][1], "P1"]],
    { columns: { matchColumn: "pcode" } },
  );
  expect(r.issues.map((i) => i.kind).sort()).toEqual(["code-fallback", "gap"]);
});

test("merge columns populate the output", async () => {
  const r = await mosaic([INPUT[0]], [[1, OVERLAY[0][1], "P1"]], { carry: ["pcode"] });
  expect(r.columns).toContain("pcode");
  expect(await scalar("SELECT pcode FROM '_export.parquet'")).toBe("P1");
});

test("raises on an overlapping overlay", async () => {
  await expect(
    mosaic(INPUT, [OVERLAY[0], [2, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"]]),
  ).rejects.toThrow(/pair\(s\) overlap/);
});

test.each([true, false])("reports overlay area no input covers (clean %s)", async (clean) => {
  const r = await mosaic(
    [
      [1, "POLYGON((-1 -1, 1.5 -1, 1.5 4, -1 4, -1 -1))"],
      [2, "POLYGON((1.5 -1, 4.5 -1, 4.5 4, 1.5 4, 1.5 -1))"],
    ],
    [
      [1, "MULTIPOLYGON(((0 0, 3 0, 3 3, 0 3, 0 0)), ((5 0, 6 0, 6 1, 5 0)))"],
      [2, "POLYGON((3 0, 4 0, 4 3, 3 3, 3 0))"],
    ],
    { clean },
  );
  const gaps = r.issues.filter((i) => i.kind === "gap");
  expect(gaps.map((i) => [i.overlayFid, i.reason])).toEqual([
    [1, "overlay area no output row covers"],
  ]);
  expect(gaps[0].areaM2! / 111319.49 ** 2).toBeCloseTo(0.5, 1);
});

const CLEAN_SQUARE: Row = [1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))"];
test.each([
  ["overlap", [CLEAN_SQUARE, [2, "POLYGON((2 0, 5 0, 5 3, 2 3, 2 0))"]]],
  ["gap", [[1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0),(1 1, 2 1, 2 2, 1 2, 1 1))"]]],
  ["micro-polygon", [CLEAN_SQUARE, [2, "POLYGON((3 0, 3.000000001 0, 3.000000001 3, 3 3, 3 0))"]]],
] as [string, Row[]][])("raises on an unclean input (%s)", async (_, input) => {
  await expect(mosaic(input, [[1, "POLYGON((0 0, 5 0, 5 3, 0 3, 0 0))"]])).rejects.toThrow(
    /input\.parquet is not a clean coverage/,
  );
});

test.todo("never invokes extend's Voronoi pipeline (monkeypatch guard, no TS counterpart)");
test.todo(
  "multi-file inputs: unassigned file warning, file majority vote, source_file, detached keys, column order, zero-overlap file, code-join fid (the loader reads one dataset per drop)",
);
test.todo("passthrough files that overlap each other stay whole (multi-file)");
test.todo(
  "cross-border inputs have no invalid edges, and without the clean report seams (multi-file)",
);
test.todo("raises on overlapping files with one overlay polygon (multi-file)");
test.todo("bare merge, input_exclude, prefer and narrowing-flag checks (no TS counterpart)");
test.todo("gap-fill keeps an unmatched overlay (no TS counterpart)");
test.todo("match and mosaic merge give identical results (multi-file)");
test.todo("fill_schema and depth_column options (no TS counterpart)");
test.todo("default output paths and steps (file output, no TS counterpart)");

const pairInputs = () => coded(INPUT.slice(0, 2), "input.parquet");

test("an original with unmatched codes warns and still pairs", async () => {
  const originalFile = await coded(
    [
      [1, INPUT[0][1]],
      [9, INPUT[1][1]],
    ],
    "original.parquet",
    false,
  );
  const r = await mosaic(INPUT, OVERLAY, { inputFile: await pairInputs(), originalFile });
  expect(r.warnings).toEqual(["1 original adm1_pcode codes match no input feature."]);
});

test("an original without a code column runs without it", async () => {
  const originalFile = await synthetic(INPUT.slice(0, 2), "original.parquet");
  const r = await mosaic(INPUT, OVERLAY, { inputFile: await pairInputs(), originalFile });
  expect(r.warnings).toEqual([
    "The original has no detectable code column, so it pairs with nothing.",
  ]);
});

test("an original whose codes pair nothing runs without it", async () => {
  const originalFile = await coded(
    [
      [8, INPUT[0][1]],
      [9, INPUT[1][1]],
    ],
    "original.parquet",
    false,
  );
  const r = await mosaic(INPUT, OVERLAY, { inputFile: await pairInputs(), originalFile });
  expect(r.warnings).toEqual([
    "The input runs without the original: none of its codes match the input.",
  ]);
});

test("a one-feature input pairs no original, quietly", async () => {
  const originalFile = await coded([[9, INPUT[0][1]]], "original.parquet");
  const r = await mosaic(INPUT, OVERLAY, {
    inputFile: await coded(INPUT.slice(0, 1), "input.parquet"),
    originalFile,
  });
  expect(r.warnings).toEqual([]);
});

test.each([1, null, 9])("an original row keyed %s keeps its detached piece", async (oddId) => {
  const notch =
    "POLYGON((-0.01 0, 0.01 0, 0.01 0.008, 0 0.008, 0 0.009, 0.00005 0.009, 0.00005 0.0091, 0 0.0091, 0 0.01, -0.01 0.01, -0.01 0))";
  const odd = "POLYGON((0 0, 0.01 0, 0.01 0.01, 0 0.01, 0 0))";
  const even = "POLYGON((-0.005 0, 0 0, 0 0.01, -0.005 0.01, -0.005 0))";
  const third = "POLYGON((-0.01 0, -0.005 0, -0.005 0.01, -0.01 0.01, -0.01 0))";
  const oddOriginal =
    "MULTIPOLYGON(((0 0, 0.01 0, 0.01 0.008, 0 0.008, 0 0)), ((0 0.009, 0.00005 0.009, 0.00005 0.0091, 0 0.0091, 0 0.009)))";
  await mosaic(INPUT, OVERLAY, {
    inputFile: await coded(
      [
        [1, odd],
        [2, even],
        [3, third],
      ],
      "input.parquet",
    ),
    overlayFile: await synthetic([[1, notch]], "overlay.parquet"),
    originalFile: await coded(
      [
        [oddId, oddOriginal],
        [2, even],
        [3, third],
      ],
      "original.parquet",
      false,
    ),
  });
  expect(await rows("SELECT fixed, reason FROM ms_issues WHERE kind = 'detached-part'")).toEqual([
    { fixed: false, reason: "kept: matches original shape" },
  ]);
});
