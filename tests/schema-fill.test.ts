import { beforeAll, expect, test } from "vitest";
import { runPackagePolygons } from "$lib/tools/package-polygons/pipeline";
import { runSchemaFill, type TargetSchema } from "$lib/tools/schema-fill/pipeline";
import { exportColumns, layer, ready, rows } from "./helpers";

type Row = Record<string, string | number | null>;
const LEAF_ROWS: Row[] = [
  {
    adm1_code: "AA",
    adm1_name: "Country A",
    adm2_code: "AA01",
    adm2_name: "Prov1",
    adm3_code: "AA0101",
    adm3_name: "Dist1",
    wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
  },
  {
    adm1_code: "AA",
    adm1_name: "Country A",
    adm2_code: "AA01",
    adm2_name: "Prov1",
    adm3_code: "AA0102",
    adm3_name: "Dist2",
    wkt: "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))",
  },
  {
    adm1_code: "AA",
    adm1_name: "Country A",
    adm2_code: "AA02",
    adm2_name: "Prov2",
    adm3_code: null,
    adm3_name: null,
    wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))",
  },
  {
    adm1_code: "BB",
    adm1_name: "Country B",
    adm2_code: null,
    adm2_name: null,
    adm3_code: null,
    adm3_name: null,
    wkt: "POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))",
  },
];
const ADM_CODE = { nameField: "adm{n}_name", codeField: "adm{n}_code" };

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

async function fill(rs: Row[], schema: TargetSchema | null = null, depthColumn?: string) {
  await layer(synthetic(rs));
  await runSchemaFill(conn, schema, depthColumn);
  const columns = (await exportColumns("schema_fill")).filter((c) => c !== "geometry");
  return { columns, out: await rows<Row>("SELECT * EXCLUDE (geometry) FROM '_export.parquet'") };
}

const find = (out: Row[], a: string, b: string | null, c: string | null) =>
  out.find((r) => r.adm1_code === a && r.adm2_code === b && r.adm3_code === c)!;

test("fills down and stamps depth", async () => {
  const { columns, out } = await fill(LEAF_ROWS);
  expect(columns).toContain("adm_lvl");
  expect(find(out, "AA", "AA01", "AA0101").adm_lvl).toBe(3);
  expect(find(out, "AA", "AA02", "AA02")).toMatchObject({ adm_lvl: 2, adm3_name: "Prov2" });
  expect(find(out, "BB", "BB", "BB")).toMatchObject({ adm_lvl: 1, adm3_name: "Country B" });
});

test("keeps input column order", async () => {
  const order = ["adm3_name", "adm3_code", "adm2_name", "adm2_code", "adm1_name"];
  const reordered = LEAF_ROWS.map((r) =>
    Object.fromEntries([...order, "adm1_code", "wkt"].map((c) => [c, r[c]])),
  );
  expect((await fill(reordered)).columns).toEqual([...order, "adm1_code", "adm_lvl"]);
});

test("extends to a single level", async () => {
  const { out } = await fill([
    { adm1_code: "AA", adm1_name: "Country A", wkt: LEAF_ROWS[0].wkt },
    { adm1_code: "BB", adm1_name: "Country B", wkt: LEAF_ROWS[3].wkt },
  ]);
  expect(out.map((r) => [r.adm1_code, r.adm_lvl]).sort()).toEqual([
    ["AA", 1],
    ["BB", 1],
  ]);
});

test("missing level column raises", async () => {
  const renamed: Record<string, string> = { Prov1: "Providence", Prov2: "Piedmont" };
  const rs = LEAF_ROWS.map(({ adm2_code: _, ...r }) => ({
    ...r,
    adm2_name: r.adm2_name === null ? null : (renamed[r.adm2_name as string] ?? r.adm2_name),
  }));
  await expect(fill(rs)).rejects.toThrow(/missing code column/);
});

test("custom target schema", async () => {
  const { columns } = await fill(
    [
      {
        level1_id: "X1",
        level1_name: "Region1",
        level2_id: "X101",
        level2_name: "District1",
        wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
      },
    ],
    { nameField: "level{n}_name", codeField: "level{n}_id" },
  );
  expect(columns).toContain("adm_lvl");
});

test("mismatched name and code prefixes both fill", async () => {
  const { out } = await fill(
    [
      {
        GID_1: "X1",
        NAME_1: "Region1",
        GID_2: "X101",
        NAME_2: "District1",
        wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
      },
      {
        GID_1: "X1",
        NAME_1: "Region1",
        GID_2: "X102",
        NAME_2: null,
        wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))",
      },
    ],
    { nameField: "NAME_{n}", codeField: "GID_{n}" },
  );
  const sorted = [...out].sort((a, b) => String(a.GID_2).localeCompare(String(b.GID_2)));
  expect(sorted.map((r) => [r.NAME_2, r.adm_lvl])).toEqual([
    ["District1", 2],
    [null, 2],
  ]);
});

test("custom depth column name", async () => {
  const { columns } = await fill(LEAF_ROWS, null, "my_depth");
  expect(columns).toContain("my_depth");
  expect(columns).not.toContain("adm_lvl");
});

