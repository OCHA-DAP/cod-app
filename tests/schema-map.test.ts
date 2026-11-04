import { beforeAll, expect, test } from "vitest";
import {
  applyCrosswalk,
  DEFAULT_TARGET_SCHEMA,
  inferCrosswalk,
  type CrosswalkRow,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/editor";
import { exportColumns, layer, ready } from "./helpers";

type Cell = string | number | null;
const square = (i: number) => `POLYGON((${i} 0, ${i + 1} 0, ${i + 1} 1, ${i} 1, ${i} 0))`;
const LEVEL = { nameField: "level{n}_name", codeField: "level{n}_pcode" };
const PCODE = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const lit = (v: Cell) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

// Row tuples lead with the unit-square index, as py's _write_table leads with geom.
function table(cols: string[], rs: [number, ...Cell[]][]) {
  const values = rs.map(([i, ...cells]) => `('${square(i)}', ${cells.map(lit).join(", ")})`);
  return `SELECT ST_GeomFromText(w) AS geom, * EXCLUDE (w)
    FROM (VALUES ${values.join(", ")}) AS t(w, ${cols.join(", ")})`;
}

type Out = { target_column: string; note: string; unique_count: string };
async function map(
  select: string,
  schema: TargetSchema = DEFAULT_TARGET_SCHEMA,
  level: number | null = null,
) {
  await layer(select);
  const crosswalk = await inferCrosswalk(conn, schema, level);
  const by: Record<string, Out> = Object.fromEntries(
    crosswalk.map((r) => [
      r.sourceColumn,
      { target_column: r.targetColumn ?? "", note: r.note, unique_count: String(r.uniqueCount) },
    ]),
  );
  return { crosswalk, by };
}

const CHAIN = table(
  ["adm0_pcode", "adm1_pcode", "decoy_code", "adm1_name", "notes"],
  [
    [0, "R0", "R0-1", "R0X1", "Alpha", "Miscellaneous One"],
    [1, "R0", "R0-1", "R0X2", "Alpha", "Miscellaneous Two"],
    [2, "R0", "R0-2", "R0X1", "Beta", "Miscellaneous Three"],
    [3, "R0", "R0-2", "R0X2", "Beta", "Miscellaneous One"],
  ],
);
const NO_COUNTRY = table(
  ["reg_code", "reg_name", "dist_code", "dist_name"],
  [
    [0, "R1", "North", "R1D1", "A"],
    [1, "R1", "North", "R1D2", "B"],
    [2, "R2", "South", "R2D1", "C"],
    [3, "R2", "South", "R2D2", "D"],
  ],
);

test("code and name tiers", async () => {
  const { by } = await map(CHAIN, LEVEL);
  expect(by.adm0_pcode).toMatchObject({ target_column: "", note: "" });
  expect(by.adm1_pcode).toEqual({ target_column: "level1_pcode", note: "", unique_count: "2" });
  expect(by.adm1_name).toEqual({ target_column: "level1_name", note: "", unique_count: "2" });
  expect(by.decoy_code).toMatchObject({ target_column: "", note: "ambiguous, level 1" });
  expect(by.notes).toMatchObject({ target_column: "", note: "" });
});

test("unique count reveals a name reused across parents", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name"],
      [
        [0, "P1", "P101", "Central"],
        [1, "P1", "P102", "North"],
        [2, "P2", "P201", "Central"],
        [3, "P2", "P202", "South"],
      ],
    ),
    DEFAULT_TARGET_SCHEMA,
    1,
  );
  expect(by.adm1_name).toMatchObject({ target_column: "adm1_name", unique_count: "4" });
  expect(by.adm1_pcode.unique_count).toBe("4");
});

test("noise columns are excluded entirely", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "OGC_FID", "ogc_fid_orig", "OBJECTID"],
      [
        [0, "R0", "R1", "1", "1", "1"],
        [1, "R0", "R1", "2", "2", "2"],
        [2, "R0", "R2", "3", "3", "3"],
        [3, "R0", "R2", "4", "4", "4"],
      ],
    ),
  );
  expect(Object.keys(by)).not.toContain("OGC_FID");
  expect(Object.keys(by)).not.toContain("ogc_fid_orig");
  expect(Object.keys(by)).not.toContain("OBJECTID");
});

test("output ordering: level desc, name before code, unmatched last", async () => {
  const { crosswalk } = await map(CHAIN, LEVEL);
  expect(crosswalk.map((r) => r.sourceColumn)).toEqual([
    "adm1_name",
    "adm1_pcode",
    "decoy_code",
    "adm0_pcode",
    "notes",
  ]);
});

