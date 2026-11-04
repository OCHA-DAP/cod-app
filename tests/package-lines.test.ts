import { beforeAll, expect, test } from "vitest";
import { runPackageLines } from "$lib/tools/package-lines/pipeline";
import { layer, ready, rows } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const A = "POLYGON((0 0,0 10,10 10,10 0,0 0))";
const B = "POLYGON((10 0,10 10,20 10,20 0,10 0))";
const C = "POLYGON((20 0,20 10,30 10,30 0,20 0))";

type Line = { a: string; b: string | null; lvl: number; wkt: string };

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const values = (rs: string[][]) =>
  rs.map((r) => `(${r.map((v) => `'${v}'`).join(", ")})`).join(", ");

async function lines(units: [string, string][], depthColumn?: string): Promise<Line[]> {
  await layer(
    `SELECT adm1_pcode, ST_GeomFromText(wkt) AS geom FROM (VALUES ${values(units)}) AS v(adm1_pcode, wkt)`,
  );
  await runPackageLines(conn, SCHEMA, depthColumn);
  return fetchLines();
}

const fetchLines = () =>
  rows<Line>(`SELECT a_code AS a, b_code AS b, adm_lvl::INT AS lvl, ST_AsText(geom) AS wkt
    FROM pl_geom JOIN pl_attr USING (fid)`);

test("two adjacent squares give one shared row", async () => {
  const shared = (
    await lines([
      ["A", A],
      ["B", B],
    ])
  ).filter((r) => r.b !== null);
  expect(shared).toHaveLength(1);
  expect(new Set([shared[0].a, shared[0].b])).toEqual(new Set(["A", "B"]));
});

test("a depth column colliding with an output column raises", async () => {
  await expect(
    lines(
      [
        ["A", A],
        ["B", B],
      ],
      "geom",
    ),
  ).rejects.toThrow(/geom/);
});

test("exterior rows have a null right code", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
  ]);
  expect(found.some((r) => r.b === null)).toBe(true);
});

test("the middle of three squares has two exterior lines", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
    ["C", C],
  ]);
  const middle = found.filter((r) => r.b === null && r.a === "B");
  expect(middle).toHaveLength(2);
  expect(middle.every((r) => r.wkt.startsWith("LINESTRING"))).toBe(true);
});

test("a corner touch gives no shared rows", async () => {
  const found = await lines([
    ["A", A],
    ["B", "POLYGON((10 10,10 20,20 20,20 10,10 10))"],
  ]);
  expect(found.filter((r) => r.b !== null)).toEqual([]);
});

test("a multi-part unit touching a neighbor and with a remote island", async () => {
  const found = await lines([
    ["A", "MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0)),((100 70,100 80,110 80,110 70,100 70)))"],
    ["B", B],
  ]);
  expect(found.filter((r) => r.b !== null)).toHaveLength(1);
  expect(found.some((r) => r.b === null && r.wkt.includes("100 70"))).toBe(true);
});

test("every input code appears at least once", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
    ["C", C],
  ]);
  const present = new Set([...found.map((r) => r.a), ...found.flatMap((r) => r.b ?? [])]);
  expect(present).toEqual(new Set(["A", "B", "C"]));
});

test("multi-level classification: same parent is finer, else coarser", async () => {
  const units = [
    ["P1", "X1", A],
    ["P1", "X2", B],
    ["P2", "Y1", C],
    ["P2", "Y2", "POLYGON((30 0,30 10,40 10,40 0,30 0))"],
  ];
  await layer(`SELECT adm1_pcode, adm2_pcode, ST_GeomFromText(wkt) AS geom
    FROM (VALUES ${values(units)}) AS v(adm1_pcode, adm2_pcode, wkt)`);
  await runPackageLines(conn, SCHEMA);
  const shared = await rows<{ x: number; lvl: number }>(`--sql
    SELECT ST_X(ST_PointN(geom, 1)) AS x, adm_lvl::INT AS lvl
    FROM pl_geom JOIN pl_attr USING (fid)
    WHERE b_code IS NOT NULL AND ST_X(ST_PointN(geom, 1)) = ST_X(ST_PointN(geom, 2))`);
  expect(Object.fromEntries(shared.map((r) => [r.x, r.lvl]))).toEqual({ 10: 2, 20: 1, 30: 2 });
});
