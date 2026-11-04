import { beforeAll, expect, test } from "vitest";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { hasNoiseFloorGap } from "$lib/db/coverage";
import { hasInvalidEdges } from "$lib/db/invalidEdges";
import type { MatchColumnOptions } from "$lib/db/codeJoin";
import { runEdgeMatch } from "$lib/tools/edge-match/pipeline";
import type { MatchMode } from "$lib/tools/edge-match/pipeline/assign";
import { loadLayers } from "$lib/tools/edge-match/pipeline/load";
import { db, exportColumns, ready, rows, scalar, write } from "./helpers";

// Overlay A contains inputs 1 & 2, Overlay B only input 3, input 4 is far from both.
const INPUT: [number, string][] = [
  [1, "POLYGON((0.5 0.5, 1 0.5, 1 1, 0.5 1, 0.5 0.5))"],
  [2, "POLYGON((1.5 0.5, 2 0.5, 2 1, 1.5 1, 1.5 0.5))"],
  [3, "POLYGON((11 1, 12 1, 12 2, 11 2, 11 1))"],
  [4, "POLYGON((20 0, 21 0, 21 1, 20 1, 20 0))"],
];
const OVERLAY: [number, string][] = [
  [1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))"],
  [2, "POLYGON((10 0, 13 0, 13 3, 10 3, 10 0))"],
];

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const values = (wkt: [number, string][], extra: (fid: number) => string = () => "") =>
  wkt.map(([fid, w]) => `(${fid}, ST_GeomFromText('${w}')${extra(fid)})`).join(", ");
const synthetic = (wkt: [number, string][], name: string) =>
  write(`SELECT * FROM (VALUES ${values(wkt)}) AS t(id, geom)`, name);
const withCode = (wkt: [number, string][], code: (fid: number) => string, name: string) =>
  write(
    `SELECT * FROM (VALUES ${values(wkt, (fid) => `, '${code(fid)}'`)}) AS t(id, geom, pcode)`,
    name,
  );

type Issue = { kind: string; unit_a: number; overlay_fid: number | null; reason: string | null };
async function match(
  inputs: Promise<File>[] | Promise<File>,
  overlays: Promise<File> = synthetic(OVERLAY, "overlay.parquet"),
  opts: { mode?: MatchMode; columns?: MatchColumnOptions; passthrough?: boolean; clean?: boolean } = {},
) {
  const { db: instance } = db();
  const inputFiles = await Promise.all(Array.isArray(inputs) ? inputs : [inputs]);
  const result = await runEdgeMatch(
    instance,
    conn,
    inputFiles,
    [await overlays],
    () => {},
    opts.columns ?? {},
    opts.passthrough ?? false,
    opts.mode ?? "auto",
    opts.clean ?? true,
  );
  const issues = (
    await rows<Issue>("SELECT kind, unit_a, overlay_fid, reason FROM ge_issues ORDER BY unit_a")
  ).map((r) => ({ ...r, unit_a: Number(r.unit_a), overlay_fid: r.overlay_fid === null ? null : Number(r.overlay_fid) }));
  const columns = await exportColumns("match");
  const ids = (await rows<{ id: number }>("SELECT id FROM '_export.parquet' ORDER BY id")).map((r) =>
    Number(r.id),
  );
  return { ...result, issues, columns, ids };
}
const inputs = (wkt = INPUT) => synthetic(wkt, "input.parquet");

test("inputs clean the input but load the overlay raw", async () => {
  const w = SNAP_TOLERANCE / 2;
  const gapped: [number, string][] = [
    [1, `POLYGON((0 -50, 101 -50, 101 0, ${50 + w} 0, 50 0, 0 0, 0 -50))`],
    [2, `POLYGON((0 ${w}, 50 ${w}, ${50 + w} ${w}, 101 ${w}, 101 51, 0 51, 0 ${w}))`],
    [3, `POLYGON((0 0, 50 0, 50 ${w}, 0 ${w}, 0 0))`],
    [4, `POLYGON((${50 + w} 0, 101 0, 101 ${w}, ${50 + w} ${w}, ${50 + w} 0))`],
  ];
  const { db: instance } = db();
  await loadLayers(
    instance,
    conn,
    [await synthetic(gapped, "input.parquet")],
    [await synthetic(gapped, "overlay.parquet")],
  );
  expect(await hasNoiseFloorGap(conn, "input_layer_01")).toBe(false);
  expect(await hasNoiseFloorGap(conn, "overlay_layer_01")).toBe(true);
});

