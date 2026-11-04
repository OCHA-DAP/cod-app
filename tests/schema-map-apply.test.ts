import { beforeAll, expect, test } from "vitest";
import { DEFAULT_TARGET_SCHEMA } from "$lib/tools/schema-map/pipeline";
import { loadCrosswalkCsv, parseCrosswalk } from "$lib/tools/schema-refactor/pipeline/crosswalk";
import { runSchemaRefactor } from "$lib/tools/schema-refactor/pipeline";
import { db, exportColumns, layer, ready, rows } from "./helpers";

const square = (i: number) => `POLYGON((${i} 0, ${i + 1} 0, ${i + 1} 1, ${i} 1, ${i} 0))`;
const INPUT = `SELECT ST_GeomFromText(w) AS geom, Name_Old, Code_Old, Extra FROM (VALUES
    ('${square(0)}', 'Alpha', 'A1', 'junk1'),
    ('${square(1)}', 'Beta', 'A2', 'junk2')
  ) AS v(w, Name_Old, Code_Old, Extra)`;
const FULL = [
  "source_column,target_column,confidence,note",
  "Name_Old,adm1_name,exact,",
  "Code_Old,adm1_pcode,exact,",
  "Extra,,unmatched,drop me",
].join("\n");
const MAPPED = new Set(["adm1_name", "adm1_pcode", "geometry"]);

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

async function apply(csv: string | Uint8Array, select = INPUT, schema = DEFAULT_TARGET_SCHEMA) {
  await layer(select);
  await loadCrosswalkCsv(db().db, conn, [new File([csv as BlobPart], "crosswalk.csv")]);
  return runSchemaRefactor(conn, await parseCrosswalk(conn), schema);
}

const csv = (rs: [string, string][]) =>
  ["source_column,target_column", ...rs.map(([s, t]) => `${s},${t}`)].join("\n");
const columns = async () => new Set(await exportColumns("schema_refactor"));

test("a full run renames and drops", async () => {
  await apply(FULL);
  expect(await columns()).toEqual(MAPPED);
  expect(await rows("SELECT adm1_name FROM sr_result_attr ORDER BY 1")).toEqual([
    { adm1_name: "Alpha" },
    { adm1_name: "Beta" },
  ]);
});

test("a BOM-prefixed crosswalk applies", async () => {
  const bytes = new TextEncoder().encode(FULL);
  await apply(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]));
  expect(await columns()).toEqual(MAPPED);
});

test("a column missing from the crosswalk raises", async () => {
  await expect(
    apply(
      csv([
        ["Name_Old", "adm1_name"],
        ["Code_Old", "adm1_pcode"],
      ]),
    ),
  ).rejects.toThrow(/not decided in the crosswalk/);
});

test("a crosswalk column missing from the file raises", async () => {
  await expect(
    apply(
      csv([
        ["Name_Old", "adm1_name"],
        ["Code_Old", "adm1_pcode"],
        ["Extra", ""],
        ["Nonexistent", "adm1_notes"],
      ]),
    ),
  ).rejects.toThrow(/not in the file/);
});

test("a duplicate source column raises", async () => {
  await expect(
    apply(
      csv([
        ["Name_Old", "adm1_name"],
        ["Name_Old", "adm1_name2"],
        ["Code_Old", "adm1_pcode"],
        ["Extra", ""],
      ]),
    ),
  ).rejects.toThrow(/same source_column more than once/);
});

test("a duplicate target raises", async () => {
  await expect(
    apply(
      csv([
        ["Name_Old", "adm1_name"],
        ["Code_Old", "adm1_name"],
        ["Extra", ""],
      ]),
    ),
  ).rejects.toThrow(/used more than once/);
});

test("a reserved target raises", async () => {
  await expect(
    apply(
      csv([
        ["Name_Old", "geometry"],
        ["Code_Old", "adm1_pcode"],
        ["Extra", ""],
      ]),
    ),
  ).rejects.toThrow(/reserved names/);
});