test("target schema defaults to the bundled default", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name"],
      [
        [0, "MG", "MG1", "Alpha"],
        [1, "MG", "MG2", "Beta"],
      ],
    ),
  );
  expect(by.adm1_pcode).toEqual({ target_column: "adm1_code", note: "", unique_count: "2" });
  expect(by.adm1_name).toEqual({ target_column: "adm1_name", note: "", unique_count: "2" });
});

test("a single-row admin0 file maps nothing", async () => {
  const { by } = await map(table(["adm0_pcode", "adm0_name"], [[0, "MG0", "Madagascar"]]));
  expect(by.adm0_pcode.target_column).toBe("");
});

test("a target schema missing its placeholder raises", async () => {
  await expect(map(CHAIN, { nameField: "adm_name", codeField: "adm{n}_pcode" })).rejects.toThrow(
    /must both contain a/,
  );
});

test("a constant bare-letter code is reclassified", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name"],
      [
        [0, "MG", "MG11", "Alpha"],
        [1, "MG", "MG11", "Alpha"],
        [2, "MG", "MG12", "Beta"],
        [3, "MG", "MG12", "Beta"],
      ],
    ),
    PCODE,
  );
  expect(by.adm1_pcode).toMatchObject({ note: "", unique_count: "2" });
  expect(by.adm1_name).toMatchObject({ note: "", unique_count: "2" });
});

test("a name bracket group numbers multiple name candidates", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name", "tied_name"],
      [
        [0, "R0", "R0R1", "Alpha", "TypeX"],
        [1, "R0", "R0R1", "Alpha", "TypeX"],
        [2, "R0", "R0R2", "Beta", "TypeY"],
        [3, "R0", "R0R2", "Beta", "TypeY"],
      ],
    ),
    LEVEL,
  );
  expect(by.adm1_name.target_column).toBe("level1_name");
  expect(by.tied_name.target_column).toBe("level1_name1");
});

test("admin level zero is never resolved", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm0_name", "adm1_pcode", "adm1_name"],
      [
        [0, "MG", "Madagascar", "MGR1", "Alpha"],
        [1, "MG", "Madagascar", "MGR1", "Alpha"],
        [2, "MG", "Madagascar", "MGR2", "Beta"],
        [3, "MG", "Madagascar", "MGR2", "Beta"],
      ],
    ),
    PCODE,
  );
  expect(by.adm0_pcode).toMatchObject({ target_column: "", note: "" });
  expect(by.adm0_name).toMatchObject({ target_column: "", note: "" });
  expect(by.adm1_pcode).toMatchObject({ note: "", unique_count: "2" });
  expect(by.adm1_name).toMatchObject({ note: "", unique_count: "2" });
});

test("an exact bijective match wins over a looser function match", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name", "region_group"],
      [
        [0, "R0", "R0R1", "Alpha", "Group1"],
        [1, "R0", "R0R2", "Beta", "Group1"],
        [2, "R0", "R0R3", "Gamma", "Group2"],
        [3, "R0", "R0R4", "Delta", "Group2"],
      ],
    ),
    LEVEL,
  );
  expect(by.adm1_name.target_column).toBe("level1_name");
  expect(by.region_group).toMatchObject({
    target_column: "",
    note: "supplemental, superset of level 1",
  });
});

test("an embedded parent wins a chain tie over an unembedded grouping", async () => {
  const district: Record<string, string> = { "01": "S1", "02": "S1", "03": "S2", "04": "S2" };
  const word: Record<string, string> = {
    "01": "North",
    "02": "South",
    "03": "East",
    "04": "West",
    "1": "Upper",
    "2": "Lower",
  };
  const rs: [number, ...Cell[]][] = [];
  for (const a of "AB")
    for (const b of ["01", "02", "03", "04"])
      for (const c of "12")
        rs.push([
          rs.length,
          "R0",
          `R0${a}`,
          `Region ${a}`,
          `R0${a}${district[b]}`,
          `R0${a}${b}`,
          `${a} ${word[b]}`,
          `R0${a}${b}${c}`,
          `${a} ${word[b]} ${word[c]}`,
        ]);
  const { by } = await map(
    table(
      [
        "adm0_pcode",
        "adm1_pcode",
        "adm1_name",
        "district",
        "adm2_pcode",
        "adm2_name",
        "adm3_pcode",
        "adm3_name",
      ],
      rs,
    ),
  );
  expect(by.adm2_pcode.target_column).toBe("adm2_code");
  expect(by.adm3_pcode.target_column).toBe("adm3_code");
  expect(by.district.note).toBe("supplemental, superset of level 2");
});

