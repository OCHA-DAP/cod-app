import { beforeAll, beforeEach, expect, test } from "vitest";
import { runDissolveCore } from "$lib/tools/package-polygons/pipeline/dissolveCore";
import { ready, rows, run } from "./helpers";

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

beforeEach(async () => {
  await run(`CREATE OR REPLACE TABLE t_01 AS SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'A1', 'Alpha', 10.0, 100, 'active', 1, 'junk1', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('P1', 'A2', 'Beta', 20.0, 200, 'pending', 1, 'junk2', ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('P2', 'B1', 'Gamma', 5.0, 50, 'inactive', 1, 'junk3', ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))'))
  ) AS v(adm1_pcode, adm2_pcode, adm2_name, area_sqkm, population, status, version, bbox, geom)`);
});

const outColumns = async () =>
  (await rows<{ column_name: string }>('DESCRIBE "t_out"')).map((r) => r.column_name);

test("varying numeric column is summed by default", async () => {
  await runDissolveCore(conn, "t_01", "t_out", { groupBy: ["adm1_pcode"] });
  expect(
    await rows(
      "SELECT adm1_pcode, area_sqkm::DOUBLE AS a, population::BIGINT AS p FROM t_out ORDER BY 1",
    ),
  ).toEqual([
    { adm1_pcode: "P1", a: 30, p: 300 },
    { adm1_pcode: "P2", a: 5, p: 50 },
  ]);
});

test("constant column is kept unaffected", async () => {
  await runDissolveCore(conn, "t_01", "t_out", { groupBy: ["adm1_pcode"] });
  expect(await rows("SELECT version FROM t_out")).toEqual([{ version: 1 }, { version: 1 }]);
});

test("varying non-numeric column is dropped", async () => {
  await runDissolveCore(conn, "t_01", "t_out", { groupBy: ["adm1_pcode"] });
  expect(await outColumns()).not.toContain("status");
});

test("noise column is excluded from output", async () => {
  await runDissolveCore(conn, "t_01", "t_out", { groupBy: ["adm1_pcode"] });
  expect(await outColumns()).not.toContain("bbox");
});

test("aggregation override replaces the default sum", async () => {
  await runDissolveCore(conn, "t_01", "t_out", {
    groupBy: ["adm1_pcode"],
    aggregations: { area_sqkm: "max" },
  });
  expect(await rows("SELECT adm1_pcode, area_sqkm::DOUBLE AS a FROM t_out ORDER BY 1")).toEqual([
    { adm1_pcode: "P1", a: 20 },
    { adm1_pcode: "P2", a: 5 },
  ]);
});

test("unsupported aggregation throws", async () => {
  await expect(
    runDissolveCore(conn, "t_01", "t_out", {
      groupBy: ["adm1_pcode"],
      aggregations: { area_sqkm: "median" as "max" },
    }),
  ).rejects.toThrow(/unsupported aggregation/);
});