test("match column is mutually exclusive with the pair", async () => {
  await expect(
    match(inputs(), undefined, { columns: { matchColumn: "pcode", overlayMatchColumn: "pcode" } }),
  ).rejects.toThrow(/mutually exclusive/);
});

test("a code agreeing with spatial everywhere changes nothing", async () => {
  const overlayOf: Record<number, number> = { 1: 1, 2: 1, 3: 2 };
  const r = await match(
    withCode(INPUT.slice(0, 3), (fid) => String(overlayOf[fid]), "input.parquet"),
    withCode(OVERLAY, String, "overlay.parquet"),
    { columns: { matchColumn: "pcode" } },
  );
  expect(r.ids).toEqual([1, 2]);
  expect(r.issues.map((i) => i.kind)).not.toContain("code-mismatch");
});

test("full run: auto keeps assign-one", async () => {
  const r = await match(inputs());
  expect(r.mode).toBe("one");
  expect(r.ids).toEqual([1, 2]);
});

test("auto switches to many under half", async () => {
  const r = await match(inputs([INPUT[0], INPUT[2], INPUT[3]]));
  expect(r.mode).toBe("many");
  expect(r.ids).toEqual([1, 3]);
});

test("multi-overlay keeps per-input grouping", async () => {
  expect((await match(inputs(), undefined, { mode: "many" })).ids).toEqual([1, 2, 3]);
});

test("drops the unassigned input", async () => {
  expect((await match(inputs(), undefined, { mode: "many" })).unassignedCount).toBe(1);
});

test("the issues record the unassigned input", async () => {
  const r = await match(inputs(), undefined, { mode: "many" });
  expect(r.issues).toEqual([{ kind: "unassigned", unit_a: 4, overlay_fid: null, reason: null }]);
  expect(await scalar("SELECT geom IS NOT NULL FROM ge_issues")).toBe(true);
});

test("the default issues record clip-empty inputs", async () => {
  const r = await match(inputs());
  expect(r.issues.map((i) => i.unit_a)).toEqual([3, 4]);
  for (const i of r.issues) {
    expect(i.kind).toBe("clip-empty");
    expect(i.overlay_fid).toBe(1);
    expect(i.reason).not.toBeNull();
  }
});

test("no issues when nothing is dropped", async () => {
  const r = await match(inputs([INPUT[2]]), synthetic([OVERLAY[1]], "overlay.parquet"));
  expect(r.issues).toEqual([]);
});

test("tolerates an overlay-layer enclave", async () => {
  const r = await match(
    inputs([
      [1, "POLYGON((0 0, 5 0, 5 10, 0 10, 0 0))"],
      [2, "POLYGON((5 0, 10 0, 10 10, 5 10, 5 0))"],
    ]),
    synthetic(
      [[1, "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0), (4 4, 6 4, 6 6, 4 6, 4 4))"]],
      "overlay.parquet",
    ),
  );
  expect(r.ids).toEqual([1, 2]);
});

test("a single-overlay group", async () => {
  const r = await match(inputs([INPUT[2]]), synthetic([OVERLAY[1]], "overlay.parquet"));
  expect(r.ids).toEqual([3]);
});

// drift: py raises when no group produces output; the site returns an empty result
test.fails("all unassigned raises", async () => {
  await expect(match(inputs([INPUT[3]]))).rejects.toThrow(/no group produced any output/);
});

test("passthrough keeps an orphan unclipped", async () => {
  const r = await match(inputs(), undefined, { mode: "many", passthrough: true });
  expect(r.ids).toEqual([1, 2, 3, 4]);
  const kinds = r.issues.map((i) => i.kind);
  expect(kinds).toContain("passthrough");
  expect(kinds).not.toContain("unassigned");
});

test("without passthrough an orphan is still dropped", async () => {
  const r = await match(inputs(), withCode(OVERLAY, (fid) => `P${fid}`, "overlay.parquet"), {
    mode: "many",
  });
  expect(r.ids).toEqual([1, 2, 3]);
  expect(r.issues.map((i) => i.kind)).toEqual(["unassigned"]);
});

