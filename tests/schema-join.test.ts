import { beforeAll, expect, test } from "vitest";
import { loadAndAssign, runSchemaJoin } from "$lib/tools/schema-join/pipeline";
import { db, exportColumns, ready, rows, write } from "./helpers";

type Row = Record<string, string | number | null>;
const PARENTS: [string, string, string, string, number, number][] = [
  ["A", "Alpha", "A01", "Alpha One", 0, 0],
  ["A", "Alpha", "A02", "Alpha Two", 2, 0],
  ["B", "Beta", "B01", "Beta One", 0, 2],
  ["B", "Beta", "B02", "Beta Two", 2, 2],
];
const PARENT_NAME = Object.fromEntries(PARENTS.map(([, , c, n]) => [c, n]));

const square = (x: number, y: number, s: number) =>
  `POLYGON((${x} ${y}, ${x + s} ${y}, ${x + s} ${y + s}, ${x} ${y + s}, ${x} ${y}))`;
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  `POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`;

const joinRows = (): Row[] =>
  PARENTS.map(([adm1_code, adm1_name, adm2_code, adm2_name, x, y]) => ({
    adm1_code,
    adm1_name,
    adm2_code,
    adm2_name,
    wkt: square(x, y, 2),
  }));

const inputRows = (): Row[] =>
  PARENTS.flatMap(([, , c, n, x, y]) =>
    [0, 1].flatMap((dx, k) => [
      { adm3_code: `${c}0${k + 1}`, adm3_name: `${n} ${k + 1}`, wkt: square(x + dx, y, 1) },
      { adm3_code: `${c}0${k + 3}`, adm3_name: `${n} ${k + 3}`, wkt: square(x + dx, y + 1, 1) },
    ]),
  );

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const lit = (v: Row[string]) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

function file(rs: Row[], name: string) {
  const cols = Object.keys(rs[0]).filter((k) => k !== "wkt");
  const values = rs.map((r) => `(${cols.map((c) => lit(r[c])).join(", ")}, '${r.wkt}')`);
  return write(
    `SELECT * EXCLUDE (wkt), ST_GeomFromText(wkt) AS geom FROM (VALUES ${values.join(", ")}) AS t(${[...cols, "wkt"].join(", ")})`,
    name,
  );
}

type Schema = { nameField: string; codeField: string } | null;
async function join(
  input: Row[],
  joinLayer: Row[] = joinRows(),
  schema: Schema = null,
  minOverlap = 0.5,
) {
  const { db: instance } = db();
  await loadAndAssign(
    instance,
    conn,
    [await file(input, "input.parquet")],
    [await file(joinLayer, "join.parquet")],
  );
  const result = await runSchemaJoin(conn, schema, minOverlap);
  const columns = await exportColumns("schema_join");
  const out = await rows<Row>("SELECT * EXCLUDE (geometry) FROM '_export.parquet'");
  return { ...result, columns, out };
}

const issues = (r: Awaited<ReturnType<typeof join>>) =>
  [...r.issues].sort((a, b) => a.unitA - b.unitA || a.kind.localeCompare(b.kind));
const byCode = (out: Row[], code: string) => out.find((r) => r.adm3_code === code)!;

const SCHEMAS = [
  ["auto", null],
  ["explicit", { nameField: "adm{n}_name", codeField: "adm{n}_code" }],
] as const;

test.each(SCHEMAS)("fills every coarser level (%s)", async (_, schema) => {
  const r = await join(inputRows(), joinRows(), schema);
  const codes = r.out.map((x) => x.adm3_code as string);
  expect(codes).toEqual([...codes].sort());
  expect(r.out).toHaveLength(inputRows().length);
  for (const row of r.out) {
    const code = row.adm3_code as string;
    expect(row.adm2_code).toBe(code.slice(0, 3));
    expect(row.adm1_code).toBe(code[0]);
  }
  expect(r.issues).toEqual([]);
});

test.each(SCHEMAS)("fills every coarser level: column order (%s)", async (_, schema) => {
  expect((await join(inputRows(), joinRows(), schema)).columns).toEqual([
    "geometry",
    "adm3_code",
    "adm3_name",
    "adm2_name",
    "adm2_code",
    "adm1_name",
    "adm1_code",
  ]);
});