test("fills a fieldmaps-shaped column family set", async () => {
  const unit = (id: string | null, name: string | null) => ({
    adm1_id: "AA",
    adm1_src: "src-AA",
    adm1_name: "Country A",
    adm1_name1: "Country A (fr)",
    adm1_name2: "Country A (es)",
    adm2_id: id,
    adm2_src: id && `src-${id}`,
    adm2_name: name,
    adm2_name1: name && `${name} (fr)`,
    adm2_name2: name && `${name} (es)`,
  });
  const { out } = await fill(
    [
      { ...unit("AA01", "Prov1"), wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))" },
      { ...unit(null, null), wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))" },
    ],
    { nameField: "adm{n}_name", codeField: "adm{n}_id" },
  );
  const sorted = [...out].sort((a, b) => String(a.adm2_id).localeCompare(String(b.adm2_id)));
  expect(
    sorted.map((r) => [r.adm2_src, r.adm2_name, r.adm2_name1, r.adm2_name2, r.adm_lvl]),
  ).toEqual([
    ["src-AA", "Country A", "Country A (fr)", "Country A (es)", 1],
    ["src-AA01", "Prov1", "Prov1 (fr)", "Prov1 (es)", 2],
  ]);
});

test("dissolve after fill keeps the depth column", async () => {
  await fill(LEAF_ROWS);
  await layer("SELECT * EXCLUDE (geometry), geometry AS geom FROM '_export.parquet'");
  await runPackagePolygons(conn, ADM_CODE);
  await exportColumns("package_polygons_level_2");
  expect(
    await rows("SELECT adm2_code, adm_lvl FROM '_export.parquet' ORDER BY adm2_code"),
  ).toEqual([
    { adm2_code: "AA01", adm_lvl: 3 },
    { adm2_code: "AA02", adm_lvl: 2 },
    { adm2_code: "BB", adm_lvl: 1 },
  ]);
});

test("falls back to level zero when present", async () => {
  const { out } = await fill([
    {
      adm0_code: "AA",
      adm0_name: "Country A",
      adm1_code: "AA01",
      adm1_name: "Prov1",
      wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
    },
    {
      adm0_code: "AA",
      adm0_name: "Country A",
      adm1_code: "AA02",
      adm1_name: "Prov2",
      wkt: "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))",
    },
    {
      adm0_code: "BB",
      adm0_name: "Country B",
      adm1_code: null,
      adm1_name: null,
      wkt: "POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))",
    },
  ]);
  expect(out.map((r) => [r.adm0_code, r.adm1_code, r.adm1_name, r.adm_lvl]).sort()).toEqual([
    ["AA", "AA01", "Prov1", 1],
    ["AA", "AA02", "Prov2", 1],
    ["BB", "BB", "Country B", 0],
  ]);
});

test("pins to each row's own real depth by default", async () => {
  const { out } = await fill([
    {
      adm1_code: "DZ",
      adm1_name: "Algeria",
      adm2_code: "DZ01",
      adm2_name: null,
      adm3_code: null,
      adm3_name: null,
      wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
    },
    {
      adm1_code: "DZ",
      adm1_name: "Algeria",
      adm2_code: "DZ02",
      adm2_name: "Oran",
      adm3_code: "DZ0201",
      adm3_name: "Es Senia",
      wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))",
    },
  ]);
  expect(out.find((r) => r.adm2_code === "DZ01")).toMatchObject({
    adm2_name: null,
    adm3_code: "DZ01",
    adm3_name: null,
    adm_lvl: 2,
  });
});

test("per-row depth scoping", async () => {
  const rs: Row[] = [
    {
      adm1_code: "AA",
      adm1_name: "Country A",
      adm2_code: null,
      adm2_name: null,
      adm3_code: null,
      adm3_name: null,
      wkt: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
    },
    {
      adm1_code: "BB",
      adm1_name: "Country B",
      adm2_code: "BB01",
      adm2_name: null,
      adm3_code: null,
      adm3_name: null,
      wkt: "POLYGON((0 1, 1 1, 1 2, 0 2, 0 1))",
    },
  ];
  for (let p = 1; p <= 10; p++) {
    for (let d = 1; d <= 2; d++) {
      const pp = String(p).padStart(2, "0");
      rs.push({
        adm1_code: "CC",
        adm1_name: "Country C",
        adm2_code: `CC${pp}`,
        adm2_name: `Prov${p}`,
        adm3_code: `CC${pp}0${d}`,
        adm3_name: `Dist${p}_${d}`,
        wkt: `POLYGON((${p} ${d + 4}, ${p + 1} ${d + 4}, ${p + 1} ${d + 5}, ${p} ${d + 5}, ${p} ${d + 4}))`,
      });
    }
  }
  const { out } = await fill(rs);
  const sorted = [...out].sort(
    (a, b) =>
      String(a.adm1_code).localeCompare(String(b.adm1_code)) ||
      String(a.adm3_code).localeCompare(String(b.adm3_code)),
  );
  expect(sorted.slice(0, 3).map((r) => [r.adm1_code, r.adm2_name, r.adm3_name, r.adm_lvl])).toEqual(
    [
      ["AA", "Country A", "Country A", 1],
      ["BB", null, null, 2],
      ["CC", "Prov1", "Dist1_1", 3],
    ],
  );
});

test("depth column collision raises", async () => {
  await expect(fill(LEAF_ROWS.map((r) => ({ ...r, adm_lvl: 1 })))).rejects.toThrow(
    /adm_lvl.*already exists/,
  );
});

test.todo("default output path (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
