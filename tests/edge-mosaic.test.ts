import { beforeAll, expect, test } from "vitest";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { runMosaic } from "$lib/tools/edge-mosaic/pipeline";
import { db, exportColumns, ready, rows, scalar, write } from "./helpers";

// Inputs 1+2 tile Overlay A and win the majority vote, so 3 (Overlay B) and 4 (far) drop.
const INPUT: [number, string][] = [
  [1, "POLYGON((-5 -5, 1.5 -5, 1.5 5, -5 5, -5 -5))"],
  [2, "POLYGON((1.5 -5, 8 -5, 8 5, 1.5 5, 1.5 -5))"],
  [3, "POLYGON((8 -5, 20 -5, 20 20, 8 20, 8 -5))"],
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

async function mosaic(
  inputs: Row[] = INPUT,
  overlays: Row[] = OVERLAY,
  opts: { columns?: MatchColumnOptions; carry?: string[] } = {},
) {
  const { db: instance } = db();
  const result = await runMosaic(
    instance,
    conn,
    [await synthetic(inputs, "input.parquet")],
    [await synthetic(overlays, "overlay.parquet")],
    [],
    () => {},
    opts.columns ?? {},
    opts.carry ?? [],
  );
  const columns = await exportColumns("mosaic");
  const ids = (await rows<{ id: number }>("SELECT id FROM '_export.parquet' ORDER BY id")).map((r) =>
    Number(r.id),
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
    [[1, "POLYGON((1 0, 10.5 0, 10.5 1, 1 1, 1 0))", "P2"]],
    [
      [1, OVERLAY[0][1], "P1"],
      [2, OVERLAY[1][1], "P2"],
    ],
    { columns: { matchColumn: "pcode" } },
  );
  expect(await scalar<number>("SELECT ST_Area(geometry) FROM '_export.parquet'")).toBeCloseTo(0.5, 6);
  expect(r.issues.map((i) => i.kind)).toEqual(["code-mismatch"]);
});

test("falls back to spatial when the code is unmatched", async () => {
  const r = await mosaic(
    [[1, "POLYGON((0.5 0.5, 1 0.5, 1 1, 0.5 1, 0.5 0.5))", "NOPE"]],
    [[1, OVERLAY[0][1], "P1"]],
    { columns: { matchColumn: "pcode" } },
  );
  expect(r.issues.map((i) => i.kind)).toEqual(["code-fallback"]);
});

test("merge columns populate the output", async () => {
  const r = await mosaic([INPUT[0]], [[1, OVERLAY[0][1], "P1"]], { carry: ["pcode"] });
  expect(r.columns).toContain("pcode");
  expect(await scalar("SELECT pcode FROM '_export.parquet'")).toBe("P1");
});

// drift: py check_no_overlaps refuses an overlapping overlay layer
test.fails("raises on an overlapping overlay", async () => {
  await expect(
    mosaic(INPUT, [OVERLAY[0], [2, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"]]),
  ).rejects.toThrow(/pair\(s\) overlap/);
});

test.todo("never invokes extend's Voronoi pipeline (monkeypatch guard, no TS counterpart)");
test.todo("multi-file inputs: unassigned file warning, file majority vote, source_file, detached keys, column order, zero-overlap file, code-join fid (the loader reads one dataset per drop)");
test.todo("cross-border inputs share border points, no invalid edges (multi-file, py #226)");
test.todo("raises on overlapping files with one overlay polygon (multi-file)");
test.todo("bare merge, input_exclude, prefer and narrowing-flag checks (no TS counterpart)");
test.todo("gap-fill keeps an unmatched overlay (no TS counterpart)");
test.todo("match and mosaic merge give identical results (multi-file)");
test.todo("fill_schema and depth_column options (no TS counterpart)");
test.todo("default output paths and steps (file output, no TS counterpart)");