test("geometry is unchanged", async () => {
  await join(inputRows());
  const before = inputRows().map((r) => `('${r.adm3_code}', '${r.wkt}')`);
  expect(
    await rows(`SELECT count(*)::INT AS n FROM '_export.parquet' e
      JOIN (VALUES ${before.join(", ")}) t(code, w) ON e.adm3_code = t.code
      WHERE ST_AsWKB(e.geometry) = ST_AsWKB(ST_GeomFromText(t.w))`),
  ).toEqual([{ n: inputRows().length }]);
});

test("chains coarsest first", async () => {
  const admin1: Row[] = [
    { adm1_code: "A", adm1_name: "Alpha", wkt: rect(0, 0, 4, 2) },
    { adm1_code: "B", adm1_name: "Beta", wkt: rect(0, 2, 4, 4) },
  ];
  const admin2: Row[] = PARENTS.map(([, , adm2_code, adm2_name, x, y]) => ({
    adm2_code,
    adm2_name,
    wkt: square(x, y, 2),
  }));
  const first = await join(admin2, admin1);
  const joined = await rows<Row>(
    "SELECT * EXCLUDE (geometry), ST_AsText(geometry) AS wkt FROM '_export.parquet'",
  );
  expect(first.out).toHaveLength(4);
  const r = await join(inputRows(), joined);
  for (const row of r.out) {
    const code = row.adm3_code as string;
    expect(row.adm2_code).toBe(code.slice(0, 3));
    expect(row.adm1_code).toBe(code[0]);
  }
});

test("an input with no overlap is kept with null columns", async () => {
  const r = await join([
    ...inputRows(),
    { adm3_code: "Z0101", adm3_name: "Nowhere", wkt: square(10, 10, 1) },
  ]);
  expect(r.out).toHaveLength(inputRows().length + 1);
  expect(byCode(r.out, "Z0101").adm2_code).toBeNull();
  expect(issues(r).map((i) => [i.kind, i.unitA])).toEqual([["no-overlap", inputRows().length + 1]]);
});

test("low-overlap threshold", async () => {
  const straddle = [{ adm3_code: "A0101", adm3_name: "Straddle", wkt: square(1.5, 1.5, 1) }];
  const r = await join(straddle);
  expect(issues(r).map((i) => [i.kind, i.unitA, i.reason])).toEqual([
    ["low-overlap", 1, "best join polygon covers 0.25 of input polygon"],
  ]);
  expect((await join(straddle, joinRows(), null, 0.2)).issues).toEqual([]);
});

const withAdm2Name = (rs: Row[], override: Record<string, string>) =>
  rs.map((r) => {
    const code = r.adm3_code as string;
    return { ...r, adm2_name: override[code] ?? PARENT_NAME[code.slice(0, 3)] };
  });

test("a differing shared column is kept side by side", async () => {
  const input = withAdm2Name(inputRows(), { A0101: "Alpha Uno" }).map((r) => ({
    ...r,
    adm2_name1: "taken",
  }));
  const r = await join(input);
  expect(r.columns).toContain("adm2_name2");
  expect(byCode(r.out, "A0101")).toMatchObject({
    adm2_name: "Alpha Uno",
    adm2_name1: "taken",
    adm2_name2: "Alpha One",
  });
  expect(issues(r).map((i) => [i.kind, i.reason])).toEqual([
    ["value-mismatch", "adm2_name: input 'Alpha Uno' vs join 'Alpha One'"],
  ]);
});

test("an issue's unit_a is its output row", async () => {
  const input = withAdm2Name(
    inputRows().sort((a, b) => String(b.adm3_code).localeCompare(String(a.adm3_code))),
    { A0203: "Alpha Dos" },
  );
  const r = await join(input);
  const [only] = r.issues;
  expect(r.issues).toHaveLength(1);
  expect(r.out[only.unitA - 1].adm3_code).toBe("A0203");
});