test("a crosswalk without a source_column header raises", async () => {
  await expect(apply("target_column\nadm1_name\n")).rejects.toThrow(
    /must be a CSV with a source_column column/,
  );
});

test("a blank source_column row is skipped", async () => {
  await apply(
    "source_column,target_column\n,adm1_name\nName_Old,adm1_name\nCode_Old,adm1_pcode\nExtra,\n",
  );
  expect(await columns()).toEqual(MAPPED);
});

const NOISY = `SELECT ST_GeomFromText(w) AS geom, Name_Old, OBJECTID, Shape_Length, Shape_Area, GlobalID
  FROM (VALUES ('${square(0)}', 'Alpha', '1', '2.5', '3.5', 'a'), ('${square(1)}', 'Beta', '2', '2.5', '3.5', 'b'))
  AS v(w, Name_Old, OBJECTID, Shape_Length, Shape_Area, GlobalID)`;

test("noise columns are excluded from the coverage check", async () => {
  await apply(csv([["Name_Old", "adm1_name"]]), NOISY);
  expect(await columns()).toEqual(new Set(["adm1_name", "geometry"]));
});

// drift: py quotes identifiers SQL-style; rename.ts and export.ts use JSON.stringify
test.fails("a target column with a quote round-trips", async () => {
  await apply('source_column,target_column\nName_Old,"adm1""name"\nCode_Old,adm1_pcode\nExtra,\n');
  expect(await columns()).toContain('adm1"name');
});

test("columns follow crosswalk rows and rows sort by code", async () => {
  const select = `SELECT ST_GeomFromText(w) AS geom, N2, C2, N2b, N1, C1 FROM (VALUES
      ('${square(0)}', 'Alpha', 'XY02001', 'Alt Alpha', 'Two', 'XY02'),
      ('${square(1)}', 'Bravo', 'XY01002', 'Alt Bravo', 'One', 'XY01'),
      ('${square(2)}', 'Charlie', 'XY01001', 'Alt Charlie', 'One', 'XY01')
    ) AS v(w, N2, C2, N2b, N1, C1)`;
  await apply(
    csv([
      ["C1", "adm1_code"],
      ["N2b", "adm2_name"],
      ["C2", "adm2_code"],
      ["N1", "adm1_name"],
      ["N2", "adm2_name1"],
    ]),
    select,
  );
  expect(await exportColumns("schema_refactor")).toEqual([
    "geometry",
    "adm1_code",
    "adm2_name",
    "adm2_code",
    "adm1_name",
    "adm2_name1",
  ]);
  expect(
    (await rows<{ c: string }>("SELECT adm2_code AS c FROM '_export.parquet'")).map((r) => r.c),
  ).toEqual(["XY01001", "XY01002", "XY02001"]);
});

test("no code-template target leaves rows unsorted", async () => {
  expect((await apply(FULL)).sortColumn).toBeNull();
});

test("a numbered sibling before its base is kept in place and reported", async () => {
  const result = await apply(
    csv([
      ["Name_Old", "adm1_name1"],
      ["Code_Old", "adm1_name"],
      ["Extra", ""],
    ]),
  );
  expect(await exportColumns("schema_refactor")).toEqual(["geometry", "adm1_name1", "adm1_name"]);
  expect(result.misorderedSiblings).toEqual(["adm1_name"]);
});

// drift: py #234 accepts a crosswalk that lists GIS bookkeeping columns
test.fails("noise columns listed in the crosswalk are accepted", async () => {
  await apply(
    csv([
      ["Name_Old", "adm1_name"],
      ["OBJECTID", ""],
      ["GlobalID", "global_id"],
    ]),
    `SELECT * EXCLUDE (Shape_Length, Shape_Area) FROM (${NOISY})`,
  );
  expect(await columns()).toEqual(new Set(["adm1_name", "global_id", "geometry"]));
});

test.todo("default output path (file output, no TS counterpart)");
test.todo("a debug apply step exports the crosswalk table (no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
test.todo("name_field requires code_field (CLI arguments, no TS counterpart)");
