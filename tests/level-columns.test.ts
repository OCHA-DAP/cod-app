import { beforeAll, expect, test } from "vitest";
import {
  detectLeafLevel,
  detectLevelColumns,
  detectRootLevel,
  groupFamiliesByLevel,
  isLevelIdentityColumn,
  verifyFunctionalCluster,
  type LevelColumns,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { ready, run } from "./helpers";

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const t01 = (sql: string) => run(`CREATE OR REPLACE TABLE t_01 AS ${sql}`);
const levels = (m: Map<number, LevelColumns>) => [...m.keys()].sort((a, b) => a - b);
const finest = (m: Map<number, LevelColumns>) => m.get(Math.max(...m.keys()))!;
const set = (xs: string[]) => new Set(xs);

const TWO_LEVEL = `SELECT row_number() OVER () AS fid, * FROM (VALUES
  ('P1', 'A1', 'Province1', 'Alpha', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
  ('P1', 'A2', 'Province1', 'Beta', ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
  ('P2', 'B1', 'Province2', 'Gamma', ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))'))
) AS v(adm1_pcode, adm2_pcode, adm1_name, adm2_name, geom)`;

const sq = (i: number) => `POLYGON((${i} 0,${i + 1} 0,${i + 1} 1,${i} 1,${i} 0))`;

const ADM2_CHILDREN: Record<string, string[]> = {
  C0A1: ["5001", "5002", "5003"],
  C0A2: ["5004", "5005", "5006"],
  C0B1: ["5007", "5008", "5009"],
  C0B2: ["5010", "5011", "5012"],
};
const ADM1_OF: Record<string, string> = { C0A1: "C0A", C0A2: "C0A", C0B1: "C0B", C0B2: "C0B" };
const ADM1_CHILDREN: Record<string, string[]> = {
  C0A: ["5001", "5002", "5003", "5004", "5005", "5006"],
  C0B: ["5007", "5008", "5009", "5010", "5011", "5012"],
};

test.each<[string, string, string, string, boolean]>([
  ["adm3_pcode", "adm", "3", "_pcode", true],
  ["adm3_name2", "adm", "3", "_pcode", true],
  ["adm4_pcode", "adm", "3", "_pcode", false],
  ["area_sqkm", "adm", "3", "_pcode", false],
  ["state_name", "", "state", "_code", true],
  ["code_state", "code_", "state", "", true],
  ["code_county", "code_", "state", "", false],
])("isLevelIdentityColumn(%s, %s, %s, %s) is %s", (name, prefix, anchor, suffix, expected) => {
  expect(isLevelIdentityColumn(name, prefix, anchor, suffix)).toBe(expected);
});

test("finds a coarser and finer level", async () => {
  await t01(TWO_LEVEL);
  const result = await detectLevelColumns(conn, "t_01");
  const [coarser, finer] = levels(result);
  expect(set(result.get(coarser)!.groupBy)).toEqual(set(["adm1_pcode", "adm1_name"]));
  expect(set(result.get(finer)!.groupBy)).toEqual(set(["adm2_pcode", "adm2_name"]));
  expect(set(result.get(coarser)!.identityColumns)).toEqual(set(["adm1_pcode", "adm1_name"]));
  expect(set(result.get(finer)!.identityColumns)).toEqual(set(["adm2_pcode", "adm2_name"]));
});

test("excludes a bijective lookalike from identity", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'A1', 1.5, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('P1', 'A2', 2.5, ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('P2', 'B1', 3.5, ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))'))
  ) AS v(adm1_pcode, adm2_pcode, area_sqkm, geom)`);
  expect(finest(await detectLevelColumns(conn, "t_01")).identityColumns).not.toContain("area_sqkm");
});

test("name column ignores digit-shaped numeric attributes", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'Alphaland', 12.5, 1.1, 2.1, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('P2', 'Betaland', 34.5, 3.3, 4.4, ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('P3', 'Gammaland', 56.5, 5.5, 6.6, ST_GeomFromText('POLYGON((2 0,3 0,3 1,2 1,2 0))'))
  ) AS v(adm1_pcode, adm1_name, area_sqkm, center_lat, center_lon, geom)`);
  const result = await detectLevelColumns(conn, "t_01");
  expect(result.size).toBe(1);
  expect(finest(result).nameColumn).toBe("adm1_name");
});

