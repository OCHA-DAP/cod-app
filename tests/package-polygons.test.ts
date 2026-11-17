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

test("an auto-detected constant root writes a one-row admin0", async () => {
  await load(`SELECT 'SEN' AS adm0_pcode, 'Senegal' AS adm0_name, adm1_pcode, adm1_name,
    adm2_pcode, adm2_name, ST_GeomFromText(wkt) AS geom FROM (${BASE})`);
  const { levels } = await runPackagePolygons(conn, null);
  expect(levels.map((l) => l.level)).toEqual([0, 1, 2]);
  expect(await rows("SELECT adm0_pcode, adm0_name FROM pp_attr_0")).toEqual([
    { adm0_pcode: "SEN", adm0_name: "Senegal" },
  ]);
});

test("a constant root takes its own level number", async () => {
  await load(`SELECT 'SN01' AS adm1_pcode, adm1_pcode AS adm2_pcode, adm2_pcode AS adm3_pcode,
    ST_GeomFromText(wkt) AS geom FROM (${BASE})`);
  const { levels } = await runPackagePolygons(conn, null);
  expect(levels.map((l) => l.level)).toEqual([1, 2, 3]);
  expect(await rows("SELECT adm1_pcode FROM pp_attr_1")).toEqual([{ adm1_pcode: "SN01" }]);
});

test("min level leaves out coarser levels", async () => {
  await load();
  const { levels } = await runPackagePolygons(conn, SCHEMA, 2);
  expect(levels.map((l) => l.level)).toEqual([2]);
});

test("a min level above every level throws", async () => {
  await load();
  await expect(runPackagePolygons(conn, SCHEMA, 9)).rejects.toThrow(
    "no admin level at or above min level 9",
  );
});

test.todo("the finest level is skipped when its path equals the input (file output)");
test.todo("an output path template without {n} raises (file output)");
test.todo("the finest level is written when its path resolves elsewhere (file output)");
test.todo("overwrite=false raises on an existing coarser output (file output)");
test.todo("the issues path follows the same {n} template (file output)");
test.todo("output name/code templates rename written columns (no TS counterpart, py #83)");
test.todo("output templates require input templates (no TS counterpart, py #83)");
