import { beforeAll, expect, test } from "vitest";
import { runPackageLines } from "$lib/tools/package-lines/pipeline";
import { nodedLines, snapEnds } from "$lib/tools/package-lines/pipeline/boundaries";
import { genericNamesByFamily } from "$lib/tools/schema-map/pipeline/identityNames";
import mmrSeamUrl from "./fixtures/mmr_seam.parquet?url";
import { layer, loadFixture, ready, rows, run } from "./helpers";

// Ports topo-tools' tests/test_package_lines.py.

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
const A = "POLYGON((0 0,0 10,10 10,10 0,0 0))";
const B = "POLYGON((10 0,10 10,20 10,20 0,10 0))";
const C = "POLYGON((20 0,20 10,30 10,30 0,20 0))";

type Line = { a: string; b: string | null; lvl: number; wkt: string };
type Row = Record<string, string | number | null>;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const literal = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`;

// One row per object; the wkt key becomes geom.
async function synthetic(units: Row[]): Promise<void> {
  const cols = Object.keys(units[0]).filter((k) => k !== "wkt");
  const body = units.map((u) => `(${[...cols, "wkt"].map((c) => literal(u[c])).join(", ")})`);
  const typed = cols.map((c) => `"${c}"`).join(", ");
  await layer(`SELECT ${typed}${cols.length ? ", " : ""}ST_GeomFromText(wkt) AS geom
    FROM (VALUES ${body.join(", ")}) AS v(${[...typed.split(", ").filter(Boolean), "wkt"].join(", ")})`);
}

const output = () =>
  rows<Row>(`SELECT * EXCLUDE (fid), ST_AsText(geom) AS wkt
    FROM pl_attr JOIN pl_geom USING (fid)`);

async function lines(
  units: [string, string][],
  depthColumn?: string,
  minLevel: number | null = null,
): Promise<Line[]> {
  await synthetic(units.map(([adm1_pcode, wkt]) => ({ adm1_pcode, wkt })));
  await runPackageLines(conn, SCHEMA, depthColumn, minLevel);
  return rows<Line>(`SELECT a_pcode AS a, b_pcode AS b, adm_lvl::INT AS lvl,
    ST_AsText(geom) AS wkt FROM pl_geom JOIN pl_attr USING (fid)`);
}

const shared = (found: Line[]) => found.filter((r) => r.b !== null);

test("two adjacent squares give one shared row", async () => {
  const found = shared(
    await lines([
      ["A", A],
      ["B", B],
    ]),
  );
  expect(found).toHaveLength(1);
  expect(new Set([found[0].a, found[0].b])).toEqual(new Set(["A", "B"]));
});

test("an explicit schema carries the finest level's siblings and no metadata", async () => {
  await synthetic(
    [
      ["A", A],
      ["B", B],
    ].map(([code, wkt]) => ({
      adm0_id: "Z",
      adm0_name: "Zed",
      adm1_id: code,
      adm1_name: `n${code}`,
      adm1_name1: `m${code}`,
      adm1_pcode: `x${code}`,
      valid_on: "2020-01-01",
      wkt,
    })),
  );
  await runPackageLines(conn, { nameField: "adm{n}_name", codeField: "adm{n}_id" });
  const columns = (await rows<{ column_name: string }>("DESCRIBE pl_attr")).map(
    (r) => r.column_name,
  );
  expect(new Set(columns)).toEqual(
    new Set([
      "fid",
      ...["a", "b"].flatMap((s) => ["id", "name", "name1", "pcode"].map((g) => `${s}_${g}`)),
      "adm_lvl",
    ]),
  );
  const found = (await output()).filter((r) => r.b_id !== null);
  expect(found.map((r) => [r.a_id, r.b_id].sort())).toEqual([["A", "B"]]);
  const sides = Object.fromEntries(
    found.flatMap((r) => [
      [r.a_id, [r.a_name, r.a_name1, r.a_pcode]],
      [r.b_id, [r.b_name, r.b_name1, r.b_pcode]],
    ]),
  );
  expect(sides).toEqual({ A: ["nA", "mA", "xA"], B: ["nB", "mB", "xB"] });
});

test("a depth column colliding with an output column raises", async () => {
  await expect(
    lines(
      [
        ["A", A],
        ["B", B],
      ],
      "geom",
    ),
  ).rejects.toThrow(/geom/);
});

test("exterior rows have a null right code", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
  ]);
  expect(found.some((r) => r.b === null)).toBe(true);
});

test("the middle of three squares has two exterior lines", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
    ["C", C],
  ]);
  const middle = found.filter((r) => r.b === null && r.a === "B");
  expect(middle).toHaveLength(2);
  expect(middle.every((r) => r.wkt.startsWith("LINESTRING"))).toBe(true);
});

test("a corner touch gives no shared rows", async () => {
  const found = await lines([
    ["A", A],
    ["B", "POLYGON((10 10,10 20,20 20,20 10,10 10))"],
  ]);
  expect(shared(found)).toEqual([]);
});

test("a sliver-overlap T-junction is one shared edge", async () => {
  const [west, east] = ["21.1848499 44.7758881", "21.237854 44.7895683"];
  await lines([
    ["A", `POLYGON((${west},${east},21.237854 44.75,21.1848499 44.75,${west}))`],
    [
      "B",
      `POLYGON((${west},21.1848499 44.8,21.237854 44.8,${east},21.2200349875 44.78496926606107,${west}))`,
    ],
  ]);
  const found = await rows<{ ext: boolean; n: number; len: number }>(`
    SELECT b_pcode IS NULL AS ext, count(*) AS n, sum(ST_Length(geom)) AS len
    FROM pl_attr JOIN pl_geom USING (fid) GROUP BY 1 ORDER BY 1`);
  const [{ edge }] = await rows<{ edge: number }>(
    `SELECT ST_Length(ST_GeomFromText('LINESTRING(${west},${east})')) AS edge`,
  );
  expect(found.map((r) => [r.ext, r.n])).toEqual([
    [false, 1],
    [true, 2],
  ]);
  expect(found[0].len).toBeCloseTo(edge, 9);
});

test("a crossing sliver at a near-miss junction is one shared row", async () => {
  await lines([
    ["A", "POLYGON((0.1 0.1,0.5 0.1,0.5 0.5,0.1 0.5,0.1 0.1))"],
    ["B", "POLYGON((0.5 0.1,0.9 0.1,0.9 0.5,0.5000000005 0.5,0.4999999995 0.3,0.5 0.1))"],
    ["C", "POLYGON((0.1 0.5,0.9 0.5,0.9 0.9,0.1 0.9,0.1 0.5))"],
  ]);
  const found = await rows<{ closed: boolean; len: number }>(`
    SELECT ST_IsClosed(geom) AS closed, ST_Length(geom) AS len
    FROM pl_attr JOIN pl_geom USING (fid) WHERE a_pcode = 'A' AND b_pcode = 'B'`);
  expect(found).toHaveLength(1);
  expect(found[0].closed).toBe(false);
  expect(Math.abs(found[0].len - 0.4)).toBeLessThan(1e-8);
});

const TILE_CASES: Record<string, [[string, string][], Record<string, number>]> = {
  border_on_tile_line: [
    [
      ["A", "POLYGON((0.2 0.5,0.2 1,0.5 1,0.8 1,0.8 0.5,0.2 0.5))"],
      ["B", "POLYGON((0.2 1,0.2 1.5,0.8 1.5,0.8 1,0.6 1,0.3 1,0.2 1))"],
    ],
    { "A|B": 0.6 },
  ],
  vertex_in_tile_margin: [
    [
      ["A", "POLYGON((0.5 0.5,0.5 1.000005,0.5 1.5,0 1.5,0 0.5,0.5 0.5))"],
      ["B", "POLYGON((0.5 0.5,1.5 0.5,1.5 1.5,0.5 1.5,0.5 1.000005,0.5 0.5))"],
    ],
    { "A|B": 1.0 },
  ],
  four_units_at_tile_corner: [
    [
      ["A", "POLYGON((0.5 0.5,1 0.5,1 1,0.5 1,0.5 0.5))"],
      ["B", "POLYGON((1 0.5,1.5 0.5,1.5 1,1 1,1 0.5))"],
      ["C", "POLYGON((0.5 1,1 1,1 1.5,0.5 1.5,0.5 1))"],
      ["D", "POLYGON((1 1,1.5 1,1.5 1.5,1 1.5,1 1))"],
    ],
    { "A|B": 0.5, "A|C": 0.5, "B|D": 0.5, "C|D": 0.5 },
  ],
  antimeridian_unit: [
    [
      [
        "A",
        "MULTIPOLYGON(((179.5 0,180 0,180 1,179.5 1,179.5 0)),((-180 0,-179.5 0,-179.5 1,-180 1,-180 0)))",
      ],
      ["B", "POLYGON((179 0,179.5 0,179.5 1,179 1,179 0))"],
    ],
    { "A|B": 1.0 },
  ],
  enclosed_unit: [
    [
      ["A", "POLYGON((0 0,3 0,3 3,0 3,0 0),(1 1,1 2,2 2,2 1,1 1))"],
      ["B", "POLYGON((1 1,2 1,2 2,1 2,1 1))"],
    ],
    { "A|B": 4.0 },
  ],
  diagonal_across_tile_lines: [
    [
      ["A", "POLYGON((0.3 0.31,1.7 1.73,1.7 0.31,0.3 0.31))"],
      ["B", "POLYGON((0.3 0.31,0.3 1.73,1.7 1.73,0.3 0.31))"],
    ],
    { "A|B": Math.hypot(1.4, 1.42) },
  ],
  unit_below_tolerance_enclosed: [
    [
      [
        "A",
        "POLYGON((0 0,1e-6 0,1e-6 1e-6,0 1e-6,0 0),(4e-7 4e-7,4e-7 4.2e-7,4.2e-7 4.2e-7,4.2e-7 4e-7,4e-7 4e-7))",
      ],
      ["B", "POLYGON((4e-7 4e-7,4.2e-7 4e-7,4.2e-7 4.2e-7,4e-7 4.2e-7,4e-7 4e-7))"],
    ],
    { "A|B": 8e-8 },
  ],
};

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.abs(b) + 1e-12;

test.each(Object.keys(TILE_CASES).sort())(
  "the tiled network has one row per shared border: %s",
  async (name) => {
    const [polygons, expected] = TILE_CASES[name];
    await lines(polygons);
    const found = await rows<{ pair: string; n: number; len: number }>(`
      SELECT least(a_pcode, b_pcode) || '|' || greatest(a_pcode, b_pcode) AS pair,
             count(*) AS n, sum(ST_Length(geom)) AS len
      FROM pl_attr JOIN pl_geom USING (fid) WHERE b_pcode IS NOT NULL GROUP BY 1`);
    expect(Object.fromEntries(found.map((r) => [r.pair, r.n]))).toEqual(
      Object.fromEntries(Object.keys(expected).map((k) => [k, 1])),
    );
    for (const r of found) expect(close(r.len, expected[r.pair])).toBe(true);
    const [{ total, unioned }] = await rows<{ total: number; unioned: number }>(`
      SELECT sum(ST_Length(geom)) AS total, ST_Length(ST_Union_Agg(geom)) AS unioned FROM pl_geom`);
    expect(close(total, unioned)).toBe(true);
  },
);

async function snapped(wkts: string[]): Promise<string[]> {
  await run(`CREATE OR REPLACE TABLE t AS SELECT k, ST_GeomFromText(w) AS geom
    FROM (VALUES ${wkts.map((w, k) => `(${k}, '${w}')`).join(", ")}) v(k, w)`);
  await snapEnds(conn, "t", "k", 1e-7);
  return (await rows<{ w: string }>("SELECT ST_AsText(geom) AS w FROM t ORDER BY k")).map(
    (r) => r.w,
  );
}

test("snapEnds moves each end of a short line to its own target", async () => {
  const out = await snapped([
    "LINESTRING (10.5 0, 10.50000005 0)",
    "LINESTRING (10.49999995 -0.00000003, 10.4 -0.1)",
    "LINESTRING (10.49999997 0.00000003, 10.4 0.1)",
  ]);
  expect(out[0]).toBe("LINESTRING (10.49999995 -3e-08, 10.49999997 3e-08)");
});

test("snapEnds uses a Euclidean tolerance", async () => {
  const out = await snapped(["LINESTRING (0 0, -1 0)", "LINESTRING (9e-08 9e-08, 1 1)"]);
  expect(out[1]).toBe("LINESTRING (9e-08 9e-08, 1 1)");
});

test("noded lines ignore input row order", async () => {
  await loadFixture(mmrSeamUrl, "mmr_seam.parquet");
  await run(`CREATE OR REPLACE TABLE base AS
    SELECT row_number() OVER (ORDER BY a.adm1_pcode) AS fid, g.geom
    FROM layer_01 g JOIN layer_attr a USING (fid)`);
  const outputs = new Set<string>();
  for (let seed = 0; seed < 6; seed++) {
    await run(`SELECT setseed(0.${seed + 1})`);
    await run("CREATE OR REPLACE TABLE d AS SELECT * FROM base ORDER BY random()");
    await nodedLines(conn, "x", "d");
    const out = await rows(
      "SELECT left_fid, right_fid, ST_AsHEXWKB(geom) AS g FROM x_lines ORDER BY ALL",
    );
    outputs.add(JSON.stringify(out));
  }
  expect(outputs.size).toBe(1);
}, 120_000);

async function nodedWkb(maxVertices: number): Promise<string> {
  await nodedLines(conn, "x", "d", maxVertices);
  const out = await rows(
    "SELECT left_fid, right_fid, ST_AsHEXWKB(geom) AS g FROM x_lines ORDER BY ALL",
  );
  return JSON.stringify(out);
}

test("noded lines are the same when long boundaries are split", async () => {
  const border = Array.from({ length: 2001 }, (_, i) => [3 + 0.01 * Math.sin(i), (i * 3) / 2000]);
  const shared = border.map(([x, y]) => `${x} ${y}`).join(", ");
  const back = [...border]
    .reverse()
    .map(([x, y]) => `${x} ${y}`)
    .join(", ");
  await run(`CREATE OR REPLACE TABLE synthetic AS SELECT * FROM (VALUES
    (1, ST_GeomFromText('POLYGON((0 0, ${shared}, 0 3, 0 0))')),
    (2, ST_GeomFromText('POLYGON((${back}, 6 0, 6 3, ${border[2000][0]} 3))'))
  ) t(fid, geom)`);
  await loadFixture(mmrSeamUrl, "mmr_seam.parquet");
  await run(`CREATE OR REPLACE TABLE mmr AS
    SELECT row_number() OVER (ORDER BY a.adm1_pcode) AS fid, g.geom
    FROM layer_01 g JOIN layer_attr a USING (fid)`);
  for (const table of ["synthetic", "mmr"]) {
    await run(`CREATE OR REPLACE TABLE d AS SELECT * FROM ${table}`);
    expect(await nodedWkb(50)).toBe(await nodedWkb(1e9));
  }
  await run("CREATE OR REPLACE TABLE d AS SELECT * FROM synthetic");
  await nodedLines(conn, "x", "d", 50);
  const pairs = await rows(
    "SELECT left_fid, right_fid FROM x_lines WHERE right_fid IS NOT NULL ORDER BY ALL",
  );
  expect(pairs.map((r) => [Number(r.left_fid), Number(r.right_fid)])).toEqual([[1, 2]]);
}, 120_000);

test("a multi-part unit touching a neighbor and with a remote island", async () => {
  const found = await lines([
    ["A", "MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0)),((100 70,100 80,110 80,110 70,100 70)))"],
    ["B", B],
  ]);
  expect(shared(found)).toHaveLength(1);
  expect(found.some((r) => r.b === null && r.wkt.includes("100 70"))).toBe(true);
});

test("every input code appears at least once", async () => {
  const found = await lines([
    ["A", A],
    ["B", B],
    ["C", C],
  ]);
  const present = new Set([...found.map((r) => r.a), ...found.flatMap((r) => r.b ?? [])]);
  expect(present).toEqual(new Set(["A", "B", "C"]));
});

test("multi-level classification labels each row at its own level", async () => {
  await synthetic([
    { adm1_pcode: "P1", adm2_pcode: "X1", wkt: A },
    { adm1_pcode: "P1", adm2_pcode: "X2", wkt: B },
    { adm1_pcode: "P2", adm2_pcode: "Y1", wkt: C },
    { adm1_pcode: "P2", adm2_pcode: "Y2", wkt: "POLYGON((30 0,30 10,40 10,40 0,30 0))" },
  ]);
  await runPackageLines(conn, SCHEMA);
  const found = await rows<{ x: number; lvl: number; a: string; b: string }>(`
    SELECT ST_X(ST_PointN(geom, 1)) AS x, adm_lvl::INT AS lvl, a_pcode AS a, b_pcode AS b
    FROM pl_geom JOIN pl_attr USING (fid)
    WHERE b_pcode IS NOT NULL AND ST_X(ST_PointN(geom, 1)) = ST_X(ST_PointN(geom, 2))`);
  const byX = Object.fromEntries(found.map((r) => [r.x, r]));
  expect(byX[10].lvl).toBe(2);
  expect(new Set([byX[10].a, byX[10].b])).toEqual(new Set(["X1", "X2"]));
  expect(byX[30].lvl).toBe(2);
  expect(byX[20].lvl).toBe(1);
  expect(new Set([byX[20].a, byX[20].b])).toEqual(new Set(["P1", "P2"]));
  const exterior = await rows(`SELECT DISTINCT adm_lvl::INT AS lvl, a_pcode AS a
    FROM pl_attr WHERE b_pcode IS NULL ORDER BY a`);
  expect(exterior).toEqual([
    { lvl: 0, a: "P1" },
    { lvl: 0, a: "P2" },
  ]);
});

test("a single auto-detected level writes generic code and name", async () => {
  await synthetic([
    { adm2_pcode: "SN0101", adm2_name: "Dakar", wkt: A },
    { adm2_pcode: "SN0102", adm2_name: "Pikine", wkt: B },
  ]);
  await runPackageLines(conn, null);
  const columns = (await rows<{ column_name: string }>("DESCRIBE pl_attr")).map(
    (r) => r.column_name,
  );
  expect(columns).toEqual(["fid", "a_code", "a_name", "b_code", "b_name", "adm_lvl"]);
  const found = (await output()).filter((r) => r.b_code !== null);
  expect(found).toHaveLength(1);
  expect(
    new Set([`${found[0].a_code}|${found[0].a_name}`, `${found[0].b_code}|${found[0].b_name}`]),
  ).toEqual(new Set(["SN0101|Dakar", "SN0102|Pikine"]));
});

test("a min level above every level raises", async () => {
  await expect(lines([["A", A]], undefined, 9)).rejects.toThrow(
    "no admin level at or above min level 9",
  );
});

test("a min level drops shallower rows", async () => {
  await synthetic([
    { adm1_pcode: "P1", adm2_pcode: "X1", wkt: A },
    { adm1_pcode: "P1", adm2_pcode: "X2", wkt: B },
    { adm1_pcode: "P2", adm2_pcode: "Y1", wkt: C },
  ]);
  await runPackageLines(conn, SCHEMA, undefined, 2);
  expect(await rows("SELECT DISTINCT adm_lvl::INT AS lvl FROM pl_attr")).toEqual([{ lvl: 2 }]);
});

test("a generic name clash raises", () => {
  const families = new Map([
    ["_name", new Map([[1, "adm1_name"]])],
    ["name", new Map([[1, "name_adm1"]])],
  ]);
  expect(() => genericNamesByFamily(families, [1], ["adm1_pcode"])).toThrow(
    "reduces to unusable name 'name'",
  );
});

test("a generic name clash is case-insensitive", () => {
  const families = new Map([
    ["_pcode", new Map([[1, "adm1_pcode"]])],
    ["_PCODE", new Map([[1, "adm1_PCODE"]])],
  ]);
  expect(() => genericNamesByFamily(families, [1], ["adm1_pcode"])).toThrow(
    "reduces to unusable name 'PCODE'",
  );
});

// Two adm1 units with two adm2 units each, per country, in a row.
function countryRows(countries: string[]): Row[] {
  return countries.flatMap((country, c) =>
    [0, 1].flatMap((p) =>
      [0, 1].map((j) => {
        const x = 40 * c + 20 * p + 10 * j;
        return {
          adm0_pcode: country,
          adm0_name: `n${country}`,
          adm1_pcode: `${country}${p}`,
          adm1_name: `n${country}${p}`,
          adm2_pcode: `${country}${p}${j}`,
          adm2_name: `n${country}${p}${j}`,
          wkt: `POLYGON((${x} 0,${x} 10,${x + 10} 10,${x + 10} 0,${x} 0))`,
        };
      }),
    ),
  );
}

test.each([true, false])(
  "a single country's outline is depth 0, labelled adm0 (explicit %s)",
  async (explicit) => {
    await synthetic(countryRows(["SEN"]));
    await runPackageLines(conn, explicit ? SCHEMA : null);
    const outer = await rows(`SELECT DISTINCT adm_lvl::INT AS lvl, COLUMNS('^a_')
      FROM pl_attr WHERE COLUMNS('^b_.*code$') IS NULL`);
    expect(outer.map((r) => Object.values(r))).toEqual([[0, "SEN", "nSEN"]]);
  },
);

test("a bare constant root outline is labelled as code", async () => {
  await synthetic(
    countryRows(["SEN"]).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_pcode$/, ""), v])),
    ),
  );
  await runPackageLines(conn, null);
  expect(
    await rows(`SELECT DISTINCT adm_lvl::INT AS lvl, a_code, a_name FROM pl_attr
      WHERE b_code IS NULL`),
  ).toEqual([{ lvl: 0, a_code: "SEN", a_name: "nSEN" }]);
});

test("a root code blank on some rows keeps the shared depth", async () => {
  const units = countryRows(["SEN"]);
  units[0] = { ...units[0], adm0_pcode: null, adm0_name: null };
  await synthetic(units);
  await runPackageLines(conn, null);
  expect(
    await rows(`SELECT LEAST(a_pcode, b_pcode) AS a, GREATEST(a_pcode, b_pcode) AS b,
      adm_lvl::INT AS lvl FROM pl_attr WHERE b_pcode IS NOT NULL ORDER BY ALL`),
  ).toEqual([
    { a: "SEN0", b: "SEN1", lvl: 1 },
    { a: "SEN00", b: "SEN01", lvl: 2 },
    { a: "SEN10", b: "SEN11", lvl: 2 },
  ]);
});

test("several countries put outer edges at depth -1", async () => {
  await synthetic(countryRows(["SEN", "GMB"]));
  await runPackageLines(conn, SCHEMA);
  expect(
    await rows(`SELECT DISTINCT adm_lvl::INT AS lvl, b_pcode IS NULL AS ext
      FROM pl_attr ORDER BY ALL`),
  ).toEqual([
    { lvl: -1, ext: true },
    { lvl: 0, ext: false },
    { lvl: 1, ext: false },
    { lvl: 2, ext: false },
  ]);
});
