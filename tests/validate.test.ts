import { beforeAll, beforeEach, expect, test } from "vitest";
import { runValidate } from "$lib/tools/validate/pipeline";
import { layer, ready, run } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const DUPLICATE = `SELECT * REPLACE (CASE WHEN adm3_pcode = 'XY112' THEN 'XY111' ELSE adm3_pcode END AS adm3_pcode) FROM base`;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

// Three levels: 3 regions, 9 districts, 27 communes, as adjacent squares.
beforeEach(async () => {
  await run(`CREATE OR REPLACE TABLE base AS
    SELECT 'XY' || a AS adm1_pcode, 'Region ' || a AS adm1_name,
           'XY' || a || b AS adm2_pcode, 'District ' || a || b AS adm2_name,
           'XY' || a || b || c AS adm3_pcode, 'Commune ' || a || b || c AS adm3_name,
           ST_MakeEnvelope((a - 1) * 3 + b - 1, c - 1, (a - 1) * 3 + b, c) AS geom
    FROM range(1, 4) r1(a), range(1, 4) r2(b), range(1, 4) r3(c)`);
});

async function summary(select: string, schema: typeof SCHEMA | null = null) {
  await layer(select);
  return (await runValidate(conn, schema, "in")).issues;
}

const errors = (issues: Awaited<ReturnType<typeof summary>>) =>
  issues.some((r) => r.severity === "error");

test("clean layer", async () => {
  const issues = await summary("SELECT * FROM base");
  expect(errors(issues)).toBe(false);
  expect(issues.map((r) => r.stage)).toEqual(["schema", "topo", "code", "name"]);
  expect(new Set(issues.map((r) => r.reason))).toEqual(new Set(["no issues"]));
});

test("an error is counted in the summary", async () => {
  const issues = await summary(DUPLICATE, SCHEMA);
  expect(errors(issues)).toBe(true);
  expect(issues).toContainEqual(
    expect.objectContaining({
      stage: "code",
      kind: "duplicate-code",
      severity: "error",
      count: 1,
      report: "in_code_issues.csv",
      reason: "",
    }),
  );
});

test("undetected levels skip code and name", async () => {
  const issues = await summary("SELECT adm3_name AS label, geom FROM base");
  expect(errors(issues)).toBe(true);
  const found = new Set(issues.map((r) => `${r.stage}|${r.kind}|${r.severity}`));
  expect(found).toContain("schema|levels-undetected|error");
  expect(found).toContain("code|skipped|warn");
  expect(found).toContain("name|skipped|warn");
  expect((await runValidate(conn, null, "in")).ran).not.toContain("code");
});

test("a grouping column still runs code and name", async () => {
  const issues = await summary(
    "SELECT *, CASE WHEN adm1_pcode = 'XY3' THEN 'S' ELSE 'N' END AS zone FROM base",
  );
  expect(errors(issues)).toBe(false);
  const found = new Set(issues.map((r) => `${r.stage}|${r.kind}`));
  expect(found).toContain("schema|supplemental-column");
  expect(found).toContain("code|");
  expect(found).toContain("name|");
});

test.todo("a failing stage is recorded while the others run (needs a stage override hook)");
test.todo("a failing check is an error in the summary (needs a check override hook)");
test.todo("reports default beside the input (file output, no TS counterpart)");
test.todo("an existing report without overwrite raises (file output, no TS counterpart)");
test.todo("CSV summary starts with a BOM (export shape)");
