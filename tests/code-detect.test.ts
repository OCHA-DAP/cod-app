import { beforeAll, beforeEach, expect, test } from "vitest";
import { runCodeDetect } from "$lib/tools/code-detect/pipeline";
import { layer, ready, rows, run } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const DUPLICATE = `SELECT * REPLACE (CASE WHEN adm3_pcode = 'XY112' THEN 'XY111' ELSE adm3_pcode END AS adm3_pcode) FROM base`;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

// Three levels: 3 regions, 12 districts, 48 communes, one feature each.
beforeEach(async () => {
  await run(`CREATE OR REPLACE TABLE base AS
    SELECT 'XY' || a AS adm1_pcode, 'Region ' || a AS adm1_name,
           'XY' || a || b AS adm2_pcode, 'District ' || a || b AS adm2_name,
           'XY' || a || b || c AS adm3_pcode, 'Commune ' || a || b || c AS adm3_name,
           ST_Point(a * 10 + b, c) AS geom
    FROM range(1, 4) r1(a), range(1, 5) r2(b), range(1, 5) r3(c)`);
});

async function report(select: string, schema: typeof SCHEMA | null = SCHEMA) {
  await layer(select);
  await runCodeDetect(conn, schema);
  return rows<{
    kind: string;
    severity: string;
    level: number | null;
    code_a: string | null;
    reason: string;
  }>("SELECT kind, severity, level::INT AS level, code_a, reason FROM cd_report");
}

async function kinds(select: string) {
  return new Set(
    (await report(select)).map((r) => `${r.kind}|${r.severity}|${r.level}|${r.code_a}`),
  );
}

test.each([
  ["explicit", SCHEMA],
  ["structural", null],
] as const)("clean layer gives an empty report (%s)", async (_, schema) => {
  expect(await report("SELECT * FROM base", schema)).toEqual([]);
});

test("a blank code is reported once per parent", async () => {
  const r = await report(
    `SELECT * REPLACE (CASE WHEN adm3_pcode IN ('XY111', 'XY112') THEN NULL ELSE adm3_pcode END AS adm3_pcode) FROM base`,
  );
  expect(r.map((x) => x.kind)).toEqual(["blank-code"]);
  expect(r[0].reason.startsWith("2 units under XY11 have no code")).toBe(true);
});

test("name conflict", async () => {
  expect(
    await kinds(
      `SELECT * REPLACE (CASE WHEN adm3_pcode = 'XY111' THEN 'Other' ELSE adm2_name END AS adm2_name) FROM base`,
    ),
  ).toEqual(new Set(["name-conflict|error|2|XY11"]));
});

test("duplicate code", async () => {
  expect(await kinds(DUPLICATE)).toContain("duplicate-code|error|3|XY111");
});

test("split unit", async () => {
  expect(
    await kinds("SELECT * FROM base UNION ALL SELECT * FROM base WHERE adm3_pcode = 'XY111'"),
  ).toEqual(new Set(["split-unit|warn|3|XY111"]));
});

test("prefix mismatch", async () => {
  expect(
    await kinds(`SELECT * REPLACE (
      CASE WHEN adm2_pcode = 'XY11' THEN 'XY2' ELSE adm1_pcode END AS adm1_pcode,
      CASE WHEN adm2_pcode = 'XY11' THEN 'Region 2' ELSE adm1_name END AS adm1_name) FROM base`),
  ).toEqual(new Set(["prefix-mismatch|error|2|XY11"]));
});

test("format outlier", async () => {
  expect(
    await kinds(
      `SELECT * REPLACE (CASE WHEN adm3_pcode = 'XY111' THEN 'XY11-1' ELSE adm3_pcode END AS adm3_pcode) FROM base`,
    ),
  ).toEqual(new Set(["format-outlier|warn|3|XY11-1"]));
});

test("format undetected", async () => {
  expect(
    await kinds(`SELECT * REPLACE (CASE WHEN right(adm3_pcode, 1) IN ('3', '4')
      THEN adm2_pcode || '0' || right(adm3_pcode, 1) ELSE adm3_pcode END AS adm3_pcode) FROM base`),
  ).toEqual(new Set(["format-undetected|warn|3|null"]));
});

test("few codes skip the format checks", async () => {
  const found = [
    ...(await kinds(
      `SELECT * REPLACE (CASE WHEN adm1_pcode = 'XY1' THEN 'XY-1' ELSE adm1_pcode END AS adm1_pcode) FROM base`,
    )),
  ].map((k) => k.split("|")[0]);
  expect(found).not.toContain("format-outlier");
  expect(found).not.toContain("format-undetected");
});

test.todo(
  "a failing check is reported as check-failed while the others run (needs a check override hook)",
);
test.todo("Parquet report carries each unit's geometry (export shape)");
