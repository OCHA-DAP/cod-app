import { beforeAll, expect, test } from "vitest";
import { runCodeCreate, type SourceCodes, type TargetSchema } from "$lib/tools/code-create/pipeline";
import { exportColumns, layer, ready, rows } from "./helpers";

type Row = Record<string, string | number | null>;
const TEMPLATES: TargetSchema = { codeField: "adm{n}_code", nameField: "adm{n}_name" };

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
const strip = (i: number) => `POLYGON((${i} 0, ${i + 1} 0, ${i + 1} 1, ${i} 1, ${i} 0))`;

async function codeCreate(
  rs: Row[],
  rootCode: string,
  delimiter: string,
  minWidth: string,
  sourceCodes: SourceCodes = "replace",
  schema: TargetSchema | null = null,
) {
  await layer(synthetic(rs));
  const result = await runCodeCreate(conn, rootCode, delimiter, minWidth, sourceCodes, schema);
  const columns = (await exportColumns("code_create")).filter((c) => c !== "geometry");
  const out = await rows<Row>("SELECT * EXCLUDE (geometry) FROM '_export.parquet'");
  return { ...result, columns, out };
}

// The named columns of each row, sorted by the first of `order` then the rest.
const fetch = (out: Row[], cols: string[], order = cols) =>
  [...out]
    .sort((a, b) => {
      for (const c of order) {
        const d = String(a[c]).localeCompare(String(b[c]));
        if (d) return d;
      }
      return 0;
    })
    .map((r) => cols.map((c) => r[c]));
const ADM123 = ["adm1_code", "adm2_code", "adm3_code"];
const BY_ADM3 = ["adm3_code"];

test("a GADM-style cold start passes admin0 through", async () => {
  const unit = (g1: string, n1: string, g2: string, n2: string, i: number, y = 0): Row => ({
    GID_0: "AFG",
    GID_1: g1,
    NAME_1: n1,
    GID_2: g2,
    NAME_2: n2,
    wkt: `POLYGON((${i} ${y}, ${i + 1} ${y}, ${i + 1} ${y + 1}, ${i} ${y + 1}, ${i} ${y}))`,
  });
  const { out } = await codeCreate(
    [
      unit("AFG.1_1", "Badakhshan", "AFG.1.1_1", "Arghanj Khwa", 0),
      unit("AFG.1_1", "Badakhshan", "AFG.1.2_1", "Baharak", 1),
      unit("AFG.2_1", "Badghis", "AFG.2.1_1", "Ab Kamari", 0, 1),
    ],
    "AFG",
    ".",
    "3",
  );
  expect(fetch(out, ["GID_0", "GID_1", "NAME_1", "GID_2", "NAME_2"], ["GID_1", "GID_2"])).toEqual([
    ["AFG", "AFG.001", "Badakhshan", "AFG.001.001", "Arghanj Khwa"],
    ["AFG", "AFG.001", "Badakhshan", "AFG.001.002", "Baharak"],
    ["AFG", "AFG.002", "Badghis", "AFG.002.001", "Ab Kamari"],
  ]);
});

test("word-per-level naming", async () => {
  const { out } = await codeCreate(
    [
      { state_code: "TX", county_code: "TX-HARRIS", county_name: "Harris", wkt: strip(0) },
      { state_code: "TX", county_code: "TX-DALLAS", county_name: "Dallas", wkt: strip(1) },
      {
        state_code: "CA",
        county_code: "CA-ORANGE",
        county_name: "Orange",
        wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))",
      },
    ],
    "USA",
    ".",
    "3",
  );
  expect(fetch(out, ["state_code", "county_code", "county_name"], ["county_code"])).toEqual([
    ["USA.001", "USA.001.001", "Orange"],
    ["USA.002", "USA.002.001", "Dallas"],
    ["USA.002", "USA.002.002", "Harris"],
  ]);
});

test("an explicit code/name field overrides ambiguous auto-detection", async () => {
  const { out } = await codeCreate(
    [
      { adm0_code: "AFG", adm1_code: "NAT-01", adm1_pcode: "PC-01", adm1_name: "Badakhshan", wkt: strip(0) },
      { adm0_code: "AFG", adm1_code: "NAT-02", adm1_pcode: "PC-02", adm1_name: "Badghis", wkt: strip(1) },
    ],
    "AFG",
    ".",
    "3",
    "replace",
    { codeField: "adm{n}_pcode", nameField: "adm{n}_name" },
  );
  expect(fetch(out, ["adm0_code", "adm1_code", "adm1_pcode", "adm1_name"], ["adm1_pcode"])).toEqual(
    [
      ["AFG", "NAT-01", "AFG.001", "Badakhshan"],
      ["AFG", "NAT-02", "AFG.002", "Badghis"],
    ],
  );
});

