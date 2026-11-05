import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { beforeAll, expect, test, vi } from "vitest";
import { hasAnyHole } from "$lib/db/coverageClean";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import { detectNotches } from "$lib/db/notches";
import { runPipeline } from "$lib/tools/edge-extend/pipeline";
import { stageCleanInput } from "$lib/tools/edge-extend/pipeline/clean";
import { stageLines } from "$lib/tools/edge-extend/pipeline/lines";
import { stageMerge } from "$lib/tools/edge-extend/pipeline/merge";
import { buildSegments, stagePoints } from "$lib/tools/edge-extend/pipeline/points";
import { checkCells, stageVoronoi } from "$lib/tools/edge-extend/pipeline/voronoi";
import { db, layer, ready, rows, run, scalar, table, write } from "./helpers";
import { listFormats, runExport } from "$lib/db/export";
import { loadFile } from "$lib/db/loader";

// fid 1/2 touch exactly; fid 3 sits across a gap for extension to fill; fid 4 is a MULTIPOLYGON.
const SYNTHETIC: [number, string][] = [
  [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
  [3, "POLYGON((3 0, 4 0, 4 1, 3 1, 3 0))"],
  [4, "MULTIPOLYGON(((0 3, 0.5 3, 0.5 3.5, 0 3.5, 0 3)), ((1 3, 1.5 3, 1.5 3.5, 1 3.5, 1 3)))"],
];

// An isolated point's unbounded Voronoi cell lands outside WGS84 range without a clip.
const ISOLATED: [number, number, number][] = [
  ...[-70, -60, -50, -40, -30, -20].flatMap((x) =>
    [-40, -30, -20, -10, 0].map((y): [number, number, number] => [0, x, y]),
  ),
  [1, -68, -85],
];

// A near-collinear cluster where GEOS's ST_VoronoiDiagram drops a generator's cell.
const DEGENERATE: [number, number, number][] = [
  [0, -0.95793148, 0.0],
  [1, -0.95793148, -8.5829e-8],
  [2, 0.107843045, 0.0],
  [3, -0.985618322, 0.0],
  [4, 0.107843045, 7.6477e-8],
  [5, -0.985618322, 0.0],
  [6, -0.985618322, -6.1918e-8],
  [7, -0.95793148, -2.914e-8],
  [8, -0.985618322, 0.0],
  [9, -0.95793148, 9.6833e-8],
];

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const wktLayer = (wkt: [number, string][]) =>
  layer(
    `SELECT id, ST_GeomFromText(w) AS geom FROM (VALUES ${wkt
      .map(([i, w]) => `(${i}, '${w}')`)
      .join(", ")}) AS t(id, w)`,
  );
const points = (name: string, ps: [number, number, number][]) =>
  run(
    `CREATE OR REPLACE TABLE ${name} AS SELECT * FROM (VALUES ${ps
      .map(([f, x, y]) => `(${f}, ST_Point(${x}, ${y}))`)
      .join(", ")}) AS t(fid, geom)`,
  );
const extend = () => runPipeline(conn, () => {});

test("full run", async () => {
  await wktLayer(SYNTHETIC);
  await extend();
  expect(await scalar("SELECT count(*)::INT FROM layer_05")).toBe(SYNTHETIC.length);
});

test("input cleaning closes a noise-scale gap", async () => {
  const w = SNAP_TOLERANCE / 2;
  await wktLayer([
    [1, `POLYGON((0 -50, 101 -50, 101 0, ${50 + w} 0, 50 0, 0 0, 0 -50))`],
    [2, `POLYGON((0 ${w}, 50 ${w}, ${50 + w} ${w}, 101 ${w}, 101 51, 0 51, 0 ${w}))`],
    [3, `POLYGON((0 0, 50 0, 50 ${w}, 0 ${w}, 0 0))`],
    [4, `POLYGON((${50 + w} 0, 101 0, 101 ${w}, ${50 + w} ${w}, ${50 + w} 0))`],
  ]);
  await stageCleanInput(conn, true, true);
  expect(await hasAnyHole(conn, "layer_01")).toBe(false);
});

test("input cleaning closes a deep notch", async () => {
  const m = 1 / 111320;
  const [ax, bx] = [600 * m, 1000 * m];
  await wktLayer([
    [1, `POLYGON((-0.02 0, 0 0, ${ax} ${5 * m}, ${ax} 0.02, -0.02 0.02, -0.02 0))`],
    [2, `POLYGON((-0.02 0, 0 0, ${bx} 0, ${bx} -0.02, -0.02 -0.02, -0.02 0))`],
  ]);
  await stageCleanInput(conn, true, true);
  expect(await detectNotches(conn, "layer_01", "notches")).toBe(0);
});

// wasm: duckdb-wasm's GEOS throws a TopologyException on this cluster before the assignment check
test.fails("voronoi raises on an incomplete assignment", async () => {
  await points("layer_03b", DEGENERATE);
  await expect(stageVoronoi(conn)).rejects.toThrow(/Voronoi assignment incomplete/);
});

test("voronoi clips an isolated cell to world bounds", async () => {
  await points("layer_03b", ISOLATED);
  await stageVoronoi(conn);
  for (const b of await rows<Record<string, number>>(
    "SELECT ST_XMin(geom) AS x0, ST_XMax(geom) AS x1, ST_YMin(geom) AS y0, ST_YMax(geom) AS y1 FROM layer_04",
  )) {
    expect(-180 <= b.x0 && b.x0 <= b.x1 && b.x1 <= 180).toBe(true);
    expect(-90 <= b.y0 && b.y0 <= b.y1 && b.y1 <= 90).toBe(true);
  }
});

// drift: py renames a source OGC_FID column on load for every format; the site only for GeoJSON
test.fails("a reserved OGC_FID source column survives a GeoPackage export", async () => {
  const values = SYNTHETIC.map(([f, w]) => `(${f}, ST_GeomFromText('${w}'))`).join(", ");
  const file = await write(
    `SELECT * FROM (VALUES ${values}) AS t(OGC_FID, geom)`,
    "synthetic.parquet",
  );
  await loadFile(db().db, conn, [file]);
  await extend();
  const gpkg = (await listFormats("extend")).find((f) => f.id === "gdal:GPKG")!;
  const { blob, filename } = await runExport("extend", gpkg, "out");
  await loadFile(db().db, conn, [new File([blob], filename)], { prefix: "rb_" });
  const columns = (await rows<{ column_name: string }>("DESCRIBE rb_layer_attr")).map(
    (r) => r.column_name,
  );
  expect(columns).toContain("OGC_FID_orig");
  expect(await scalar("SELECT count(*)::INT FROM rb_layer_01")).toBe(SYNTHETIC.length);
});

test("the bbox-prefiltered point zone matches one global union", async () => {
  const n = 15;
  const grid: [number, string][] = [];
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      grid.push([
        x * n + y,
        `POLYGON((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`,
      ]);
  await wktLayer(grid);
  await stageCleanInput(conn, true, true);
  await stageLines(conn);
  await buildSegments(conn);
  // Keeps stagePoints' pre-difference point table for the reference below.
  const keep = {
    query: (sql: string) =>
      /DROP TABLE IF EXISTS layer_03_tmp4\b/.test(sql) ? Promise.resolve() : conn.query(sql),
  } as unknown as AsyncDuckDBConnection;
  await stagePoints(keep, 0.25);
  await run(
    "CREATE OR REPLACE TABLE ref_global AS SELECT ST_Union_Agg(geom) AS geom FROM layer_03a",
  );
  await run(`--sql
    CREATE OR REPLACE TABLE ref_03b AS
    SELECT fid, geom FROM (
      SELECT a.fid, UNNEST(ST_Dump(ST_Difference(a.geom, b.geom))).geom AS geom
      FROM layer_03_tmp4 AS a CROSS JOIN ref_global AS b
      UNION ALL
      SELECT a.fid, UNNEST(ST_Dump(ST_Boundary(ST_Difference(a.geom, b.geom)))).geom AS geom
      FROM layer_02a AS a CROSS JOIN ref_global AS b
    )
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`);
  expect(
    await scalar(`--sql
      SELECT count(*)::INT FROM (
        SELECT fid, ST_Union_Agg(geom) AS geom FROM layer_03b GROUP BY fid
      ) a JOIN (
        SELECT fid, ST_Union_Agg(geom) AS geom FROM ref_03b GROUP BY fid
      ) b USING (fid)
      WHERE ST_Area(ST_SymDifference(a.geom, b.geom)) > 1e-20`),
  ).toBe(0);
  await run("DROP TABLE IF EXISTS layer_03_tmp4");
});

test("runs on input just past the antimeridian", async () => {
  const file = await write(
    `SELECT * FROM (VALUES
      (0, ST_GeomFromText('POLYGON((179 0, 179.5 0, 179.5 1, 179 1, 179 0))')),
      (1, ST_GeomFromText('POLYGON((179.5 0, 180.0000001 0, 180.0000001 1, 179.5 1, 179.5 0))'))
    ) t(id, geom)`,
    "antimeridian.parquet",
  );
  await loadFile(db().db, conn, [file]);
  await extend();
  expect(await rows("SELECT count(*)::INT AS n, max(ST_XMax(geom)) AS x FROM layer_05")).toEqual([
    { n: 2, x: 180 },
  ]);
});

test("points skip map-cut edges", async () => {
  await wktLayer([
    [0, "POLYGON((170 -90, 180 -90, 180 -80, 170 -80, 170 -90))"],
    [1, "POLYGON((160 -90, 170 -90, 170 -80, 160 -80, 160 -90))"],
  ]);
  await stageCleanInput(conn, true, true);
  await stageLines(conn);
  await buildSegments(conn);
  await stagePoints(conn, 0.5);
  expect(
    await rows(`SELECT
      count(*) FILTER (WHERE abs(ST_X(geom)) = 180 OR abs(ST_Y(geom)) = 90)::INT AS cut,
      (count(*) > 0) AS any FROM layer_03b`),
  ).toEqual([{ cut: 0, any: true }]);
});

// fid 1 has an exclave inside fid 2's cell; fid 3 has no cell.
const MERGE_ORIGINALS: [number, string][] = [
  [1, "MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ((2.2 0.2, 2.6 0.2, 2.6 0.6, 2.2 0.6, 2.2 0.2)))"],
  [2, "POLYGON((3 0, 3.5 0, 3.5 1, 3 1, 3 0))"],
  [3, "POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))"],
];
const MERGE_CELLS: [number, string][] = [
  [1, "POLYGON((-1 -1, 1.5 -1, 1.5 2, -1 2, -1 -1))"],
  [2, "POLYGON((1.5 -1, 4 -1, 4 2, 1.5 2, 1.5 -1))"],
];

async function merge() {
  await table("layer_01", ["fid", "geom"], MERGE_ORIGINALS);
  await table("layer_04", ["fid", "geom"], MERGE_CELLS);
  await run("CREATE OR REPLACE TABLE cells AS SELECT * FROM layer_04");
  await stageMerge(conn);
}

test("merge keeps an exclave and a cell-less fid", async () => {
  await merge();
  const areas = await rows<{ fid: number; a: number }>(
    "SELECT fid, ST_Area(geom) AS a FROM layer_05 ORDER BY fid",
  );
  expect(areas.map((r) => r.fid)).toEqual([1, 2, 3]);
  [7.5 + 0.16, 7.5 - 0.16, 1].forEach((a, i) => expect(areas[i].a).toBeCloseTo(a, 9));
  expect(
    await scalar(
      "SELECT ST_Area(ST_Intersection(a.geom, b.geom)) FROM layer_05 a, layer_05 b WHERE a.fid = 1 AND b.fid = 2",
    ),
  ).toBeCloseTo(0, 12);
});

test("merge equals original plus cell minus the other originals", async () => {
  await merge();
  const diffs = await rows<{ d: number }>(`--sql
    SELECT ST_Area(ST_SymDifference(r.geom, ST_Difference(
      ST_Union(o.geom, c.geom),
      (SELECT ST_Union_Agg(x.geom) FROM layer_01 x WHERE x.fid <> o.fid)))) AS d
    FROM layer_05 r JOIN layer_01 o USING (fid) JOIN cells c USING (fid)`);
  expect(diffs).toHaveLength(MERGE_CELLS.length);
  for (const { d } of diffs) expect(d).toBeCloseTo(0, 12);
});

test("a forced small vertex budget changes neither lines nor merge", async () => {
  await merge();
  const expected = await rows("SELECT fid, ST_AsText(geom) AS t FROM layer_05 ORDER BY fid");
  await table("layer_01", ["fid", "geom"], MERGE_ORIGINALS);
  await run("CREATE OR REPLACE TABLE layer_04 AS SELECT * FROM cells");
  await stageMerge(conn, 1);
  expect(await rows("SELECT fid, ST_AsText(geom) AS t FROM layer_05 ORDER BY fid")).toEqual(
    expected,
  );

  const lines = "SELECT fid, ST_AsText(geom) AS t FROM layer_02a ORDER BY fid, t";
  await wktLayer(SYNTHETIC);
  await stageLines(conn);
  const whole = await rows(lines);
  await stageLines(conn, 1);
  expect(await rows(lines)).toEqual(whole);
});

test("a distance estimated over the point limit is skipped", async () => {
  const info = vi.spyOn(console, "info");
  await wktLayer(SYNTHETIC);
  await runPipeline(conn, () => {}, { maxPoints: 1_500 });
  expect(info.mock.calls.flat().join()).toContain("skip: distance=0.0002,");
  expect(await scalar("SELECT count(*)::INT FROM layer_05")).toBe(SYNTHETIC.length);
  info.mockRestore();
});

test("raises when every distance is skipped", async () => {
  await wktLayer(SYNTHETIC);
  await expect(runPipeline(conn, () => {}, { maxPoints: 0 })).rejects.toThrow(
    /every distance estimated over 0 points/,
  );
});

test.todo("an assignment error raises without retry (needs a module mock)");

async function cellTables(cells: [number, string][]) {
  await run(`CREATE OR REPLACE TABLE layer_04_tmp0 AS SELECT * FROM (VALUES
    (1, 1, ST_Point(0.5, 0.5)), (2, 2, ST_Point(1.5, 0.5)),
    (3, 3, ST_Point(1.5, 0.5))) v(point_id, fid, geom)`);
  await run(`CREATE OR REPLACE TABLE layer_04_tmp1 AS SELECT * FROM (VALUES ${cells
    .map(([i, w]) => `(${i}, ST_GeomFromText('${w}'))`)
    .join(", ")}) v(cell_id, geom)`);
  await run(`CREATE OR REPLACE TABLE layer_04_tmp2 AS
    SELECT a.point_id, a.fid, b.cell_id, b.geom, ST_Contains(b.geom, a.geom) AS inside
    FROM layer_04_tmp0 a JOIN layer_04_tmp1 b ON ST_Intersects(a.geom, b.geom)`);
}

test("check cells accepts one point per cell and duplicates", async () => {
  await cellTables([
    [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
    [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
  ]);
  await expect(checkCells(conn)).resolves.toBeUndefined();
});

test("check cells raises on a cell holding several points", async () => {
  await cellTables([[1, "POLYGON((0 0, 2 0, 2 1, 0 1, 0 0))"]]);
  await expect(checkCells(conn)).rejects.toThrow(/holds 2 points from 3/);
});

test.todo("default output path (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
