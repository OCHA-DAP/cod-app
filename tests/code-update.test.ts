import { beforeAll, expect, test } from "vitest";
import { runCodeCreate, type SourceCodes } from "$lib/tools/code-create/pipeline";
import {
  runCodeUpdate,
  type ChangeRow,
  type CodeUpdateOptions,
  type TargetSchema,
} from "$lib/tools/code-update/pipeline";
import { dropPriorRun, loadSide } from "$lib/tools/code-update/pipeline/load";
import { db, exportColumns, layer, ready, rows, write } from "./helpers";

type Row = Record<string, string | number | null>;
const PCODE: TargetSchema = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const CODE: TargetSchema = { nameField: "adm{n}_name", codeField: "adm{n}_code" };

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const lit = (v: Row[string]) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

function synthetic(rs: Row[]) {
  const cols = Object.keys(rs[0]).filter((k) => k !== "wkt");
  const values = rs.map((r) => `(${[...cols, "wkt"].map((c) => lit(r[c])).join(", ")})`);
  return `SELECT * EXCLUDE (wkt), ST_GeomFromText(wkt) AS geom
    FROM (VALUES ${values.join(", ")}) AS t(${[...cols, "wkt"].join(", ")})`;
}
const file = (rs: Row[], name: string) => write(synthetic(rs), name);
const square = (x: number, y: number) =>
  `POLYGON((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`;

// code-create's output, round-tripped through its Parquet export as code-update's OLD file.
async function codeCreate(
  rs: Row[],
  rootCode: string,
  delimiter: string,
  minWidth: string,
  sourceCodes: SourceCodes = "replace",
  schema: TargetSchema | null = null,
): Promise<{ file: File; out: Row[] }> {
  await layer(synthetic(rs));
  await runCodeCreate(conn, rootCode, delimiter, minWidth, sourceCodes, schema);
  await exportColumns("code_create");
  const out = await rows<Row>("SELECT * EXCLUDE (geometry) FROM '_export.parquet'");
  return { file: await write("SELECT * FROM '_export.parquet'", "old_coded.parquet"), out };
}

type Log = {
  level: number;
  old_code: string | null;
  old_name: string | null;
  new_code: string | null;
  new_name: string | null;
  relationship_class: string;
  cluster_id: number;
  match_method: string | null;
  code_outcome: string;
};
const snake = (r: ChangeRow): Log => ({
  level: r.level,
  old_code: r.oldCode,
  old_name: r.oldName,
  new_code: r.newCode,
  new_name: r.newName,
  relationship_class: r.relationshipClass,
  cluster_id: r.clusterId,
  match_method: r.matchMethod,
  code_outcome: r.codeOutcome,
});

async function codeUpdate(old: File | Row[], neu: File | Row[], opts: Partial<CodeUpdateOptions> = {}) {
  const { db: instance } = db();
  const oldFile = old instanceof File ? old : await file(old, "old.parquet");
  const newFile = neu instanceof File ? neu : await file(neu, "new.parquet");
  await dropPriorRun(conn);
  await loadSide(instance, conn, "a", [oldFile]);
  await loadSide(instance, conn, "b", [newFile]);
  const result = await runCodeUpdate(conn, {
    schemaA: null,
    schemaB: null,
    rootCode: null,
    delimiter: null,
    minWidth: null,
    codeColumnA: null,
    codeColumnB: null,
    nameColumnA: null,
    nameColumnB: null,
    tauMatch: 0.8,
    tauSame: 0.98,
    linkByCode: false,
    linkByName: false,
    linkMode: "either",
    ...opts,
  });
  const columns = (await exportColumns("code_update")).filter((c) => c !== "geometry");
  const out = await rows<Row>("SELECT * EXCLUDE (geometry) FROM '_export.parquet'");
  return { log: result.changelog.map(snake), columns, out };
}

const where = (log: Log[], match: Partial<Log>) =>
  log.filter((r) => Object.entries(match).every(([k, v]) => r[k as keyof Log] === v));
const sorted = (out: Row[], ...cols: string[]) =>
  [...out]
    .sort((a, b) => String(a[cols[0]]).localeCompare(String(b[cols[0]])))
    .map((r) => cols.map((c) => r[c]));