test("overflow writes a four-digit code and an issues row", async () => {
  const total = 1200;
  const rs = Array.from({ length: total }, (_, i) => {
    const x = i / 10;
    return {
      adm0_code: "BRA",
      adm1_code: `BRA-${String(i).padStart(4, "0")}`,
      wkt: `POLYGON((${x} 0, ${x + 0.1} 0, ${x + 0.1} 1, ${x} 1, ${x} 0))`,
    };
  });
  const { out, issues } = await codeCreate(rs, "BRA", ".", "3");
  const codes = new Set(out.map((r) => r.adm1_code as string));
  expect(codes.size).toBe(total);
  expect(codes.has("BRA.999")).toBe(true);
  expect(codes.has("BRA.1000")).toBe(true);
  for (const c of codes) {
    const tail = c.split(".").at(-1)!;
    if (Number(tail) <= 999) expect(tail).toHaveLength(3);
  }
  expect(issues).toMatchObject([
    { kind: "digit-overflow", level: 1, parentCode: "BRA", childCount: total, minWidth: 3 },
  ]);
});

test("a disputed-territory root code is opaque", async () => {
  const { out } = await codeCreate(
    [
      { region_code: "K1", region_name: "North Kosovo", wkt: strip(0) },
      { region_code: "K2", region_name: "South Kosovo", wkt: strip(1) },
    ],
    "XKO",
    ".",
    "3",
  );
  expect(fetch(out, ["region_code", "region_name"])).toEqual([
    ["XKO.001", "North Kosovo"],
    ["XKO.002", "South Kosovo"],
  ]);
});

const TWO_LEVEL_ROWS: Row[] = [
  { adm1_code: "P1", adm2_code: "P1-01", wkt: strip(0) },
  { adm1_code: "P1", adm2_code: "P1-02", wkt: strip(1) },
  { adm1_code: "P2", adm2_code: "P2-01", wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))" },
];

test("custom delimiter and width", async () => {
  const { out } = await codeCreate(TWO_LEVEL_ROWS, "AA", "-", "2");
  expect(new Set(out.map((r) => r.adm1_code))).toEqual(new Set(["AA-01", "AA-02"]));
});

test("a trailing name-only level raises", async () => {
  const unit = (p: string, n1: string, c2: string, n2: string, n3: string, i: number): Row => ({
    adm1_pcode: p,
    adm1_name: n1,
    adm2_pcode: c2,
    adm2_name: n2,
    adm3_name: n3,
    wkt: strip(i),
  });
  await expect(
    codeCreate(
      [
        unit("P1", "Province1", "A1", "AlphaCounty", "Ward1", 0),
        unit("P1", "Province1", "A2", "BetaCounty", "Ward2", 1),
        unit("P2", "Province2", "B1", "GammaCounty", "Ward1", 2),
        unit("P2", "Province2", "B2", "DeltaCounty", "Ward2", 3),
        unit("P3", "Province3", "C1", "EpsilonCounty", "Ward3", 4),
      ],
      "AA",
      ".",
      "3",
    ),
  ).rejects.toThrow(/no existing code column/);
});

