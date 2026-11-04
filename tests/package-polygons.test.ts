import { beforeAll, expect, test } from "vitest";
import { runPackagePolygons } from "$lib/tools/package-polygons/pipeline";
import { exportColumns, layer, ready, rows } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const BASE = `SELECT * FROM (VALUES
    ('A1', 'P1', 'Alpha', 'Province1', 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'),
    ('A2', 'P1', 'Beta', 'Province1', 'POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))'),
    ('B1', 'P2', 'Gamma', 'Province2', 'POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))')
  ) AS v(adm2_pcode, adm1_pcode, adm2_name, adm1_name, wkt)`;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const load = (select = `SELECT * EXCLUDE (wkt), ST_GeomFromText(wkt) AS geom FROM (${BASE})`) =>
  layer(select);

test("one output per level", async () => {
  await load();
  const { levels } = await runPackagePolygons(conn, SCHEMA);
  expect(levels.map((l) => [l.level, l.exportable])).toEqual([
    [1, true],
    [2, false],
  ]);
  expect(await rows("SELECT count(*)::INT AS n FROM pp_geom_1")).toEqual([{ n: 2 }]);
});

test("a coarser level keeps the input column order", async () => {
  await load();
  await runPackagePolygons(conn, SCHEMA);
  expect(await exportColumns("package_polygons_level_1")).toEqual([
    "geometry",
    "adm1_pcode",
    "adm1_name",
  ]);
});

test("mismatched name and code prefixes drop the finer names", async () => {
  await load(`SELECT adm2_pcode AS GID_2, adm1_pcode AS GID_1, adm2_name AS NAME_2,
    adm1_name AS NAME_1, ST_GeomFromText(wkt) AS geom FROM (${BASE})`);
  await runPackagePolygons(conn, { nameField: "NAME_{n}", codeField: "GID_{n}" });
  const columns = await exportColumns("package_polygons_level_1");
  expect(columns).toEqual(expect.arrayContaining(["GID_1", "NAME_1"]));
  expect(columns).not.toContain("GID_2");
  expect(columns).not.toContain("NAME_2");
});

test.todo("the finest level is skipped when its path equals the input (file output)");
test.todo("an output path template without {n} raises (file output)");
test.todo("the finest level is written when its path resolves elsewhere (file output)");
test.todo("overwrite=false raises on an existing coarser output (file output)");
test.todo("the issues path follows the same {n} template (file output)");
test.todo("output name/code templates rename written columns (no TS counterpart, py #83)");
test.todo("output templates require input templates (no TS counterpart, py #83)");
