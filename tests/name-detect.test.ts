import { beforeAll, expect, test } from "vitest";
import { runNameDetect } from "$lib/tools/name-detect/pipeline";
import { ready, run } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_code" };
const FILLER = ["Theta", "Iota", "Kappa", "Lambda", "Omicron", "Sigma", "Upsilon", "Phi"];
const AR = (i: number) => `اسم ${i}`;
type Row = [string, string, string | null, string | null, string | null];

// adm1 code and name, adm2 code, name and Arabic name; non-ASCII kept as escapes.
const ROWS: Row[] = [
  ["XY01", "North", "XY0101", "Alpha", "ألفا"],
  ["XY01", "North", "XY0102", "Alpha", "ألفا"],
  ["XY01", "North", "XY0103", "Al-Beta", "بيتا"],
  ["XY01", "North", "XY0104", "al beta", "بيتا ٢"],
  ["XY01", "North", "XY0105", " Gamma  ", "غاما"],
  ["XY02", "South", "XY0201", "SÃ©gou", "سيغو"],
  ["XY02", "South", "XY0202", "Việt", "فيت"],
  ["XY02", "South", "XY0203", "Del​ta", "دلتا"],
  ["XY02", "South", "XY0204", "KING FAHAD CAUSWAY", "جسر"],
  ["XY02", "South", "XY0205", "Kаbul", "كابل"],
  ["XY02", "South", "XY0206", "Unknown", "مجهول"],
  ["XY02", "South", "XY0207", null, "فارغ"],
  ["XY02", "South", "XY0208", "Zeta XY0208", "زيتا"],
  ["XY02", "South2", "XY0209", "Eta", "إيتا"],
  ...FILLER.map((n, k): Row => ["XY02", "South", `XY02${k + 10}`, n, AR(k + 10)]),
];

const EXPECTED: Record<string, [string, string]> = {
  "duplicate-name": ["XY0101", "warn"],
  "normalized-duplicate-name": ["XY0103", "warn"],
  whitespace: ["XY0105", "warn"],
  "encoding-artifact": ["XY0201", "error"],
  "unnormalized-unicode": ["XY0202", "warn"],
  "invisible-character": ["XY0203", "warn"],
  "case-outlier": ["XY0204", "warn"],
  "mixed-script": ["XY0205", "warn"],
  "placeholder-name": ["XY0206", "error"],
  "blank-name": ["XY0207", "error"],
  "code-in-name": ["XY0208", "warn"],
};

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

async function detect(rs: Row[], schema: typeof SCHEMA | null = SCHEMA) {
  const values = rs.map((r, i) => `(${i + 1}, ${r.map(lit).join(", ")}, ${i})`).join(", ");
  await run(`CREATE OR REPLACE TABLE _names AS SELECT * FROM (VALUES ${values})
    AS v(fid, adm1_code, adm1_name, adm2_code, adm2_name, adm2_name1, x)`);
  await run("CREATE OR REPLACE TABLE layer_01 AS SELECT fid, ST_Point(x, 0) AS geom FROM _names");
  await run("CREATE OR REPLACE TABLE layer_attr AS SELECT * EXCLUDE (x) FROM _names");
  return (await runNameDetect(conn, schema)).issues;
}

const fillerRows = (names: string[]): Row[] =>
  [...FILLER, ...names].map((n, i) => [
    "XY01",
    "North",
    `XY01${String(i).padStart(2, "0")}`,
    n,
    AR(i),
  ]);

async function reportFor(names: string[]) {
  return (await detect(fillerRows(names))).map((r) => [r.kind, r.nameA] as const);
}

test("every kind", async () => {
  const report = await detect(ROWS);
  const found = new Set(report.map((r) => `${r.kind}|${r.codeA}|${r.severity}`));
  for (const [kind, [code, severity]] of Object.entries(EXPECTED)) {
    expect(found, kind).toContain(`${kind}|${code}|${severity}`);
  }
  expect(new Set(report.map((r) => r.kind))).toEqual(new Set(Object.keys(EXPECTED)));
});

test("a duplicate is reported once across language columns", async () => {
  const report = await detect(ROWS);
  expect(report.filter((r) => r.kind === "duplicate-name")).toHaveLength(1);
});

test("suggested fixes", async () => {
  const suggested = Object.fromEntries((await detect(ROWS)).map((r) => [r.codeA, r.suggested]));
  expect(suggested["XY0105"]).toBe("Gamma");
  expect(suggested["XY0201"]).toBe("Ségou");
  expect(suggested["XY0202"]).toBe("Việt");
  expect(suggested["XY0203"]).toBe("Delta");
});

