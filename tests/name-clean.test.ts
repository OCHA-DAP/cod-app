import { beforeEach, beforeAll, expect, test } from "vitest";
import { runNameClean } from "$lib/tools/name-clean/pipeline";
import { ready, rows, run } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_code" };
const FILLER = ["Theta", "Iota", "Kappa", "Lambda", "Omicron", "Sigma", "Upsilon", "Phi"];
const NAMES: Record<string, string> = {
  XY0101: " Gamma  ",
  XY0102: "SÃ©gou",
  XY0103: "Vie\u0323\u0302t",
  XY0104: "Del​ta",
  XY0105: "RÍ\u008dO",
  XY0106: "KING FAHAD CAUSWAY",
  XY0107: "Alpha",
  XY0108: "Alpha",
};
const FIXED: Record<string, string> = {
  XY0101: "Gamma",
  XY0102: "Ségou",
  XY0103: "Vi\u1ec7t",
  XY0104: "Delta",
};

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

beforeEach(async () => {
  const all = [
    ...Object.entries(NAMES),
    ...FILLER.map((n, i) => [`XY01${String(i + 20).padStart(2, "0")}`, n]),
  ];
  const values = all.map(([c, n], i) => `(${i + 1}, 'XY01', 'North', '${c}', '${n}', ${i})`);
  await run(`CREATE OR REPLACE TABLE _names AS SELECT * FROM (VALUES ${values.join(", ")})
    AS v(fid, adm1_code, adm1_name, adm2_code, adm2_name, x)`);
  await run("CREATE OR REPLACE TABLE layer_01 AS SELECT fid, ST_Point(x, 0) AS geom FROM _names");
  await run("CREATE OR REPLACE TABLE layer_attr AS SELECT * EXCLUDE (x) FROM _names");
});

test("safe fixes are applied, the rest left untouched", async () => {
  await runNameClean(conn, SCHEMA);
  const names = Object.fromEntries(
    (
      await rows<{ c: string; n: string }>("SELECT adm2_code AS c, adm2_name AS n FROM nc_attr")
    ).map(({ c, n }) => [c, n]),
  );
  expect(Object.keys(names)).toHaveLength(Object.keys(NAMES).length + FILLER.length);
  for (const [code, name] of Object.entries(NAMES))
    expect(names[code], code).toBe(FIXED[code] ?? name);
});

test("report marks fixed rows", async () => {
  const { issues } = await runNameClean(conn, SCHEMA);
  expect(new Set(issues.filter((r) => r.fixed).map((r) => r.codeA))).toEqual(
    new Set(Object.keys(FIXED)),
  );
  expect(new Set(issues.filter((r) => !r.fixed).map((r) => r.kind))).toEqual(
    new Set(["case-outlier", "duplicate-name", "encoding-artifact"]),
  );
});

test.todo("cleaned output leads with the geometry column (export shape, covered by export tests)");