test("ignores a floating-point embed coincidence", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('C0', 'C0A', 'Alpha', 1, 100.0, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('C0', 'C0B', 'Beta', 1, 210.0, ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('C0', 'C0C', 'Gamma', 1, 310.0, ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))')),
    ('C0', 'C0D', 'Delta', 2, 420.0, ST_GeomFromText('POLYGON((1 1,2 1,2 2,1 2,1 1))'))
  ) AS v(adm0_pcode, adm1_pcode, adm1_name, multipart, area_sqkm, geom)`);
  const result = await detectLevelColumns(conn, "t_01");
  expect(result.size).toBe(1);
  expect(set(finest(result).groupBy)).toEqual(set(["adm1_pcode", "adm1_name", "area_sqkm"]));
});

test("finds a flat, non-embedding finest level", async () => {
  const values: string[] = [];
  let i = 0;
  for (const [adm2, children] of Object.entries(ADM2_CHILDREN)) {
    for (const adm3 of children)
      values.push(`('${ADM1_OF[adm2]}', '${adm2}', '${adm3}', ST_GeomFromText('${sq(i++)}'))`);
  }
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, *
    FROM (VALUES ${values.join(", ")}) AS v(adm1_pcode, adm2_pcode, adm3_pcode, geom)`);
  expect(finest(await detectLevelColumns(conn, "t_01")).groupBy).toEqual(["adm3_pcode"]);
});

test("finds a zero-padded middle level", async () => {
  await t01(`SELECT row_number() OVER () AS fid, 'XY' AS adm0_pcode,
      'Country' AS adm0_name, 'en' AS lang1, 'fr' AS lang2,
      'XY' || a || '0000' AS adm1_pcode, 'Region ' || a AS adm1_name,
      'XY' || a || b || '000' AS adm2_pcode, 'District ' || a || b AS adm2_name,
      'XY' || a || b || c || d AS adm3_pcode, 'Commune ' || a || b || c || d AS adm3_name,
      ST_MakeEnvelope(a * 10 + b, c * 10 + d, a * 10 + b + 1, c * 10 + d + 1) AS geom
    FROM range(1, 4) r1(a), range(1, 4) r2(b), range(1, 4) r3(c), range(1, 4) r4(d)`);
  const result = await detectLevelColumns(conn, "t_01");
  const groupBys = levels(result).map((l) => [...result.get(l)!.groupBy].sort().join(","));
  expect(groupBys).toContain("adm2_name,adm2_pcode");
});

test("ignores coincidentally embedding sparse columns", async () => {
  const values: string[] = [];
  let i = 0;
  for (const [adm2, children] of Object.entries(ADM2_CHILDREN)) {
    for (const adm3 of children) {
      const audit = i === 0 ? "' '" : "NULL";
      values.push(
        `('${ADM1_OF[adm2]}', '${adm2}', '${adm3}', ${audit}, ST_GeomFromText('${sq(i++)}'))`,
      );
    }
  }
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, *
    FROM (VALUES ${values.join(", ")}) AS v(adm1_pcode, adm2_pcode, adm3_pcode, comments, geom)`);
  for (const c of ["focus_id", "mod_by", "progres_id"]) {
    await run(`ALTER TABLE t_01 ADD COLUMN ${c} VARCHAR`);
  }
  await run("UPDATE t_01 SET focus_id = comments, mod_by = comments, progres_id = comments");
  const result = await detectLevelColumns(conn, "t_01");
  expect([...result.values()].some((lc) => lc.groupBy.includes("adm1_pcode"))).toBe(true);
  expect(finest(result).groupBy).toEqual(["adm3_pcode"]);
});

test("ignores low-cardinality date chains", async () => {
  const values: string[] = [];
  let i = 0;
  for (const [adm1, children] of Object.entries(ADM1_CHILDREN)) {
    for (const f of children) {
      const created = i % 2 === 0 ? "2023-04-15" : "2023-06-01";
      // The last row was re-edited, breaking the created/update bijection.
      const updated = i === 11 ? "2023-07-01" : created;
      values.push(
        `('${adm1}', '${adm1}${f}', DATE '${created}', DATE '${updated}', ST_GeomFromText('${sq(i++)}'))`,
      );
    }
  }
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, *
    FROM (VALUES ${values.join(", ")}) AS v(adm1_pcode, finest_pcode, created_date, update_date, geom)`);
  const result = await detectLevelColumns(conn, "t_01");
  expect([...result.values()].some((lc) => lc.groupBy.join() === "adm1_pcode")).toBe(true);
  expect(finest(result).groupBy).toContain("finest_pcode");
});

