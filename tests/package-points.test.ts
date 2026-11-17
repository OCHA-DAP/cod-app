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
      JOIN (${BASE}) src ON src.adm2_pcode IS NOT DISTINCT FROM a.pcode
      WHERE a.adm_lvl = 2 AND NOT ST_Covers(src.geom, p.geom)`),
  ).toEqual([{ n: 0 }]);
});

test("each level's own code is generic, with no ancestor column", async () => {
  await points(BASE);
  const columns = await exportColumns("package_points");
  expect(columns).toEqual(expect.arrayContaining(["pcode", "adm_lvl", "geometry"]));
  expect(columns).not.toContain("adm1_pcode");
  expect(columns).not.toContain("adm2_pcode");
});

test("custom depth column", async () => {
  await points(BASE, SCHEMA, "level");
  const columns = await exportColumns("package_points");
  expect(columns).toContain("level");
  expect(columns).not.toContain("adm_lvl");
});

test("an existing depth column is replaced", async () => {
  await points(`SELECT *, 9 AS adm_lvl FROM (${BASE})`);
  expect(await out("pcode, adm_lvl::INT AS adm_lvl", "ORDER BY pcode")).toEqual([
    { pcode: "A1", adm_lvl: 2 },
    { pcode: "A2", adm_lvl: 2 },
    { pcode: "B1", adm_lvl: 2 },
    { pcode: "P1", adm_lvl: 1 },
    { pcode: "P2", adm_lvl: 1 },
  ]);
});

test.each([true, false])(
  "a bare constant-root code lands under code (names %s)",
  async (withNames) => {
    const names = withNames
      ? ", 'Zed' AS adm0_name, 'n' || adm1_pcode AS adm1_name, 'n' || adm2_pcode AS adm2_name"
      : "";
    await points(
      `SELECT 'Z' AS adm0, adm1_pcode AS adm1, adm2_pcode AS adm2${names}, geom FROM (${BASE})`,
      null,
    );
    const cols = withNames ? "code, name" : "code";
    expect(await out(cols, "WHERE adm_lvl = 0")).toEqual([
      withNames ? { code: "Z", name: "Zed" } : { code: "Z" },
    ]);
  },
);

test("an explicit schema keeps own-level siblings and drops ancestors", async () => {
  await layer(`SELECT 'Z' AS adm0_id, 'Zed' AS adm0_name, 'Zedd' AS adm0_name1, 'ZZ' AS adm0_pcode,
      adm1_pcode AS adm1_id, 'n' || adm1_pcode AS adm1_name, 'm' || adm1_pcode AS adm1_name1,
      'x' || adm1_pcode AS adm1_pcode,
      adm2_pcode AS adm2_id, 'n' || adm2_pcode AS adm2_name, 'm' || adm2_pcode AS adm2_name1,
      'x' || adm2_pcode AS adm2_pcode, '2020-01-01' AS valid_on, geom
    FROM (${BASE})`);
  await runPackagePoints(conn, { nameField: "adm{n}_name", codeField: "adm{n}_id" });
  expect(await exportColumns("package_points")).toEqual([
    "geometry",
    "id",
    "name",
    "name1",
    "pcode",
    "adm_lvl",
  ]);
  expect(await out("adm_lvl::INT AS l, id, name, name1, pcode", "ORDER BY adm_lvl, id")).toEqual([
    { l: 0, id: "Z", name: "Zed", name1: "Zedd", pcode: "ZZ" },
    { l: 1, id: "P1", name: "nP1", name1: "mP1", pcode: "xP1" },
    { l: 1, id: "P2", name: "nP2", name1: "mP2", pcode: "xP2" },
    { l: 2, id: "A1", name: "nA1", name1: "mA1", pcode: "xA1" },
    { l: 2, id: "A2", name: "nA2", name1: "mA2", pcode: "xA2" },
    { l: 2, id: "B1", name: "nB1", name1: "mB1", pcode: "xB1" },
  ]);
});

test("an unanchored level writes generic code and name", async () => {
  await points(
    `SELECT 'Z' AS adm0_pcode, 'Zed' AS adm0_name, adm2_pcode AS adm1_pcode,
      'n' || adm2_pcode AS adm1_name, '2020' AS valid_on, geom FROM (${BASE})`,
    null,
  );
  expect(await exportColumns("package_points")).toEqual(["geometry", "code", "name", "adm_lvl"]);
  expect(await out("code, name, adm_lvl::INT AS adm_lvl", "ORDER BY ALL")).toEqual([
    { code: "A1", name: "nA1", adm_lvl: 1 },
    { code: "A2", name: "nA2", adm_lvl: 1 },
    { code: "B1", name: "nB1", adm_lvl: 1 },
  ]);
});

test("a name varying within a unit is left out, not a crash", async () => {
  await points(`SELECT adm1_pcode, adm2_pcode, CASE adm2_pcode WHEN 'A2' THEN 'B' ELSE 'A' END AS adm1_name,
    adm2_pcode AS adm2_name, geom FROM (${BASE})`);
  expect(await out("pcode", "WHERE adm_lvl = 1 ORDER BY pcode")).toEqual([
    { pcode: "P1" },
    { pcode: "P2" },
  ]);
});

test("a min level above every level throws", async () => {
  await layer(BASE);
  await expect(runPackagePoints(conn, SCHEMA, undefined, 9)).rejects.toThrow(
    "no admin level at or above min level 9",
  );
});

test("a generic name clash throws", async () => {
  await layer(
    `SELECT * FROM (VALUES
      ('P1', 'p1', 'p1x', 'P1A0', 'nP10', 'nP10x', 'POLYGON((0 0,0 10,10 10,10 0,0 0))'),
      ('P1', 'p1', 'p1x', 'P1A1', 'nP11', 'nP11x', 'POLYGON((10 0,10 10,20 10,20 0,10 0))'),
      ('P2', 'p2', 'p2x', 'P2A0', 'nP20', 'nP20x', 'POLYGON((20 0,20 10,30 10,30 0,20 0))'),
      ('P2', 'p2', 'p2x', 'P2A1', 'nP21', 'nP21x', 'POLYGON((30 0,30 10,40 10,40 0,30 0))')
    ) AS v(adm1_pcode, adm1_name, adm1name, adm2_pcode, adm2_name, adm2name, wkt)`.replace(
      "SELECT * FROM",
      "SELECT * EXCLUDE (wkt), ST_GeomFromText(wkt) AS geom FROM",
    ),
  );
  await expect(runPackagePoints(conn, null)).rejects.toThrow("reduces to unusable name 'name'");
});

test.todo("each step runs standalone (no TS counterpart)");
test.todo("default output path (file output, no TS counterpart)");
