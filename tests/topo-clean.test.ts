import { beforeAll, expect, test } from "vitest";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { METERS_PER_DEGREE } from "$lib/db/units";
import { runFromLoaded, type CleanOptions, type IssueRow } from "$lib/tools/topo-clean/pipeline";
import { checkFixedIssues } from "$lib/tools/topo-clean/pipeline/issues";
import { validateCleanOutput } from "$lib/tools/topo-clean/pipeline/validate";
import { scanTopology } from "$lib/tools/topo-detect/pipeline";
import { exportColumns, layer, ready, rows, run, scalar, table } from "./helpers";

// Four independent groups, spatially separated, each exercising one defect.
const SYNTHETIC: [number, string][] = [
  // A donut of 4 polygons enclosing a real 1x1 gap at (1,1)-(2,2).
  [1, "POLYGON((0 0, 3 0, 3 1, 2 1, 1 1, 0 1, 0 0))"],
  [2, "POLYGON((0 2, 1 2, 2 2, 3 2, 3 3, 0 3, 0 2))"],
  [3, "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))"],
  [4, "POLYGON((2 1, 3 1, 3 2, 2 2, 2 1))"],
  [5, "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  [6, "POLYGON((10.95 0, 12 0, 12 1, 10.95 1, 10.95 0))"],
  [7, "POLYGON((30 0, 32 0, 32 2, 30 2, 30 0))"],
  [8, "POLYGON((30.5 0.5, 31.5 0.5, 31.5 1.5, 30.5 1.5, 30.5 0.5))"],
  // Same hole area as fid 1-4's, but a thinness ratio far below the default.
  [9, "POLYGON((50 0, 62 0, 62 1, 50 1, 50 0))"],
  [10, "POLYGON((50 1.1, 62 1.1, 62 2.1, 50 2.1, 50 1.1))"],
  [11, "POLYGON((50 1, 51 1, 51 1.1, 50 1.1, 50 1))"],
  [12, "POLYGON((61 1, 62 1, 62 1.1, 61 1.1, 61 1))"],
];

// Units sharing y=0 up to x=0, then A's edge leaves B's at a 5 m mouth over 600 m.
const A = 600 / 111320;
const B = 1000 / 111320;
const MOUTH = 5 / 111320;
const WEDGE: [number, string][] = [
  [1, `POLYGON((-.02 0, 0 0, ${A} ${MOUTH}, ${A} .02, -.02 .02, -.02 0))`],
  [2, `POLYGON((-.02 0, 0 0, ${B} 0, ${B} -.02, -.02 -.02, -.02 0))`],
];

// A compact 1x1 hole inside a realistically scaled ~10,200-area ring.
const SCALED_GAP: [number, string][] = [
  [1, "POLYGON((0 -50, 101 -50, 101 0, 0 0, 0 -50))"],
  [2, "POLYGON((0 1, 101 1, 101 51, 0 51, 0 1))"],
  [3, "POLYGON((0 0, 50 0, 50 1, 0 1, 0 0))"],
  [4, "POLYGON((51 0, 101 0, 101 1, 51 1, 51 0))"],
];
// The same ring, fully noded and with no overlaps anywhere.
const GAP_ONLY: [number, string][] = [
  [1, "POLYGON((0 -50, 101 -50, 101 0, 51 0, 50 0, 0 0, 0 -50))"],
  [2, "POLYGON((0 1, 50 1, 51 1, 101 1, 101 51, 0 51, 0 1))"],
  [3, "POLYGON((0 0, 50 0, 50 1, 0 1, 0 0))"],
  [4, "POLYGON((51 0, 101 0, 101 1, 51 1, 51 0))"],
];
const w = SNAP_TOLERANCE / 2;
const NOISE_SCALE_GAP: [number, string][] = [
  [1, `POLYGON((0 -50, 101 -50, 101 0, ${50 + w} 0, 50 0, 0 0, 0 -50))`],
  [2, `POLYGON((0 ${w}, 50 ${w}, ${50 + w} ${w}, 101 ${w}, 101 51, 0 51, 0 ${w}))`],
  [3, `POLYGON((0 0, 50 0, 50 ${w}, 0 ${w}, 0 0))`],
  [4, `POLYGON((${50 + w} 0, 101 0, 101 ${w}, ${50 + w} ${w}, ${50 + w} 0))`],
];

const MINIMAL: CleanOptions = { mode: "minimal", gapWidthM: 0 };
const degrees = (deg: number): CleanOptions => ({
  mode: "manual",
  gapWidthM: deg * METERS_PER_DEGREE,
});

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

async function load(wkt: [number, string][]) {
  await table("layer_01", ["fid", "geom"], wkt);
  await run("CREATE OR REPLACE TABLE layer_attr AS SELECT fid, fid AS id FROM layer_01");
}

// Cleans, then registers the issues export as _issues.parquet and the output as _export.parquet.
async function clean(wkt: [number, string][], opts: CleanOptions = MINIMAL) {
  await load(wkt);
  const result = await runFromLoaded(conn, opts, () => {});
  await exportColumns("topology_issues");
  await run("CREATE OR REPLACE TABLE _issues AS SELECT * FROM '_export.parquet'");
  await exportColumns("clean_topology");
  return result;
}

const realHoleArea = () =>
  scalar<number>(`
    WITH u AS (SELECT ST_Union_Agg(geometry) AS g FROM '_export.parquet'),
    parts AS (SELECT (UNNEST(ST_Dump(g))).geom AS geom FROM u)
    SELECT COALESCE(SUM(ST_Area(ST_Difference(ST_MakePolygon(ST_ExteriorRing(geom)), geom))), 0)
    FROM parts WHERE ST_NumInteriorRings(geom) > 0`);

test("full run", async () => {
  await clean(SYNTHETIC);
  expect(await scalar("SELECT count(*)::INT FROM '_export.parquet'")).toBe(SYNTHETIC.length);
  expect(
    new Set((await rows<{ kind: string }>("SELECT DISTINCT kind FROM _issues")).map((r) => r.kind)),
  ).toEqual(new Set(["gap", "overlap"]));
});

test("closes a notch", async () => {
  await clean(WEDGE);
  expect(await rows("SELECT kind, fixed FROM _issues")).toEqual([{ kind: "notch", fixed: true }]);
});

test("the issues report an overlap's outcome", async () => {
  await clean(SYNTHETIC);
  const [row] = await rows<{ a: number; b: number; fixed: boolean }>(`
    SELECT unit_a_area_change_m2 AS a, unit_b_area_change_m2 AS b, fixed FROM _issues
    WHERE kind = 'overlap' AND ST_Within(geometry, ST_MakeEnvelope(30, 0, 32, 2))`);
  const [swallowed, untouched] = [row.a, row.b].sort((x, y) => x - y);
  expect(swallowed).toBeLessThan(-1e9);
  expect(untouched).toBeCloseTo(0);
  expect(row.fixed).toBe(true);
});

test.each([false, true])(
  "reports a merged micro-polygon (with overlap %s)",
  async (withOverlap) => {
    const sliver = SNAP_TOLERANCE / 10;
    const input: [number, string][] = [
      [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
      [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
      [3, `POLYGON((2 0, ${2 + sliver} 0, ${2 + sliver} 1, 2 1, 2 0))`],
      ...(withOverlap ? SYNTHETIC.filter(([fid]) => fid === 5 || fid === 6) : []),
    ];
    await clean(input);
    const ids = await rows<{ id: number }>(
      "SELECT id FROM '_export.parquet' WHERE NOT ST_IsEmpty(geometry) ORDER BY id",
    );
    expect(ids.map((r) => Number(r.id))).toEqual(input.map(([fid]) => fid).filter((f) => f !== 3));
    expect(
      await rows(`SELECT unit_b IS NOT NULL AS has_b, reason, fixed, ST_Area(geometry) > 0 AS area
        FROM _issues WHERE kind = 'micro-polygon'`),
    ).toEqual([{ has_b: true, reason: "merged into neighbouring polygon", fixed: true, area: true }]);
  },
);

test("fills a gap with no coverage violations", async () => {
  await load(GAP_ONLY);
  expect(
    await scalar(`SELECT ST_CoverageInvalidEdges_Agg(geom) IS NOT NULL
      FROM (SELECT UNNEST(ST_Dump(geom)).geom AS geom FROM layer_01)`),
  ).toBe(false);
  await clean(GAP_ONLY, { mode: "all", gapWidthM: 0 });
  expect(await realHoleArea()).toBeCloseTo(0, 9);
});

test("maximum gap width all fills the gap", async () => {
  await clean(SCALED_GAP, { mode: "all", gapWidthM: 0 });
  expect(await realHoleArea()).toBeCloseTo(0, 9);
  expect(await scalar<number>("SELECT filled_area_m2 FROM _issues WHERE kind = 'gap'")).toBeGreaterThan(0);
});

test("maximum gap width thin fills only the thin gap", async () => {
  await clean(SYNTHETIC, { mode: "thin", gapWidthM: 0 });
  expect(
    await rows(`WITH u AS (SELECT ST_Union_Agg(geometry) AS g FROM '_export.parquet')
      SELECT ST_Contains(u.g, ST_Point(1.5, 1.5)) AS compact, ST_Contains(u.g, ST_Point(55, 1.05)) AS thin
      FROM u`),
  ).toEqual([{ compact: false, thin: true }]);
  expect(
    (await rows<{ fixed: boolean }>(
      "SELECT fixed FROM _issues WHERE kind = 'gap' ORDER BY thinness_ratio DESC",
    )).map((r) => r.fixed),
  ).toEqual([false, true]);
});

test.each(["minimal", "thin", "all"] as const)(
  "reports every gap topo-detect finds (%s)",
  async (mode) => {
    await clean(SYNTHETIC, { mode, gapWidthM: 0 });
    const unfilled = await scalar<number>(
      "SELECT count(*)::INT FROM _issues WHERE kind = 'gap' AND NOT fixed",
    );
    await layer("SELECT geometry AS geom FROM '_export.parquet'");
    await scanTopology(conn);
    expect(await scalar("SELECT count(*)::INT FROM dt_issues WHERE kind = 'gap'")).toBe(unfilled);
  },
);

test("the default leaves a real gap unfilled", async () => {
  await clean(SCALED_GAP);
  expect(await realHoleArea()).toBeCloseTo(1, 6);
});

test("the default fills a noise-scale gap", async () => {
  await clean(NOISE_SCALE_GAP);
  expect(await realHoleArea()).toBeCloseTo(0, 20);
});

test("an explicit maximum gap width in degrees", async () => {
  await clean(SCALED_GAP, degrees(0.5));
  expect(await realHoleArea()).toBeCloseTo(1, 6);
  await clean(SCALED_GAP, degrees(2));
  expect(await realHoleArea()).toBeCloseTo(0, 9);
});

// tc_issues as buildIssues writes it, holding only the given rows.
async function issuesTable(values: string) {
  await run(`CREATE OR REPLACE TABLE tc_issues AS
    SELECT key, kind, unit_a, unit_b, geom, NULL::BOOLEAN AS fixed,
      NULL::DOUBLE AS unit_a_area_change_m2, NULL::DOUBLE AS unit_b_area_change_m2,
      NULL::DOUBLE AS filled_area_m2, NULL::DOUBLE AS area_m2, NULL::DOUBLE AS max_width_m,
      NULL::DOUBLE AS thinness_ratio, NULL::VARCHAR AS reason, NULL::DOUBLE AS xmin,
      NULL::DOUBLE AS ymin, NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymax
    FROM (VALUES ${values}) AS t(key, kind, unit_a, unit_b, geom)`);
}
const issue = (key: string, kind: IssueRow["kind"], units: number[] = []): IssueRow => ({
  key,
  kind,
  areaM2: 0,
  maxWidthM: 0,
  thinnessRatio: null,
  nearLengthM: null,
  units,
  bbox: [0, 0, 0, 0],
});

test("a partly filled gap is not fixed", async () => {
  const left = "POLYGON((0 0, 1 0, 1 1, 1 1.6, 1 2, 1 3, 0 3, 0 0))";
  const right = "POLYGON((2 0, 3 0, 3 3, 2 3, 2 2, 2 1.6, 2 1, 2 0))";
  const top = "POLYGON((1 2, 2 2, 2 3, 1 3, 1 2))";
  const before = "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))";
  const after = "POLYGON((1 0, 2 0, 2 1, 2 1.6, 1 1.6, 1 1, 1 0))";
  await table("layer_01", ["fid", "geom"], [left, right, top, before].map((g, i) => [i + 1, g]));
  await table("tc_clean", ["fid", "geom"], [left, right, top, after].map((g, i) => [i + 1, g]));
  await issuesTable("('gap-1', 'gap', NULL::BIGINT, NULL::BIGINT, ST_MakeEnvelope(1, 1, 2, 2))");
  await checkFixedIssues(conn, [issue("gap-1", "gap")]);
  expect(await rows("SELECT key, fixed FROM tc_issues")).toEqual([{ key: "gap-1", fixed: false }]);
});

test("a gap the fix opens gets one unfixed row across recleans", async () => {
  const ring = "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))";
  await table("layer_01", ["fid", "geom"], [[1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))"]]);
  await table("tc_clean", ["fid", "geom"], [[1, ring]]);
  await issuesTable("('overlap-1', 'overlap', 1, 2, ST_MakeEnvelope(5, 5, 6, 6))");
  await checkFixedIssues(conn, []);
  await checkFixedIssues(conn, []);
  expect(await rows("SELECT key, fixed, reason FROM tc_issues WHERE kind = 'gap'")).toEqual([
    { key: "gap-new-1", fixed: false, reason: "gap opened by the fix" },
  ]);
});

test("a notch's fixed status matches its location, not just its unit pair", async () => {
  await table("layer_01", ["fid", "geom"], WEDGE);
  await run("CREATE OR REPLACE TABLE tc_clean AS FROM layer_01");
  await issuesTable(`
    ('notch-1', 'notch', 1, 2, ST_MakeEnvelope(0, 0, ${A}, ${MOUTH})),
    ('notch-2', 'notch', 1, 2, ST_MakeEnvelope(0.01, -0.01, 0.011, -0.009))`);
  await checkFixedIssues(conn, [issue("notch-1", "notch", [1, 2]), issue("notch-2", "notch", [1, 2])]);
  expect(await rows("SELECT key, fixed FROM tc_issues ORDER BY key")).toEqual([
    { key: "notch-1", fixed: false },
    { key: "notch-2", fixed: true },
  ]);
});

const OVERLAPPING_PAIR: [number, string][] = [
  [1, "POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))"],
  [2, "POLYGON((1 1, 3 1, 3 3, 1 3, 1 1))"],
];
const DISJOINT_PAIR: [number, string][] = [
  [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  [2, "POLYGON((10 10, 20 10, 20 20, 10 20, 10 10))"],
];

// Detection's region tables from a real run, then a stand-in ST_CoverageClean output.
async function validate(input: [number, string][], output: string) {
  await clean(input);
  await run(`CREATE OR REPLACE TABLE tc_fake AS ${output}`);
  return validateCleanOutput(conn, "tc_fake", 0.5);
}

test("rejects an eroded output", async () => {
  await expect(validate(OVERLAPPING_PAIR, "SELECT * FROM layer_01 WHERE FALSE")).rejects.toThrow(
    /output rejected/,
  );
});

test("rejects a collapsed fid", async () => {
  await expect(
    validate(
      DISJOINT_PAIR,
      "SELECT fid, CASE WHEN fid = 1 THEN ST_GeomFromText('POLYGON EMPTY') ELSE geom END AS geom FROM layer_01",
    ),
  ).rejects.toThrow(/output rejected/);
});

test("rejects a bad geometry type", async () => {
  await expect(
    validate(
      DISJOINT_PAIR,
      `SELECT fid, CASE WHEN fid = 1 THEN ST_GeomFromText(
        'GEOMETRYCOLLECTION(LINESTRING(0 0, 1 1), POLYGON((0 0, 1 0, 1 1, 0 1, 0 0)))')
        ELSE geom END AS geom FROM layer_01`,
    ),
  ).rejects.toThrow(/output rejected/);
});

test("the overlap exemption is unconditional", async () => {
  await expect(
    validate(
      OVERLAPPING_PAIR,
      `SELECT fid, CASE WHEN fid = 1 THEN ST_GeomFromText('POLYGON((0 -2, 2 -2, 2 -0.75, 0 -0.75, 0 -2))')
        ELSE geom END AS geom FROM layer_01`,
    ),
  ).resolves.toBeUndefined();
});

test("defect-unrelated drift is not rejected", async () => {
  await expect(
    validate(
      DISJOINT_PAIR,
      `SELECT fid, CASE WHEN fid = 2 THEN ST_GeomFromText('POLYGON((10 10, 19.9 10, 19.9 20, 10 20, 10 10))')
        ELSE geom END AS geom FROM layer_01`,
    ),
  ).resolves.toBeUndefined();
});

test.todo("a coverage_clean failure raises with no retry (needs a module mock)");
test.todo("logs the area change on success (logging, no TS counterpart)");
test.todo("logs defect-unrelated drift (logging, no TS counterpart)");
test.todo("invalid maximum-gap-width and snapping-distance values raise (CLI arguments, no TS counterpart)");
test.todo("default output paths (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