async function unembeddedMiddle(middle: string, finest: string) {
  const rs: [number, ...Cell[]][] = [];
  for (const a of "AB")
    for (let b = 1; b <= 6; b++)
      rs.push([rs.length, "R0", `R0${a}`, `R0${a}S${Math.floor((b + 2) / 3)}`, `R0${a}0${b}`]);
  return (await map(table(["adm0_pcode", "adm1_pcode", middle, finest], rs))).by;
}

test("an unembedded grouping off the naming pattern is supplemental", async () => {
  const by = await unembeddedMiddle("sendistpcode", "adm2_pcode");
  expect(by.adm2_pcode.target_column).toBe("adm2_code");
  expect(by.sendistpcode.note).toBe("supplemental, superset of level 2");
});

test("an unembedded level on the naming pattern stays a level", async () => {
  const by = await unembeddedMiddle("adm2_pcode", "adm3_pcode");
  expect(by.adm2_pcode.target_column).toBe("adm2_code");
  expect(by.adm3_pcode.target_column).toBe("adm3_code");
});

// 20 admin1 units (bijective pcode/name, letter names so they aren't code-shaped) plus extras.
const twentyUnitRows = (...extras: string[][]): [number, ...Cell[]][] =>
  Array.from({ length: 20 }, (_, k) => {
    const i = k + 1;
    return [i, "R0", `R0R${i}`, `Region${String.fromCharCode(64 + i)}`, ...extras.map((e) => e[k])];
  });
const twentyUnits = (values: string[]) =>
  map(table(["adm0_pcode", "adm1_pcode", "adm1_name", "alt_name"], twentyUnitRows(values)), LEVEL);
const range = (f: (i: number) => string) => Array.from({ length: 20 }, (_, k) => f(k + 1));

test("a near-bijective alt name becomes a numbered sibling", async () => {
  const values = range((i) => `Nom${i}`);
  values[1] = values[0];
  const { by } = await twentyUnits(values);
  expect(by.adm1_name.target_column).toBe("level1_name");
  expect(by.alt_name).toMatchObject({ target_column: "level1_name1", note: "" });
});

test("a collapse over the threshold stays supplemental", async () => {
  const { by } = await twentyUnits(range((i) => `Group${(i - 1) % 7}`));
  expect(by.alt_name).toMatchObject({
    target_column: "",
    note: "supplemental, superset of level 1",
  });
});

test("collapse near the threshold boundary", async () => {
  expect((await twentyUnits(range((i) => `Nom${(i - 1) % 15}`))).by.alt_name.target_column).toBe(
    "level1_name1",
  );
  expect((await twentyUnits(range((i) => `Nom${(i - 1) % 13}`))).by.alt_name).toMatchObject({
    target_column: "",
    note: "supplemental, superset of level 1",
  });
});

test("two tolerated siblings get sequential numbering without collision", async () => {
  const values1 = range((i) => `Nom${i}`);
  values1[1] = values1[0];
  const values2 = range((i) => `Autre${i}`);
  values2[1] = values2[0];
  values2[3] = values2[2];
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name", "alt_name1", "alt_name2"],
      twentyUnitRows(values1, values2),
    ),
    LEVEL,
  );
  expect(
    new Set([by.adm1_name, by.alt_name1, by.alt_name2].map((r) => r.target_column)),
  ).toEqual(new Set(["level1_name", "level1_name1", "level1_name2"]));
});

test("a code bracket group numbers bijective code companions", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "alt1_pcode"],
      [
        [0, "R0", "R0R1", "R0ALT1"],
        [1, "R0", "R0R1", "R0ALT1"],
        [2, "R0", "R0R2", "R0ALT2"],
        [3, "R0", "R0R2", "R0ALT2"],
      ],
    ),
    LEVEL,
  );
  expect(by.adm1_pcode.target_column).toBe("level1_pcode");
  expect(by.alt1_pcode.target_column).toBe("level1_pcode1");
});

test("a parent-embedding code outranks an earlier surrogate id", async () => {
  const { by } = await map(
    table(
      ["unit_id", "adm0_pcode", "adm1_pcode"],
      [
        [0, "199", "R0", "R0R1"],
        [1, "199", "R0", "R0R1"],
        [2, "303", "R0", "R0R2"],
        [3, "303", "R0", "R0R2"],
      ],
    ),
  );
  expect(by.adm1_pcode.target_column).toBe("adm1_code");
  expect(by.unit_id.target_column).toBe("adm1_code1");
});