test("a supplemental grouping raises", async () => {
  const units = [
    ["A", "North", "X", "0101", "101"],
    ["A", "North", "X", "0102", "102"],
    ["A", "North", "Y", "0103", "103"],
    ["A", "North", "Z", "0104", "104"],
    ["B", "South", "Y", "0201", "201"],
    ["B", "South", "Z", "0202", "202"],
    ["B", "South", "W", "0203", "203"],
    ["B", "South", "W", "0204", "204"],
  ];
  await expect(
    codeCreate(
      units.map(([a1, n1, n2, c3, n3], i) => ({
        adm1_code: a1,
        adm1_name: n1,
        adm2_name: n2,
        adm3_code: c3,
        adm3_name: n3,
        wkt: strip(i),
      })),
      "AA",
      ".",
      "3",
    ),
  ).rejects.toThrow(/\[["']adm2_name["']\] group units like a level/);
});

test("a scattered type column does not stop coding", async () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
  const rs = Array.from({ length: 12 }, (_, i) => {
    const half = ["North", "South"][Math.floor(i / 6)];
    return {
      adm1_code: `P${Math.floor(i / 6) + 1}`,
      adm1_name: half,
      adm2_code: `P${Math.floor(i / 6) + 1}${String((i % 6) + 1).padStart(2, "0")}`,
      adm2_name: `${names[i % 6]} ${half}`,
      unit_type: ["city", "district", "town"][i % 3],
      wkt: strip(i),
    };
  });
  const { out } = await codeCreate(rs, "AA", ".", "2");
  expect(fetch(out, ["adm1_code", "adm2_code"], ["adm2_code"])[0]).toEqual(["AA.01", "AA.01.01"]);
});

const sourceCodedRows = (adm3 = ["0101", "0102", "0201", "0202"]): Row[] =>
  [
    ["51", "North", "Hidd", adm3[0]],
    ["51", "North", "Adhari", adm3[1]],
    ["52", "South", "Zallaq", adm3[2]],
    ["52", "South", "Askar", adm3[3]],
  ].map(([c1, n1, n2, c3], i) => ({
    adm1_code: c1,
    adm1_name: n1,
    adm2_name: n2,
    adm3_code: c3,
    adm3_name: c3.replace(/^0+/, ""),
    wkt: strip(i),
  }));

test("embed concatenates source codes without a delimiter", async () => {
  const { out } = await codeCreate(sourceCodedRows(), "BH", "", "2", "embed", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)).toEqual([
    ["BH51", "BH5101", "BH51010102"],
    ["BH51", "BH5102", "BH51020101"],
    ["BH52", "BH5201", "BH52010202"],
    ["BH52", "BH5202", "BH52020201"],
  ]);
});

test("embed raises on mixed-length codes without a delimiter", async () => {
  await expect(
    codeCreate(sourceCodedRows(["101", "0102", "0201", "0202"]), "BH", "", "2", "embed", TEMPLATES),
  ).rejects.toThrow(/vary in length/);
});

test("replace without a delimiter numbers each level", async () => {
  const { out } = await codeCreate(sourceCodedRows(), "BH", "", "auto", "replace", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)[0]).toEqual(["BH1", "BH11", "BH111"]);
});

test("a fixed-width overflow raises without a delimiter", async () => {
  const rs = Array.from({ length: 10 }, (_, i) => ({
    adm1_code: "51",
    adm1_name: "North",
    adm2_name: `Unit ${String(i).padStart(2, "0")}`,
    wkt: strip(i),
  }));
  await expect(codeCreate(rs, "BH", "", "1", "replace", TEMPLATES)).rejects.toThrow(
    /past the top 10%/,
  );
});

const governmentRows = (codes: (string | number)[][]): Row[] =>
  codes.map(([c1, c2, c3], i) => ({
    adm1_code: c1,
    adm1_name: `A${c1}`,
    adm2_code: c2,
    adm2_name: `B${c2}`,
    adm3_code: c3,
    adm3_name: `C${c3}`,
    wkt: strip(i),
  }));

test.each([
  [
    "local",
    [
      ["11", "22", "33"],
      ["11", "23", "34"],
    ],
  ],
  [
    "hierarchical",
    [
      ["11", "1122", "112233"],
      ["11", "1123", "112334"],
    ],
  ],
  [
    "pcodes",
    [
      ["XY11", "XY1122", "XY112233"],
      ["XY11", "XY1123", "XY112334"],
    ],
  ],
])("embed accepts local or parent-prefixed codes (%s)", async (_, codes) => {
  const { out } = await codeCreate(governmentRows(codes), "XY", "", "auto", "embed", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)).toEqual([
    ["XY11", "XY1122", "XY112233"],
    ["XY11", "XY1123", "XY112334"],
  ]);
});

