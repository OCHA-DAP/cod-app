import { beforeAll, expect, test } from "vitest";
import { scanTopology } from "$lib/tools/topo-detect/pipeline";
import { exportColumns, ready, rows, table } from "./helpers";

// fid 1-4 is a compact-hole donut, fid 5-6 a partial overlap, fid 7-8 a full-containment overlap.
const SYNTHETIC: [number, string][] = [
  [1, "POLYGON((0 0, 3 0, 3 1, 2 1, 1 1, 0 1, 0 0))"],
  [2, "POLYGON((0 2, 1 2, 2 2, 3 2, 3 3, 0 3, 0 2))"],
  [3, "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))"],
  [4, "POLYGON((2 1, 3 1, 3 2, 2 2, 2 1))"],
  [5, "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  [6, "POLYGON((10.95 0, 12 0, 12 1, 10.95 1, 10.95 0))"],
  [7, "POLYGON((30 0, 32 0, 32 2, 30 2, 30 0))"],
  [8, "POLYGON((30.5 0.5, 31.5 0.5, 31.5 1.5, 30.5 1.5, 30.5 0.5))"],
];

// Units sharing y=0 up to x=0, then A's edge leaves B's at a 5 m mouth over 600 m.
const A = 600 / 111320;
const B = 1000 / 111320;
const MOUTH = 5 / 111320;
const WEDGE: [number, string][] = [
  [1, `POLYGON((-.02 0, 0 0, ${A} ${MOUTH}, ${A} .02, -.02 .02, -.02 0))`],
  [2, `POLYGON((-.02 0, 0 0, ${B} 0, ${B} -.02, -.02 -.02, -.02 0))`],
];

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

async function detect(wkt: [number, string][]) {
  await table("layer_01", ["fid", "geom"], wkt);
  return scanTopology(conn);
}

const kinds = async () =>
  (await rows<{ kind: string }>("SELECT kind FROM dt_issues")).map((r) => r.kind);

test("reports a notch", async () => {
  await detect(WEDGE);
  const found = await rows<{ kind: string; near: number }>(
    "SELECT kind, near_length_m AS near FROM dt_issues",
  );
  expect(found.map((r) => r.kind)).toEqual(["notch"]);
  expect(found[0].near).toBeGreaterThan(0);
});

test.each([
  [0.0005, "gap"],
  [-0.0005, "overlap"],
])("a thin lens (dy %s) is one %s, not also notches", async (dy, kind) => {
  await detect([
    [1, `POLYGON((0 0, 0.2 0, 0.5 ${dy}, 0.8 0, 1 0, 1 1, 0 1, 0 0))`],
    [2, "POLYGON((0 0, 0 -1, 1 -1, 1 0, 0.8 0, 0.2 0, 0 0))"],
  ]);
  expect(await kinds()).toEqual([kind]);
});

test("full run", async () => {
  const { failedKinds } = await detect(SYNTHETIC);
  expect(failedKinds.size).toBe(0);
  expect(new Set(await kinds())).toEqual(new Set(["gap", "overlap"]));
  const columns = await exportColumns("detect_issues");
  expect(columns).not.toContain("fixed");
  expect(columns).not.toContain("filled_area_m2");
});

test("a fully nested duplicate is an overlap", async () => {
  await detect(SYNTHETIC);
  expect(
    await rows(`SELECT ST_Area(geom) AS a FROM dt_issues
      WHERE kind = 'overlap' AND ST_Within(geom, ST_MakeEnvelope(30, 0, 32, 2))`),
  ).toEqual([{ a: 1 }]);
});

test("no defects", async () => {
  await detect([
    [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
    [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
  ]);
  expect(await kinds()).toEqual([]);
});

test.todo("gap detection failure falls back to empty (needs a stage override hook)");
test.todo("overlap detection failure falls back to empty (needs a stage override hook)");
test.todo("default output path (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
