import { beforeAll, beforeEach, expect, test } from "vitest";
import { runSchemaDetect } from "$lib/tools/schema-detect/pipeline";
import { layer, ready, rows, run } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const MODES = [
  ["explicit", SCHEMA],
  ["structural", null],
] as const;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

// Three levels under one constant root: 3 x 3 x 3 units, two name columns.
beforeEach(async () => {
  await run(`CREATE OR REPLACE TABLE base AS
    SELECT 'XY' AS adm0_pcode, 'Country' AS adm0_name, 'Pays' AS adm0_name1,
           'XY' || a AS adm1_pcode, 'Region ' || x AS adm1_name, 'Région ' || x AS adm1_name1,
           'XY' || a || b AS adm2_pcode, 'District ' || x || y AS adm2_name,
           'District FR ' || x || y AS adm2_name1,
           'XY' || a || b || c AS adm3_pcode, 'Commune ' || x || y || z AS adm3_name,
           'Commune FR ' || x || y || z AS adm3_name1,
           ST_Point(a * 10 + b, c) AS geom
    FROM (
      SELECT a, b, c, chr(64 + a::INTEGER) AS x, chr(64 + b::INTEGER) AS y, chr(64 + c::INTEGER) AS z
      FROM range(1, 4) r1(a), range(1, 4) r2(b), range(1, 4) r3(c)
    )`);
});

async function kinds(select: string, schema: typeof SCHEMA | null = SCHEMA) {
  await layer(select);
  await runSchemaDetect(conn, schema);
  return new Set(
    (
      await rows<{ k: string; s: string; l: number | null; c: string | null }>(
        'SELECT kind AS k, severity AS s, level::INT AS l, "column" AS c FROM sd_report',
      )
    ).map(({ k, s, l, c }) => `${k}|${s}|${l}|${c}`),
  );
}

test.each(MODES)("clean layer gives an empty report (%s)", async (_, schema) => {
  expect(await kinds("SELECT * FROM base", schema)).toEqual(new Set());
});

test.each(MODES)("column naming (%s)", async (_, schema) => {
  expect(await kinds("SELECT * RENAME (adm2_name1 AS ADM2_NAME1) FROM base", schema)).toEqual(
    new Set(["column-naming|warn|2|ADM2_NAME1"]),
  );
});

test("column-set mismatch", async () => {
  expect(await kinds("SELECT * EXCLUDE (adm2_name1) FROM base")).toEqual(
    new Set(["column-set-mismatch|warn|2|null"]),
  );
});

test("a family at one level is not a mismatch", async () => {
  expect(await kinds("SELECT *, adm3_name AS adm3_ref_name FROM base")).toEqual(new Set());
});

test("level skipped", async () => {
  expect(await kinds("SELECT * EXCLUDE (adm2_pcode, adm2_name, adm2_name1) FROM base")).toContain(
    "level-skipped|error|2|null",
  );
});

test("multiple parents", async () => {
  const select = `SELECT * REPLACE (CASE WHEN adm3_pcode = 'XY111' THEN 'XY2' ELSE adm1_pcode END AS adm1_pcode) FROM base`;
  expect(await kinds(select)).toEqual(new Set(["multiple-parents|error|2|adm2_pcode"]));
});

test("orphan child", async () => {
  const select = `SELECT * REPLACE (CASE WHEN adm2_pcode = 'XY11' THEN NULL ELSE adm1_pcode END AS adm1_pcode) FROM base`;
  expect(await kinds(select)).toEqual(new Set(["orphan-child|error|2|adm2_pcode"]));
});

test("undetected levels are reported, not thrown", async () => {
  expect(
    await kinds("SELECT * FROM base", { nameField: "lvl{n}_name", codeField: "lvl{n}_code" }),
  ).toEqual(new Set(["levels-undetected|error|null|null"]));
});

test("a grouping column is a warning, not a refusal", async () => {
  const select = "SELECT *, CASE WHEN adm1_pcode = 'XY3' THEN 'S' ELSE 'N' END AS zone FROM base";
  expect(await kinds(select, null)).toEqual(new Set(["supplemental-column|warn|null|zone"]));
});

test.each(MODES)("a nameless layer reports undetected levels (%s)", async (_, schema) => {
  await layer("SELECT COLUMNS('pcode'), geom FROM base");
  await runSchemaDetect(conn, schema);
  const found = await rows<{ reason: string }>(
    "SELECT reason FROM sd_report WHERE kind = 'levels-undetected'",
  );
  expect(found).toHaveLength(1);
  expect(found[0].reason).toContain("no admin level with both a code and a name");
});

test.todo(
  "a failing check is reported as check-failed while the others run (needs a check override hook)",
);
