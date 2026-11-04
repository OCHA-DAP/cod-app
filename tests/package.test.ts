import { beforeAll, expect, test } from "vitest";
import { runPackage } from "$lib/tools/package/pipeline";
import { runPackageLines } from "$lib/tools/package-lines/pipeline";
import { runPackagePoints } from "$lib/tools/package-points/pipeline";
import { runPackagePolygons } from "$lib/tools/package-polygons/pipeline";
import { layer, ready } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const ROWS: [string, string, string][] = [
  ["P1", "A1", "POLYGON((0 0, 0 10, 10 10, 10 0, 0 0))"],
  ["P1", "A2", "POLYGON((10 0, 10 10, 20 10, 20 0, 10 0))"],
  ["P2", "B1", "POLYGON((0 10, 0 20, 10 20, 10 10, 0 10))"],
];

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const load = (rs: [string, string, string][]) =>
  layer(
    `SELECT adm1_pcode, adm2_pcode, ST_GeomFromText(wkt) AS geom FROM (VALUES ${rs
      .map((r) => `(${r.map((v) => `'${v}'`).join(", ")})`)
      .join(", ")}) AS v(adm1_pcode, adm2_pcode, wkt)`,
  );

const shape = (r: { levels: unknown[]; resultGeoJSON: string }) => ({
  levels: r.levels,
  features: JSON.parse(r.resultGeoJSON).features.length,
});

test("the combined run matches calling each tool separately", async () => {
  await load(ROWS);
  const combined = await runPackage(conn, SCHEMA);
  await load(ROWS);
  const polygons = await runPackagePolygons(conn, SCHEMA);
  await load(ROWS);
  const points = await runPackagePoints(conn, SCHEMA);
  await load(ROWS);
  const lines = await runPackageLines(conn, SCHEMA);
  expect(combined.polygons.levels.map((l) => [l.level, l.exportable])).toEqual(
    polygons.levels.map((l) => [l.level, l.exportable]),
  );
  expect(shape(combined.points)).toEqual(shape(points));
  expect(shape(combined.lines)).toEqual(shape(lines));
});

// drift: py check_no_overlaps refuses overlapping input in all three package tools
test.fails.each([
  ["polygons", runPackagePolygons],
  ["points", runPackagePoints],
  ["lines", runPackageLines],
] as const)("%s raises on overlapping input", async (_, tool) => {
  await load([...ROWS, ["P1", "A9", ROWS[0][2]]]);
  await expect(tool(conn, null)).rejects.toThrow(/pair\(s\) overlap/);
});

test.todo("{x} output template substitutes per subtool (file output, no TS counterpart)");
test.todo("a template without {x} raises (file output, no TS counterpart)");
test.todo("overwrite=false raises on an existing output (file output, no TS counterpart)");