const ALL_CLASSES_OLD: Row[] = [
  ["AA.001", "N1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  ["AA.002", "N2", "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  ["AA.003", "N3", "POLYGON((20 0, 21 0, 21 1, 20 1, 20 0))"],
  ["AA.004", "N4", "POLYGON((30 0, 33 0, 33 1, 30 1, 30 0))"],
  ["AA.005", "N5a", "POLYGON((40 0, 41 0, 41 1, 40 1, 40 0))"],
  ["AA.006", "N5b", "POLYGON((41 0, 43 0, 43 1, 41 1, 41 0))"],
  ["AA.007", "N7", "POLYGON((60 0, 61 0, 61 1, 60 1, 60 0))"],
  ["AA.008", "RL8", "POLYGON((70 0, 71 0, 71 1, 70 1, 70 0))"],
  ["AA.009", "CX1", "POLYGON((80 0, 82 0, 82 2, 80 2, 80 0))"],
  ["AA.010", "CX2", "POLYGON((82 0, 84 0, 84 2, 82 2, 82 0))"],
].map(([adm1_pcode, adm1_name, wkt]) => ({ adm1_pcode, adm1_name, wkt }));
const ALL_CLASSES_NEW: Row[] = [
  ["x1", "N1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
  ["x2", "N2 Renamed", "POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))"],
  ["x3", "N3", "POLYGON((20 0, 21 0, 21 0.9, 20 0.9, 20 0))"],
  ["x4a", "N4a", "POLYGON((30 0, 31 0, 31 1, 30 1, 30 0))"],
  ["x4b", "N4b", "POLYGON((31 0, 33 0, 33 1, 31 1, 31 0))"],
  ["x5", "N5", "POLYGON((40 0, 43 0, 43 1, 40 1, 40 0))"],
  ["x9", "C1", "POLYGON((50 0, 51 0, 51 1, 50 1, 50 0))"],
  ["x8", "RL8", "POLYGON((70.9 0, 71.9 0, 71.9 1, 70.9 1, 70.9 0))"],
  ["x10", "CXA", "POLYGON((80 0, 84 0, 84 1, 80 1, 80 0))"],
  ["x11", "CXB", "POLYGON((80 1, 84 1, 84 2, 80 2, 80 1))"],
].map(([adm1_pcode, adm1_name, wkt]) => ({ adm1_pcode, adm1_name, wkt }));

let allClasses: { log: Log[]; predecessor: Map<string, string | null> } | null = null;
async function allClassesResult() {
  if (allClasses) return allClasses;
  const { log, out } = await codeUpdate(ALL_CLASSES_OLD, ALL_CLASSES_NEW, {
    rootCode: "AA",
    delimiter: ".",
    minWidth: "3",
    schemaA: PCODE,
    schemaB: PCODE,
    linkByName: true,
    tauMatch: 0.4,
  });
  const predecessor = new Map(
    out.map((r) => [r.adm1_pcode as string, r.predecessor_code as string | null]),
  );
  allClasses = { log, predecessor };
  return allClasses;
}

test("unchanged retains its code", async () => {
  const { log } = await allClassesResult();
  const unchanged = where(log, { relationship_class: "unchanged" });
  expect(unchanged.map((r) => [r.old_code, r.new_code, r.code_outcome])).toEqual([
    ["AA.001", "AA.001", "retained"],
  ]);
});

test("renamed retains its code and updates its name", async () => {
  const { log } = await allClassesResult();
  expect(where(log, { relationship_class: "renamed" })).toMatchObject([
    { old_code: "AA.002", new_code: "AA.002", new_name: "N2 Renamed", code_outcome: "retained" },
  ]);
});

test("modified gets a new code with a predecessor", async () => {
  const { log, predecessor } = await allClassesResult();
  const modified = where(log, { relationship_class: "modified" });
  expect(modified).toMatchObject([{ old_code: "AA.003", code_outcome: "new" }]);
  expect(predecessor.get(modified[0].new_code!)).toBe("AA.003");
});

test("split shares a cluster and predecessor", async () => {
  const { log, predecessor } = await allClassesResult();
  const split = where(log, { relationship_class: "split" });
  expect(split).toHaveLength(2);
  expect(new Set(split.map((r) => r.cluster_id)).size).toBe(1);
  expect(split.every((r) => r.old_code === null && r.code_outcome === "new")).toBe(true);
  for (const r of split) expect(predecessor.get(r.new_code!)).toBe("AA.004");
});

test("merge retires both olds, no predecessor on the survivor", async () => {
  const { log, predecessor } = await allClassesResult();
  const retired = where(log, { relationship_class: "merge", code_outcome: "retired" });
  const created = where(log, { relationship_class: "merge", code_outcome: "new" });
  expect(new Set(retired.map((r) => r.old_code))).toEqual(new Set(["AA.005", "AA.006"]));
  expect(created).toHaveLength(1);
  expect(new Set([...retired, ...created].map((r) => r.cluster_id)).size).toBe(1);
  expect(predecessor.get(created[0].new_code!)).toBeNull();
});

test("removed has no new code", async () => {
  const { log } = await allClassesResult();
  expect(where(log, { relationship_class: "removed" })).toMatchObject([
    { old_code: "AA.007", new_code: null, code_outcome: "retired" },
  ]);
});

test("created has no predecessor", async () => {
  const { log, predecessor } = await allClassesResult();
  const created = where(log, { relationship_class: "created" });
  expect(created).toMatchObject([{ old_code: null, code_outcome: "new" }]);
  expect(predecessor.get(created[0].new_code!)).toBeNull();
});

test("relocated is identity-linked with a predecessor", async () => {
  const { log, predecessor } = await allClassesResult();
  const relocated = where(log, { relationship_class: "relocated" });
  expect(relocated).toMatchObject([
    { old_code: "AA.008", code_outcome: "new", match_method: "identity" },
  ]);
  expect(predecessor.get(relocated[0].new_code!)).toBe("AA.008");
});

test("a complex cluster retires the olds, no predecessor on the survivors", async () => {
  const { log, predecessor } = await allClassesResult();
  const retired = where(log, { relationship_class: "complex", code_outcome: "retired" });
  const created = where(log, { relationship_class: "complex", code_outcome: "new" });
  expect(new Set(retired.map((r) => r.old_code))).toEqual(new Set(["AA.009", "AA.010"]));
  expect(created).toHaveLength(2);
  expect(new Set([...retired, ...created].map((r) => r.cluster_id)).size).toBe(1);
  expect(created.every((r) => predecessor.get(r.new_code!) === null)).toBe(true);
});

test("a multilevel cascade rewrites unchanged children under a new parent", async () => {
  const unit = (c1: string, n1: string, c2: string, n2: string, wkt: string): Row => ({
    adm1_pcode: c1,
    adm1_name: n1,
    adm2_pcode: c2,
    adm2_name: n2,
    wkt,
  });
  const old = [
    unit("AA.001", "Province1", "AA.001.001", "District1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"),
    unit("AA.001", "Province1", "AA.001.002", "District2", "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"),
    unit("AA.001", "Province1", "AA.001.003", "District3", "POLYGON((2 0, 3 0, 3 1, 2 1, 2 0))"),
    unit("AA.002", "Province2", "AA.002.001", "OnlyDistrict", "POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))"),
  ];
  const neu = [
    unit("x", "Province1", "y1", "District1", "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"),
    unit("x", "Province1", "y2", "District2", "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"),
    unit("x", "Province1", "y3", "District3 Expanded", "POLYGON((2 0, 3 0, 3 3, 2 3, 2 0))"),
    unit("z", "Province2", "y4", "OnlyDistrict", "POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))"),
  ];
  const { log, out } = await codeUpdate(old, neu, {
    rootCode: "AA",
    delimiter: ".",
    minWidth: "3",
    schemaA: PCODE,
    schemaB: PCODE,
  });
  const one = (level: number, old_code: string) => where(log, { level, old_code })[0];
  const p1 = one(1, "AA.001");
  expect(p1).toMatchObject({ relationship_class: "modified", code_outcome: "new" });
  expect(one(1, "AA.002")).toMatchObject({ relationship_class: "unchanged", new_code: "AA.002" });
  const p1Code = p1.new_code!;
  expect(p1Code).not.toBe("AA.001");
  expect(one(2, "AA.001.001")).toMatchObject({
    relationship_class: "unchanged",
    new_code: `${p1Code}.001`,
  });
  expect(one(2, "AA.001.002")).toMatchObject({
    relationship_class: "unchanged",
    new_code: `${p1Code}.002`,
  });
  const d3 = one(2, "AA.001.003");
  expect(d3.relationship_class).toBe("modified");
  expect(d3.new_code!.startsWith(`${p1Code}.`)).toBe(true);
  expect(one(2, "AA.002.001")).toMatchObject({
    relationship_class: "unchanged",
    new_code: "AA.002.001",
  });
  expect(new Set(out.map((r) => r.adm1_pcode))).toEqual(new Set([p1Code, "AA.002"]));
});

test("a level count mismatch raises", async () => {
  await expect(
    codeUpdate(
      [
        {
          adm1_pcode: "AA.001",
          adm1_name: "P1",
          adm2_pcode: "AA.001.001",
          adm2_name: "D1",
          wkt: square(0, 0),
        },
      ],
      [{ adm1_pcode: "x", adm1_name: "P1", wkt: square(0, 0) }],
      { rootCode: "AA", delimiter: ".", minWidth: "3", schemaA: PCODE, schemaB: PCODE },
    ),
  ).rejects.toThrow(/level mismatch/);
});

test.each([
  ["2", ["AA-01", "AA-02"], ["AA-01-01", "AA-01-02", "AA-02-01"]],
  ["1,3", ["AA-1", "AA-2"], ["AA-1-001", "AA-1-002", "AA-2-001"]],
])(
  "a custom format round-trips, detected from the old codes (min width %s)",
  async (minWidth, level1, level2) => {
    const raw: Row[] = [
      { adm1_code: "P1", adm2_code: "P1-01", wkt: square(0, 0) },
      { adm1_code: "P1", adm2_code: "P1-02", wkt: square(1, 0) },
      { adm1_code: "P2", adm2_code: "P2-01", wkt: square(0, 1) },
    ];
    const old = await codeCreate(raw, "AA", "-", minWidth);
    const { log, out } = await codeUpdate(old.file, raw);
    expect(new Set(out.map((r) => r.adm1_code))).toEqual(new Set(level1));
    expect(new Set(out.map((r) => r.adm2_code))).toEqual(new Set(level2));
    expect(log.every((r) => r.relationship_class === "unchanged")).toBe(true);
    expect(log.every((r) => r.code_outcome === "retained")).toBe(true);
  },
);

test("undelimited codes are retained with a names-only level", async () => {
  const raw: Row[] = [
    ["51", "Hidd", "0101"],
    ["51", "Adhari", "0102"],
    ["52", "Zallaq", "0201"],
  ].map(([c1, n2, c3], i) => ({
    adm1_code: c1,
    adm1_name: `A${c1}`,
    adm2_name: n2,
    adm3_code: c3,
    adm3_name: `C${c3}`,
    wkt: square(i, 0),
  }));
  const old = await codeCreate(raw, "BH", "", "auto", "embed", CODE);
  const { log, out } = await codeUpdate(old.file, raw, { schemaA: CODE, schemaB: CODE });
  const cols = ["adm3_code", "adm1_code", "adm2_code"];
  expect(sorted(out, ...cols)).toEqual(sorted(old.out, ...cols));
  expect(log.every((r) => r.code_outcome === "retained")).toBe(true);
});

test("a split never reuses a retired number", async () => {
  const oldRows: Row[] = [
    ...[0, 1, 2].map((i) => ({ adm1_code: "P1", adm2_code: `P1-0${i}`, wkt: square(i, 0) })),
    { adm1_code: "P2", adm2_code: "P2-01", wkt: square(0, 1) },
  ];
  const old = await codeCreate(oldRows, "AA", "-", "2");
  const neu: Row[] = [
    ...oldRows.slice(0, 2),
    oldRows[3],
    ...(
      [
        ["a", 0],
        ["b", 0.5],
      ] as const
    ).map(([half, y0]) => ({
      adm1_code: "P1",
      adm2_code: `P1-x${half}`,
      wkt: `POLYGON((2 ${y0}, 3 ${y0}, 3 ${y0 + 0.5}, 2 ${y0 + 0.5}, 2 ${y0}))`,
    })),
  ];
  const { log, out } = await codeUpdate(old.file, neu);
  const split = where(log, { relationship_class: "split" });
  expect(split.map((r) => r.new_code).sort()).toEqual(["AA-01-04", "AA-01-05"]);
  expect(sorted(out, "adm2_code", "predecessor_code").slice(2, 4)).toEqual([
    ["AA-01-04", "AA-01-03"],
    ["AA-01-05", "AA-01-03"],
  ]);
});

test("modified keeps its code without a delimiter", async () => {
  const oldRows: Row[] = [
    ...[1, 2].map((i) => ({ adm1_code: "51", adm1_name: "A", adm2_code: `0${i}`, wkt: square(i, 0) })),
    { adm1_code: "52", adm1_name: "B", adm2_code: "01", wkt: square(1, 1) },
  ];
  const old = await codeCreate(
    oldRows.map((r) => ({ ...r, adm2_name: r.adm2_code })),
    "XY",
    "",
    "auto",
    "embed",
    CODE,
  );
  const neu: Row[] = oldRows.map((r) => ({
    ...r,
    adm2_code: `${r.adm1_name}${r.adm2_code}`,
    adm2_name: r.adm2_code,
  }));
  neu[0].wkt = "POLYGON((1 0, 1.9 0, 1.9 1, 1 1, 1 0))";
  neu[1].wkt = "POLYGON((1.9 0, 3 0, 3 1, 1.9 1, 1.9 0))";
  const { log, out } = await codeUpdate(old.file, neu, { schemaA: CODE, schemaB: CODE });
  expect(log.some((r) => r.relationship_class === "modified")).toBe(true);
  expect(log.every((r) => r.code_outcome === "retained")).toBe(true);
  expect(sorted(out, "adm2_code")).toEqual([["XY5101"], ["XY5102"], ["XY5201"]]);
});

const twoParentRows = (): Row[] =>
  (
    [
      ["51", "A", 0],
      ["52", "B", 1],
    ] as const
  ).flatMap(([c1, n1, y]) =>
    Array.from({ length: 10 }, (_, k) => ({
      adm1_code: c1,
      adm1_name: n1,
      adm2_code: String(k + 1).padStart(2, "0"),
      adm2_name: `${n1}${k + 1}`,
      wkt: square(k + 1, y),
    })),
  );
const codeOld = (rs: Row[]) => codeCreate(rs, "XY", "", "auto", "embed", CODE);

test("a moved unit never takes a code already used", async () => {
  const oldRows = twoParentRows();
  const old = await codeOld(oldRows);
  const neu: Row[] = oldRows.map((r) => ({ ...r, adm2_code: `${r.adm1_code}${r.adm2_code}` }));
  neu[9] = { ...neu[9], adm1_code: "52", adm1_name: "B" };
  const { log, out } = await codeUpdate(old.file, neu, { schemaA: CODE, schemaB: CODE });
  const codes = out.map((r) => r.adm2_code);
  expect(new Set(codes).size).toBe(codes.length);
  expect(sorted(out, "adm2_code", "predecessor_code")).toContainEqual(["XY5211", "XY5110"]);
  expect(where(log, { old_code: "XY5110" }).map((r) => [r.new_code, r.code_outcome])).toEqual([
    ["XY5211", "new"],
  ]);
});

const namedTwoParentRows = (): Row[] =>
  twoParentRows().map((r) => ({ ...r, adm2_name: `N${r.adm2_code}` }));
const withoutCode2 = (rs: Row[]): Row[] => rs.map(({ adm2_code: _, ...r }) => r);

test("same names under different parents stay apart", async () => {
  const oldRows = namedTwoParentRows();
  const old = await codeOld(oldRows);
  const { out } = await codeUpdate(old.file, withoutCode2(oldRows), {
    schemaA: CODE,
    schemaB: CODE,
  });
  expect(sorted(out, "adm2_code", "adm1_code")).toEqual(sorted(old.out, "adm2_code", "adm1_code"));
});

test.each([
  ["old", "adm2_code", null, /no code/],
  ["new", "adm2_name", null, /no code/],
  ["new", "adm1_name", "Z", /more than one/],
] as const)(
  "a missing code or mixed name raises (%s %s)",
  async (side, column, value, match) => {
    const rs = namedTwoParentRows();
    const old: Row[] = rs.map((r) => ({
      ...r,
      adm1_code: `XY${r.adm1_code}`,
      adm2_code: `XY${r.adm1_code}${r.adm2_code}`,
    }));
    const neu = withoutCode2(rs);
    (side === "old" ? old : neu)[0][column] = value;
    await expect(codeUpdate(old, neu, { schemaA: CODE, schemaB: CODE })).rejects.toThrow(match);
  },
);

test("same-named siblings seeded from names raise", async () => {
  const oldRows = namedTwoParentRows();
  const old = await codeOld(oldRows);
  const neu = withoutCode2(oldRows);
  neu[1].adm2_name = neu[0].adm2_name;
  await expect(codeUpdate(old.file, neu, { schemaA: CODE, schemaB: CODE })).rejects.toThrow(
    /repeat under one parent/,
  );
});

// drift: py #194 writes the root code as a level-0 column
test.fails("a template writes the root code at level 0", async () => {
  const raw: Row[] = [
    ["51", "5101"],
    ["51", "5102"],
    ["52", "5201"],
  ].map(([c1, c2], i) => ({
    adm1_code: c1,
    adm1_name: `A${c1}`,
    adm2_code: c2,
    adm2_name: `B${c2}`,
    wkt: square(i, 0),
  }));
  const old = await codeCreate(raw, "BH", "", "auto", "embed", CODE);
  const { columns, out } = await codeUpdate(old.file, raw, { schemaA: CODE, schemaB: CODE });
  expect(columns.indexOf("adm0_code")).toBe(columns.indexOf("adm1_name") + 1);
  expect(new Set(out.map((r) => r.adm0_code))).toEqual(new Set(["BH"]));
});

test.todo("the CSV changelog starts with a BOM (export shape)");
test.todo("each step runs standalone (no TS counterpart)");