test.each([
  [
    "auto",
    [
      [1, 101, 10101],
      [11, 1105, 110501],
    ],
    "auto",
    [
      ["XY01", "XY0101", "XY010101"],
      ["XY11", "XY1105", "XY110501"],
    ],
  ],
  [
    "min-width",
    [
      [1, 1, 1],
      [11, 2, 10],
    ],
    "3",
    [
      ["XY001", "XY001001", "XY001001001"],
      ["XY011", "XY011002", "XY011002010"],
    ],
  ],
  [
    "prefixed-min-width",
    [
      [1, 101, 10101],
      [11, 1105, 110501],
    ],
    "3",
    [
      ["XY001", "XY001001", "XY001001001"],
      ["XY011", "XY011005", "XY011005001"],
    ],
  ],
  [
    "per-level",
    [
      [1, 1, 1],
      [11, 2, 10],
    ],
    "2,3,4",
    [
      ["XY01", "XY01001", "XY010010001"],
      ["XY11", "XY11002", "XY110020010"],
    ],
  ],
])("embed pads integer source codes (%s)", async (_, codes, minWidth, expected) => {
  const { out } = await codeCreate(governmentRows(codes), "XY", "", minWidth, "embed", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)).toEqual(expected);
});

test.each([
  [
    "mixed-remainder",
    [
      [11, 110, 1],
      [11, 1100, 2],
    ],
    [
      ["XY11", "XY110110", "XY1101101"],
      ["XY11", "XY111100", "XY1111002"],
    ],
  ],
  [
    "some-repeat-parent",
    Array.from({ length: 12 }, (_, k) => [1, k + 1, k + 1]),
    Array.from({ length: 12 }, (_, k) => {
      const n = String(k + 1).padStart(2, "0");
      return ["XY1", `XY1${n}`, `XY1${n}${n}`];
    }),
  ],
])("embed pads integers numbered within a parent (%s)", async (_, codes, expected) => {
  const { out } = await codeCreate(governmentRows(codes), "XY", "", "auto", "embed", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)).toEqual(expected);
});

test("embed raises when only some codes carry the parent", async () => {
  const codes = [
    ["11", "1122", "33"],
    ["11", "1123", "112334"],
  ];
  await expect(
    codeCreate(governmentRows(codes), "XY", "", "auto", "embed", TEMPLATES),
  ).rejects.toThrow(/1 of 2 source codes/);
});

const copied = () => codeCreate(sourceCodedRows(), "BHR", ".", "3", "copy", TEMPLATES);

test("copy keeps source codes in numbered siblings", async () => {
  const { out } = await copied();
  expect(
    fetch(out, ["adm1_code", "adm1_code1", "adm2_code", "adm3_code", "adm3_code1"], BY_ADM3),
  ).toEqual([
    ["BHR.001", "51", "BHR.001.001", "BHR.001.001.001", "0102"],
    ["BHR.001", "51", "BHR.001.002", "BHR.001.002.001", "0101"],
    ["BHR.002", "52", "BHR.002.001", "BHR.002.001.001", "0202"],
    ["BHR.002", "52", "BHR.002.002", "BHR.002.002.001", "0201"],
  ]);
});

test("copy keeps source codes in numbered siblings: column order", async () => {
  const { columns } = await copied();
  for (const code of ["adm1_code", "adm3_code"])
    expect(columns.indexOf(`${code}1`)).toBe(columns.indexOf(code) + 1);
  expect(columns.indexOf("adm2_code")).toBe(columns.indexOf("adm2_name") + 1);
});

const copyWithAdm0 = async (adm1Code: string | null) => {
  const rs = sourceCodedRows().map((r) => ({
    ...r,
    adm0_code: "BH",
    adm0_name: "Bahrain",
    adm1_code: adm1Code,
  }));
  return (await codeCreate(rs, "BHR", ".", "3", "copy", TEMPLATES)).columns;
};

test("copy keeps adm0_code alongside adm1", async () => {
  expect(await copyWithAdm0("51")).toContain("adm0_code1");
});

test("copy drops adm0_code without adm1", async () => {
  expect(await copyWithAdm0(null)).not.toContain("adm0_code1");
});

test.each([
  ["1,2,3", ["BHR.1", "BHR.1.01", "BHR.1.01.001"]],
  ["auto", ["BHR.1", "BHR.1.1", "BHR.1.1.1"]],
])("min width per level and auto (%s)", async (minWidth, expected) => {
  const { out } = await codeCreate(sourceCodedRows(), "BHR", ".", minWidth, "replace", TEMPLATES);
  expect(fetch(out, ADM123, BY_ADM3)[0]).toEqual(expected);
});