// drift: py #129 lists GRASS `cat` (and `bbox`) as noise; the site's NOISE_COLUMNS lacks both
test.fails("a GRASS cat column is excluded as noise", async () => {
  const { by } = await map(
    table(
      ["cat", "adm0_pcode", "adm1_pcode"],
      [
        [0, "65", "R0", "R0R1"],
        [1, "65", "R0", "R0R1"],
        [2, "14", "R0", "R0R2"],
        [3, "14", "R0", "R0R2"],
      ],
    ),
  );
  expect(Object.keys(by)).not.toContain("cat");
});

test("an unedited crosswalk with ambiguous and unmatched rows survives refactor", async () => {
  const { crosswalk } = await map(CHAIN, LEVEL);
  await applyCrosswalk(conn, crosswalk as CrosswalkRow[], LEVEL);
  expect(new Set(await exportColumns("schema_refactor"))).toEqual(
    new Set(["level1_pcode", "level1_name", "geometry"]),
  );
});

test("level anchors the finest level", async () => {
  const { by } = await map(NO_COUNTRY, DEFAULT_TARGET_SCHEMA, 2);
  expect(by.dist_code.target_column).toBe("adm2_code");
  expect(by.dist_name.target_column).toBe("adm2_name");
  expect(by.reg_code.target_column).toBe("adm1_code");
  expect(by.reg_name.target_column).toBe("adm1_name");
});

test("an omitted level numbers the coarsest one", async () => {
  const { by } = await map(NO_COUNTRY);
  expect(by.reg_code.target_column).toBe("adm1_code");
  expect(by.dist_code.target_column).toBe("adm2_code");
});

test("an omitted level with a constant root", async () => {
  expect((await map(CHAIN, LEVEL)).by.adm1_pcode.target_column).toBe("level1_pcode");
});

test("a single-level file defaults to one or takes the level", async () => {
  const flat = table(
    ["com_code", "com_name"],
    [
      [0, "C001", "Alpha"],
      [1, "C002", "Beta"],
      [2, "C003", "Gamma"],
      [3, "C004", "Delta"],
    ],
  );
  expect((await map(flat)).by.com_code.target_column).toBe("adm1_code");
  expect((await map(flat, DEFAULT_TARGET_SCHEMA, 3)).by.com_code.target_column).toBe("adm3_code");
});

test("level skips a folded constant root", async () => {
  const { by } = await map(CHAIN, LEVEL, 3);
  expect(by.adm0_pcode.target_column).toBe("");
  expect(by.adm1_pcode.target_column).toBe("level3_pcode");
  expect(by.adm1_name.target_column).toBe("level3_name");
  expect(by.decoy_code.note).toBe("ambiguous, level 3");
});

test("a level too shallow raises", async () => {
  await expect(map(NO_COUNTRY, DEFAULT_TARGET_SCHEMA, 0)).rejects.toThrow(/too shallow/);
});

test("single-row constants are one level", async () => {
  const { by } = await map(
    table(
      ["adm0_name", "adm0_pcode", "iso2", "version", "area_sqkm"],
      [[0, "Alpha", "AA", "A", "v1", 12.5]],
    ),
  );
  expect(Object.values(by).every((r) => !r.target_column)).toBe(true);
});

test("a blank constant is not embedded in names", async () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
  const { by } = await map(
    table(
      ["adm0_pcode", "adm0_name", "blank", "adm1_name", "adm1_pcode"],
      names.map((n, i) => [i, "AA", "Country", "", n, `AA${String(i).padStart(2, "0")}`]),
    ),
  );
  expect(by.adm1_name.target_column).toBe("adm1_name");
});

test("a name containing a short root constant stays a name", async () => {
  const names = ["Nitriansky", "Trnavsky", "Presovsky", "Kosicky"];
  const { by } = await map(
    table(
      ["adm0_pcode", "lang", "adm1_pcode", "adm1_name"],
      names.map((n, i) => [i, "XY", "sk", `XY${i}`, n]),
    ),
  );
  expect(by.adm1_pcode.target_column).toBe("adm1_code");
  expect(by.adm1_name.target_column).toBe("adm1_name");
});

test("numbered names beside an embedding code stay names", async () => {
  const { by } = await map(
    table(
      ["adm0_pcode", "adm1_pcode", "adm1_name"],
      [0, 1, 2, 3].map((i) => [i, "XY", `XY${i}`, `Region ${i}`]),
    ),
  );
  expect(by.adm1_pcode.target_column).toBe("adm1_code");
  expect(by.adm1_name.target_column).toBe("adm1_name");
});

test.todo("no single-value country column warning (logging, no TS counterpart)");
test.todo("name_field and code_field must be given together (API arguments, no TS counterpart)");
test.todo("default output path (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
