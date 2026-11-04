import { beforeAll, expect, test } from "vitest";
import { runPackagePoints } from "$lib/tools/package-points/pipeline";
import { exportColumns, layer, ready, rows } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const ROWS = `(VALUES
    ('P1', 'A1', 'Urban', 'POLYGON((0 0, 0 10, 10 10, 10 0, 0 0))'),
    ('P1', 'A2', 'Rural', 'POLYGON((10 0, 10 10, 20 10, 20 0, 10 0))'),
    ('P2', 'B1', 'Urban', 'POLYGON((0 10, 0 20, 10 20, 10 10, 0 10))')
  ) AS v(adm1_pcode, adm2_pcode, office_status, wkt)`;
const BASE = `SELECT adm1_pcode, adm2_pcode, ST_GeomFromText(wkt) AS geom FROM ${ROWS}`;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

async function points(select: string, schema: typeof SCHEMA | null = SCHEMA, depth?: string) {
  await layer(select);
  await runPackagePoints(conn, schema, depth);
}

const out = (select: string, tail = "") =>
  rows(`SELECT ${select} FROM pkpt_geom JOIN pkpt_attr USING (fid) ${tail}`);

test("an auto-detected code uses source naming and drops a finest-only attribute", async () => {
  await points(
    `SELECT adm1_pcode, adm2_pcode, office_status, ST_GeomFromText(wkt) AS geom FROM ${ROWS}`,
    null,
  );
  const columns = await exportColumns("package_points");
  expect(columns).toEqual(expect.arrayContaining(["pcode", "adm_lvl", "geometry"]));
  for (const c of ["adm1_pcode", "adm2_pcode", "office_status"]) expect(columns).not.toContain(c);
  expect(await out("pcode", "WHERE adm_lvl = 1 ORDER BY pcode")).toEqual([
    { pcode: "P1" },
    { pcode: "P2" },
  ]);
  expect(await out("pcode", "WHERE adm_lvl = 2 ORDER BY pcode")).toEqual([
    { pcode: "A1" },
    { pcode: "A2" },
    { pcode: "B1" },
  ]);
});

test("an auto-detected constant root becomes its own level-0 row", async () => {
  await points(`SELECT 'Z' AS adm0_pcode, 'Zed' AS adm0_name, * FROM (${BASE})`, null);
  const columns = await exportColumns("package_points");
  expect(columns).not.toContain("adm0_pcode");
  expect(columns).not.toContain("adm0_name");
  expect(await out("pcode, name", "WHERE adm_lvl = 0")).toEqual([{ pcode: "Z", name: "Zed" }]);
  expect(
    await out(
      "DISTINCT pcode, name",
      "WHERE adm_lvl != 0 AND pcode IN ('Z', 'P1', 'P2') ORDER BY pcode",
    ),
  ).toEqual([
    { pcode: "P1", name: null },
    { pcode: "P2", name: null },
  ]);
});

test("a word-anchored constant root becomes its own level-0 row", async () => {
  await points(
    `SELECT 'Z' AS country_code, 'Zed' AS country_name, adm1_pcode AS state_code,
      adm2_pcode AS county_code, geom FROM (${BASE})`,
    null,
  );
  const columns = await exportColumns("package_points");
  for (const c of ["country_code", "country_name", "state_code", "county_code"])
    expect(columns).not.toContain(c);
  expect(await out("code, name", "WHERE adm_lvl = 0")).toEqual([{ code: "Z", name: "Zed" }]);
  expect(
    await out(
      "DISTINCT code, name",
      "WHERE adm_lvl != 0 AND code IN ('Z', 'P1', 'P2') ORDER BY code",
    ),
  ).toEqual([
    { code: "P1", name: null },
    { code: "P2", name: null },
  ]);
});

test("row count matches units per level", async () => {
  await points(BASE);
  expect(await out("adm_lvl::INT AS l, count(*)::INT AS n", "GROUP BY 1 ORDER BY 1")).toEqual([
    { l: 1, n: 2 },
    { l: 2, n: 3 },
  ]);
});

test("every point is covered by its own polygon", async () => {
  await points(BASE);
  expect(
    await rows(`SELECT count(*)::INT AS n FROM pkpt_geom p JOIN pkpt_attr a USING (fid)
      JOIN (${BASE}) src ON src.adm2_pcode IS NOT DISTINCT FROM a.code
      WHERE a.adm_lvl = 2 AND NOT ST_Covers(src.geom, p.geom)`),
  ).toEqual([{ n: 0 }]);
});

test("each level's own code is generic, with no ancestor column", async () => {
  await points(BASE);
  const columns = await exportColumns("package_points");
  expect(columns).toEqual(expect.arrayContaining(["code", "adm_lvl", "geometry"]));
  expect(columns).not.toContain("adm1_pcode");
  expect(columns).not.toContain("adm2_pcode");
});

test("custom depth column", async () => {
  await points(BASE, SCHEMA, "level");
  const columns = await exportColumns("package_points");
  expect(columns).toContain("level");
  expect(columns).not.toContain("adm_lvl");
});

test("a depth column collision raises", async () => {
  await expect(points(`SELECT *, 2 AS adm_lvl FROM (${BASE})`)).rejects.toThrow(/adm_lvl/);
});

test.todo("each step runs standalone (no TS counterpart)");
test.todo("default output path (file output, no TS counterpart)");