test("a min width list must match the level count", async () => {
  await expect(
    codeCreate(sourceCodedRows(), "BHR", ".", "2,3", "replace", TEMPLATES),
  ).rejects.toThrow(/3 level/);
});

test("an all-blank code column is numbered by name", async () => {
  const rs = sourceCodedRows();
  [null, "", " ", null].forEach((blank, i) => (rs[i].adm3_code = blank));
  const { out } = await codeCreate(rs, "BH", "", "1", "replace", TEMPLATES);
  expect(fetch(out, ["adm3_code", "adm3_name"])).toEqual([
    ["BH111", "102"],
    ["BH121", "101"],
    ["BH211", "202"],
    ["BH221", "201"],
  ]);
});

test.each(["replace", "copy", "embed"] as const)(
  "partly missing codes raise (%s)",
  async (sourceCodes) => {
    const rs = sourceCodedRows();
    rs[1].adm3_code = "";
    await expect(codeCreate(rs, "BH", "", "auto", sourceCodes, TEMPLATES)).rejects.toThrow(
      /1 row\(s\) with no source code/,
    );
  },
);

test("integer source codes", async () => {
  const rs = [
    [7, 70],
    [7, 71],
    [8, 80],
  ].map(([c1, c2], i) => ({
    adm0_code: 13,
    adm1_code: c1,
    adm1_name: `A${c1}`,
    adm2_code: c2,
    adm2_name: `B${c2}`,
    wkt: strip(i),
  }));
  const { out } = await codeCreate(rs, "XY", "", "auto", "copy", TEMPLATES);
  expect(
    fetch(
      out,
      ["adm0_code", "adm0_code1", "adm1_code", "adm1_code1", "adm2_code", "adm2_code1"],
      ["adm2_code"],
    ),
  ).toEqual([
    ["XY", "13", "XY1", "7", "XY11", "70"],
    ["XY", "13", "XY1", "7", "XY12", "71"],
    ["XY", "13", "XY2", "8", "XY21", "80"],
  ]);
});

test("structural detection ignores empty alternate names", async () => {
  const rs: Row[] = [];
  for (const p of ["01", "02"])
    for (const c of ["01", "02", "03", "04", "05"])
      rs.push({
        adm1_pcode: `XY${p}`,
        adm1_name: `P${p}`,
        adm2_pcode: `XY${p}${c}`,
        adm2_name: `C${p}${c}`,
        adm2_name1: null,
        wkt: strip(rs.length),
      });
  const { out } = await codeCreate(rs, "XY", "", "2");
  expect(new Set(out.map((r) => r.adm2_pcode)).size).toBe(10);
});

test("same-named siblings seeded from names raise", async () => {
  const rs = ["Hill", "Hill", "Vale"].map((name, i) => ({
    adm1_code: "51",
    adm1_name: "North",
    adm2_name: name,
    wkt: strip(i),
  }));
  await expect(codeCreate(rs, "XY", "", "2", "replace", TEMPLATES)).rejects.toThrow(
    /["']51 > Hill["']/,
  );
});

test("a template writes the root code at level 0", async () => {
  const rs = sourceCodedRows().map(({ adm3_name, ...r }) => ({ adm3_name, ...r }));
  const { out, columns } = await codeCreate(rs, "BH", ".", "1", "replace", TEMPLATES);
  expect(columns.indexOf("adm0_code")).toBe(columns.indexOf("adm1_name") + 1);
  expect(new Set(out.map((r) => r.adm0_code))).toEqual(new Set(["BH"]));
});

test("a template seeds a single level with no level 0 column", async () => {
  const rs = sourceCodedRows().map(({ adm3_name, wkt }) => ({ adm1_name: adm3_name, wkt }));
  const { out } = await codeCreate(rs, "BH", ".", "1", "replace", TEMPLATES);
  expect(new Set(out.map((r) => r.adm0_code))).toEqual(new Set(["BH"]));
});

test("structural detection adds no level 0", async () => {
  const { columns } = await codeCreate(sourceCodedRows(), "BH", ".", "1");
  expect(columns.some((c) => c.startsWith("adm0"))).toBe(false);
});

test.todo("name_field and code_field must be given together (API arguments, no TS counterpart)");
test.todo("the issues CSV starts with a BOM (export shape)");
test.todo("default output path (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