test("an unsafe repair is flagged without a suggestion", async () => {
  const rs: Row[] = [
    ...FILLER.map((n, i): Row => ["XY01", "North", `XY01${String(i).padStart(2, "0")}`, n, AR(i)]),
    ["XY01", "North", "XY0199", "RÍ\u008dO", "نهر"],
  ];
  const found = Object.fromEntries((await detect(rs)).map((r) => [r.kind, r.suggested]));
  expect(found).toEqual({ "encoding-artifact": null });
});

test("clean names give an empty report", async () => {
  expect(await detect(fillerRows([]))).toEqual([]);
});

test("a column-wide kind rolls up", async () => {
  const rs = FILLER.map((n, i): Row => [
    "XY01",
    "North",
    `XY01${String(i).padStart(2, "0")}`,
    `${n} `,
    AR(i),
  ]);
  const report = await detect(rs);
  expect(report).toHaveLength(1);
  expect(report[0].kind).toBe("whitespace");
  expect(report[0].codeA).toBeNull();
  expect(report[0].reason.startsWith("8 of 8 names")).toBe(true);
});

test("structural detection without a schema", async () => {
  const report = await detect(
    ROWS.filter((r) => r[1] !== "South2"),
    null,
  );
  expect(report.map((r) => r.kind)).toContain("case-outlier");
});

test.todo("CSV report starts with a BOM; Parquet report leads with geometry (export shape)");
test.todo(
  "a failing check is reported as check-failed while the others run (needs a check override hook)",
);

test("accents fold only against unaccented Latin", async () => {
  const found = await reportFor(["Segou", "Ségou", "Mỹ Tho", "Mỹ Thọ", "ကူကြီး", "ကံကြီး"]);
  const norm = found.filter(([k]) => k === "normalized-duplicate-name");
  expect(norm).toHaveLength(1);
  expect(norm[0][1]).toBe("Segou");
});

test("case ignores caseless scripts and acronyms", async () => {
  const mixed = ["Rho", "Chi", "Psi", "Tau", "Beta", "Delta", "Zeta", "Eta", "Mu", "Nu"];
  const acronyms = ["S.P.S.M.", "KCCA", "UEP II", "BARMM"];
  const found = await reportFor([...mixed, "ქარელის", ...acronyms, "CHARI BAGUIRMI"]);
  expect(new Set(found.filter(([k]) => k === "case-outlier").map(([, n]) => n))).toEqual(
    new Set(["CHARI BAGUIRMI"]),
  );
});

test("a mojibake lookalike is not flagged", async () => {
  const found = await reportFor(["LOMÉ COMMUNE", "FANØ–ESBJERG"]);
  expect(found.map(([k]) => k)).not.toContain("encoding-artifact");
});

test("code-in-name needs a whole P-code token", async () => {
  const rs: Row[] = [
    ...FILLER.map((n, i): Row => ["XY01", "North", `LAG${i}`, n, AR(i)]),
    ["XY01", "North", "LAG", "LAGOS", "لاغوس"],
    ["XY01", "North", "XY0199", "Zeta XY0199", "زيتا"],
  ];
  const found = (await detect(rs)).filter((r) => r.kind === "code-in-name").map((r) => r.codeA);
  expect(found).toEqual(["XY0199"]);
});

test("uncoded units are not reported", async () => {
  const rs: Row[] = [
    ...fillerRows([]),
    ["XY01", "North", null, null, null],
    ["XY01", "North", null, "Rho", null],
  ];
  expect(await detect(rs)).toEqual([]);
});

test("numbered names are not normalized duplicates", async () => {
  const found = await reportFor(["Ward 1-2", "Ward 12", "Zone I-II", "Zone III"]);
  expect(found.filter(([k]) => k === "normalized-duplicate-name")).toEqual([]);
});

test("quoted column names", async () => {
  await run(`CREATE OR REPLACE TABLE layer_attr AS
    SELECT 1 AS fid, 'XY01' AS "a'd""m1_code", 'North' AS "a'd""m1_name", ' x' AS other`);
  await run("CREATE OR REPLACE TABLE layer_01 AS SELECT 1 AS fid, ST_Point(0, 0) AS geom");
  const issues = (
    await runNameDetect(conn, { nameField: "a'd\"m{n}_name", codeField: "a'd\"m{n}_code" })
  ).issues;
  expect(issues).toEqual([]);
});

test("placeholder variants", async () => {
  const found = await reportFor(["N_A", "undefined"]);
  expect(new Set(found.filter(([k]) => k === "placeholder-name").map(([, n]) => n))).toEqual(
    new Set(["N_A", "undefined"]),
  );
});