// Two overlays share a slanted border; the inputs cross it at different heights.
test("cross-border inputs have no invalid edges", async () => {
  const r = await match(
    inputs([
      [1, "POLYGON((-1 -1, 3.9 -1, 3.9 1.7, -1 1.7, -1 -1))"],
      [2, "POLYGON((-1 1.7, 3.9 1.7, 3.9 4, -1 4, -1 1.7))"],
      [3, "POLYGON((2.4 -1, 7 -1, 7 1.2, 5 1.2, 2.4 1.2, 2.4 -1))"],
      [4, "POLYGON((2.4 1.2, 5 1.2, 5 4, 2.4 4, 2.4 1.2))"],
      [5, "POLYGON((5 1.2, 7 1.2, 7 4, 5 4, 5 1.2))"],
    ]),
    synthetic(
      [
        [1, "POLYGON((0 0, 3 0, 3.3 3, 0 3, 0 0))"],
        [2, "POLYGON((3 0, 6 0, 6 3, 3.3 3, 3 0))"],
      ],
      "overlay.parquet",
    ),
    { mode: "many" },
  );
  expect(r.ids).toEqual([1, 2, 3, 4, 5]);
  expect(r.issues.map((i) => i.kind)).not.toContain("invalid-edge");
  expect(await hasInvalidEdges(conn, "ge_results")).toBe(false);
});

test("without the clean, seams are reported as invalid edges", async () => {
  const r = await match(
    inputs([
      [1, "POLYGON((-1 -1, 3.9 -1, 3.9 1.7, -1 1.7, -1 -1))"],
      [2, "POLYGON((-1 1.7, 3.9 1.7, 3.9 4, -1 4, -1 1.7))"],
      [3, "POLYGON((2.4 -1, 7 -1, 7 1.2, 5 1.2, 2.4 1.2, 2.4 -1))"],
      [4, "POLYGON((2.4 1.2, 5 1.2, 5 4, 2.4 4, 2.4 1.2))"],
      [5, "POLYGON((5 1.2, 7 1.2, 7 4, 5 4, 5 1.2))"],
    ]),
    synthetic(
      [
        [1, "POLYGON((0 0, 3 0, 3.3 3, 0 3, 0 0))"],
        [2, "POLYGON((3 0, 6 0, 6 3, 3.3 3, 3 0))"],
      ],
      "overlay.parquet",
    ),
    { mode: "many", clean: false },
  );
  expect(r.issues.map((i) => i.kind)).toContain("invalid-edge");
});

test("raises on an overlapping overlay", async () => {
  await expect(
    match(
      inputs(),
      synthetic([...OVERLAY, [3, "POLYGON((1 1, 4 1, 4 4, 1 4, 1 1))"]], "overlay.parquet"),
    ),
  ).rejects.toThrow(/pair\(s\) overlap/);
});

// An extended orphan overlapping a matched row takes no area from it.
test.each([true, false])("passthrough orphan leaves the matched row whole (clean %s)", async (clean) => {
  const r = await match(
    inputs([
      [1, "POLYGON((0.5 0.5, 3.5 0.5, 3.5 3.5, 0.5 3.5, 0.5 0.5))"],
      [2, "POLYGON((4.5 0.5, 7 0.5, 7 3.5, 4.5 3.5, 4.5 0.5))"],
    ]),
    synthetic([[1, "POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))"]], "overlay.parquet"),
    { mode: "many", passthrough: true, clean },
  );
  expect(await scalar<number>("SELECT ST_Area(geometry) FROM '_export.parquet' WHERE id = 1")).toBeCloseTo(16, 6);
  expect(r.issues.map((i) => i.kind)).not.toContain("invalid-edge");
});

test.todo("merge, overlay_include, input_exclude and prefer column flags (no TS counterpart)");
test.todo("gap-fill keeps an unmatched overlay (no TS counterpart)");
test.todo("multi-file inputs: one run, deterministic column order, source_file in issues (the loader reads one dataset per drop)");
test.todo("fill_schema and depth_column options (no TS counterpart)");
test.todo("multi-file rejects multi-overlay, step and a missing output path (API arguments)");
test.todo("record_dropped_group and the clip step's bad overlay_fid abort (py stage internals)");
test.todo("default output paths (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