function scatteredValues(): string {
  const values: string[] = [];
  let i = 0;
  for (const [adm1, children] of Object.entries(ADM1_CHILDREN)) {
    for (const f of children) {
      const u = i % 2 === 0 ? "ADMIN" : "WRITER";
      values.push(`('${adm1}', '${adm1}${f}', '${u}', ST_GeomFromText('${sq(i++)}'))`);
    }
  }
  return values.join(", ");
}

async function expectScatteredIgnored() {
  const result = await detectLevelColumns(conn, "t_01");
  expect([...result.values()].some((lc) => lc.groupBy.includes("update_by"))).toBe(false);
  expect([...result.values()].some((lc) => lc.groupBy.join() === "adm1_pcode")).toBe(true);
  expect(finest(result).groupBy).toContain("finest_pcode");
}

test("ignores a spatially scattered tolerance embed", async () => {
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, 'WRITER' AS created_user, *
    FROM (VALUES ${scatteredValues()}) AS v(adm1_pcode, finest_pcode, update_by, geom)`);
  await expectScatteredIgnored();
});

test("ignores a spatially scattered root freebie", async () => {
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, *
    FROM (VALUES ${scatteredValues()}) AS v(adm1_pcode, finest_pcode, update_by, geom)`);
  await expectScatteredIgnored();
});

test("word-based anchor in both positions", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'A1', NULL, NULL, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('P1', 'A2', NULL, NULL, ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('P2', 'B1', NULL, NULL, ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))'))
  ) AS v(state_code, county_code, state_name_alt, county_name_alt, geom)`);
  const result = await detectLevelColumns(conn, "t_01");
  const [state, county] = levels(result);
  expect(result.get(state)!.identityColumns).toContain("state_name_alt");
  expect(result.get(county)!.identityColumns).toContain("county_name_alt");
});

test("throws when no level is found", async () => {
  await t01(
    "SELECT row_number() OVER () AS fid, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))') AS geom",
  );
  await expect(detectLevelColumns(conn, "t_01")).rejects.toThrow(
    /no admin hierarchy level detected/,
  );
});

test("verifyFunctionalCluster throws on a fragmenting member", async () => {
  await t01("SELECT * FROM (VALUES ('P1', 'x'), ('P1', 'y'), ('P2', 'z')) AS v(code, extra)");
  await expect(verifyFunctionalCluster(conn, "t_01", "code", ["code", "extra"])).rejects.toThrow(
    /grouping by/,
  );
});

test("verifyFunctionalCluster passes on matching cardinality", async () => {
  await t01("SELECT * FROM (VALUES ('P1', 'x'), ('P1', 'x'), ('P2', 'y')) AS v(code, extra)");
  await verifyFunctionalCluster(conn, "t_01", "code", ["code", "extra"]);
});

test("detectRootLevel, digit-anchored", async () => {
  await t01(`SELECT row_number() OVER () AS fid, 'C0' AS adm0_pcode, 'Country0' AS adm0_name, *
    FROM (VALUES ('P1', 'A1'), ('P1', 'A2'), ('P2', 'B1')) AS v(adm1_pcode, adm2_pcode)`);
  const root = await detectRootLevel(conn, "t_01", await detectLevelColumns(conn, "t_01"));
  expect(root).not.toBeNull();
  expect(set(root!.identityColumns)).toEqual(set(["adm0_pcode", "adm0_name"]));
  expect(root!.groupBy).toEqual([]);
});

test("detectRootLevel, word-anchored", async () => {
  await t01(`SELECT row_number() OVER () AS fid, 'US' AS country_code, 'USA' AS country_name, *
    FROM (VALUES ('P1', 'A1'), ('P1', 'A2'), ('P2', 'B1')) AS v(state_code, county_code)`);
  const root = await detectRootLevel(conn, "t_01", await detectLevelColumns(conn, "t_01"));
  expect(root).not.toBeNull();
  expect(set(root!.identityColumns)).toEqual(set(["country_code", "country_name"]));
});

test("finds a trailing name-only leaf", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'Province1', 'A1', 'AlphaCounty', 'Ward1', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
    ('P1', 'Province1', 'A2', 'BetaCounty', 'Ward2', ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))')),
    ('P2', 'Province2', 'B1', 'GammaCounty', 'Ward1', ST_GeomFromText('POLYGON((0 1,1 1,1 2,0 2,0 1))')),
    ('P2', 'Province2', 'B2', 'DeltaCounty', 'Ward2', ST_GeomFromText('POLYGON((1 1,2 1,2 2,1 2,1 1))')),
    ('P3', 'Province3', 'C1', 'EpsilonCounty', 'Ward3', ST_GeomFromText('POLYGON((2 0,3 0,3 1,2 1,2 0))'))
  ) AS v(adm1_pcode, adm1_name, adm2_pcode, adm2_name, adm3_name, geom)`);
  const result = await detectLevelColumns(conn, "t_01");
  const leaf = Math.max(...result.keys());
  expect(result.get(leaf)!.groupBy).toEqual(["adm3_name"]);
  expect(result.get(leaf)!.hasCode).toBe(false);
  expect(result.get(leaf - 1)!.groupBy).not.toContain("adm3_name");
});