test("an identical shared column is skipped", async () => {
  const r = await join(
    inputRows().map((x) => ({ ...x, adm2_code: (x.adm3_code as string).slice(0, 3) })),
  );
  expect(r.columns).not.toContain("adm2_code1");
  expect(r.columns.filter((c) => c === "adm2_code")).toHaveLength(1);
});

test("an invalid min overlap raises", async () => {
  await expect(join(inputRows(), joinRows(), null, 0)).rejects.toThrow(/overlap/i);
});

test("a join layer without a coarser code compares names", async () => {
  const r = await join(
    withAdm2Name(inputRows(), { A0101: "Alpha Uno" }),
    joinRows().map(({ adm1_code: _, ...rest }) => rest),
  );
  expect(r.columns).toContain("adm2_name1");
  expect(issues(r).map((i) => i.kind)).toEqual(["value-mismatch"]);
});

test("a sibling of a digit-ending column is separated", async () => {
  const joinLayer = PARENTS.map(([GID_1, NAME_1, GID_2, NAME_2, x, y]) => ({
    GID_1,
    NAME_1,
    GID_2,
    NAME_2,
    wkt: square(x, y, 2),
  }));
  const input = inputRows().map((r) => {
    const code = r.adm3_code as string;
    return {
      GID_3: code,
      NAME_3: r.adm3_name,
      NAME_2: code === "A0101" ? "Alpha Uno" : PARENT_NAME[code.slice(0, 3)],
      wkt: r.wkt,
    };
  });
  const r = await join(input, joinLayer, { nameField: "NAME_{n}", codeField: "GID_{n}" });
  expect(r.columns).toEqual([
    "geometry",
    "GID_3",
    "NAME_3",
    "NAME_2",
    "NAME_2_1",
    "GID_2",
    "NAME_1",
    "GID_1",
  ]);
});

test("added columns go within their level", async () => {
  const input = inputRows().map((r) => ({
    adm3_name: r.adm3_name,
    adm3_code: r.adm3_code,
    adm1_code: (r.adm3_code as string).slice(0, 1),
    wkt: r.wkt,
  }));
  expect((await join(input)).columns).toEqual([
    "geometry",
    "adm3_name",
    "adm3_code",
    "adm2_name",
    "adm2_code",
    "adm1_name",
    "adm1_code",
  ]);
});

test("a shared column of another type is kept side by side", async () => {
  const r = await join(inputRows().map((x) => ({ ...x, adm2_code: 7 })));
  expect(byCode(r.out, "A0101")).toMatchObject({ adm2_code: 7, adm2_code1: "A01" });
});

test("keeps the input column order and places added columns", async () => {
  const input = inputRows().map((r) => {
    const code = r.adm3_code as string;
    return {
      adm3_name: r.adm3_name,
      adm3_code: code,
      adm3_type: "District",
      adm2_name: code === "A0101" ? "Alpha Uno" : PARENT_NAME[code.slice(0, 3)],
      adm2_code: code.slice(0, 3),
      wkt: r.wkt,
    };
  });
  expect((await join(input)).columns).toEqual([
    "geometry",
    "adm3_name",
    "adm3_code",
    "adm3_type",
    "adm2_name",
    "adm2_name1",
    "adm2_code",
    "adm1_name",
    "adm1_code",
  ]);
});

test("added columns go within their level", async () => {
  const input = inputRows().map((r) => ({
    adm3_name: r.adm3_name,
    adm3_code: r.adm3_code,
    adm1_code: (r.adm3_code as string)[0],
    wkt: r.wkt,
  }));
  expect((await join(input)).columns).toEqual([
    "geometry",
    "adm3_name",
    "adm3_code",
    "adm2_name",
    "adm2_code",
    "adm1_name",
    "adm1_code",
  ]);
});

test.each(["input", "join"] as const)("raises on an overlapping %s layer", async (side) => {
  const layers = { input: inputRows(), join: joinRows() };
  layers[side] = [...layers[side], { ...layers[side][0] }];
  await expect(join(layers.input, layers.join)).rejects.toThrow(/pair\(s\) overlap/);
});

test.todo("each step runs standalone (no TS counterpart)");