test("detectLeafLevel returns null without a naming anchor", async () => {
  await t01(TWO_LEVEL);
  expect(await detectLeafLevel(conn, "t_01", await detectLevelColumns(conn, "t_01"))).toBeNull();
});

test("groupFamiliesByLevel, word-based anchor", async () => {
  await t01(`SELECT row_number() OVER () AS fid, * FROM (VALUES
    ('P1', 'A1', 'Province1', 'Alpha'), ('P1', 'A2', 'Province1', 'Beta'), ('P2', 'B1', 'Province2', 'Gamma')
  ) AS v(state_code, county_code, state_name, county_name)`);
  const families = await groupFamiliesByLevel(conn, "t_01", await detectLevelColumns(conn, "t_01"));
  const codeFamily = [...families.values()].find((f) => [...f.values()].includes("state_code"))!;
  expect(set([...codeFamily.values()])).toEqual(set(["state_code", "county_code"]));
});

test("digit-only name breaks a tie by schema marker", async () => {
  await t01(`SELECT * FROM (VALUES
    ('51', 'North', '0101', '101'), ('51', 'North', '0102', '102'), ('51', 'North', '0103', '103'),
    ('52', 'South', '0201', '201'), ('52', 'South', '0202', '202'), ('52', 'South', '0203', '203')
  ) AS v(adm1_code, adm1_name, adm2_code, adm2_name)`);
  const level = (await detectLevelColumns(conn, "t_01")).get(2)!;
  expect(level.groupBy[0]).toBe("adm2_code");
  expect(level.nameColumn).toBe("adm2_name");
});

test("verifyFunctionalCluster throws on a coarser member under parent", async () => {
  await t01(`SELECT * FROM (VALUES ('P1', 'c1', 'g1'), ('P1', 'c2', 'g1'), ('P1', 'c3', 'g2'), ('P1', 'c4', 'g2'))
    AS v(parent, code, extra)`);
  await expect(
    verifyFunctionalCluster(conn, "t_01", "code", ["code", "extra"], "parent"),
  ).rejects.toThrow(/coarser level merged/);
});

test("verifyFunctionalCluster passes on a duplicate name under parent", async () => {
  await t01(`SELECT * FROM (VALUES ('P1', 'c1', 'n1'), ('P1', 'c2', 'n2'), ('P1', 'c3', 'n3'), ('P1', 'c4', 'n3'))
    AS v(parent, code, extra)`);
  await verifyFunctionalCluster(conn, "t_01", "code", ["code", "extra"], "parent");
});
