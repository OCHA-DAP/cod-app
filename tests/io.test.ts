import { beforeAll, expect, test } from "vitest";
import { loadFile } from "$lib/db/loader";
import { db, exportColumns, loadFixture, ready, rows, run, scalar, write } from "./helpers";
import emptyUrl from "./fixtures/io/empty.gpkg?url";
import sliverUrl from "./fixtures/io/sliver.gpkg?url";

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const load = async (file: File) => loadFile(db().db, conn, [file]);
const wkt = (ws: string[]) =>
  `SELECT * FROM (VALUES ${ws.map((w, i) => `(${i}, ST_GeomFromText('${w}'))`).join(", ")}) t(id, geom)`;

test("a file without geometry raises a clear error", async () => {
  await expect(load(await write("SELECT 1 AS x", "no_geom.parquet"))).rejects.toThrow(
    /no geometry column found/i,
  );
});

// drift: py raises a clear "invalid geometry" error; the site rejects with a raw GEOS exception
test.fails("invalid geometry raises a clear error", async () => {
  const file = await write(
    "SELECT ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1))') AS geom",
    "unclosed_ring.parquet",
  );
  await expect(load(file)).rejects.toThrow(/invalid geometry/);
});

// sliver.gpkg: a near-degenerate EPSG:32721 triangle that reprojection makes invalid.
// drift: py #94 repairs geometry again after reprojecting
test.fails("geometry broken by reprojection is repaired", async () => {
  await loadFixture(sliverUrl, "sliver.gpkg");
  expect(await scalar("SELECT bool_and(ST_IsValid(geom)) FROM layer_01")).toBe(true);
});

// drift: py refuses an empty layer clearly; the site fails inside GDAL ("thread constructor failed")
test.fails("zero rows raises", async () => {
  await expect(loadFixture(emptyUrl, "empty.gpkg")).rejects.toThrow(/read 0 features/);
});

test("an exported table leads with geometry and drops fid", async () => {
  await load(await write(`SELECT *, 'a' AS x FROM (${wkt(["POINT(0 0)"])})`, "x.parquet"));
  await run("CREATE OR REPLACE TABLE layer_05 AS SELECT * FROM layer_01");
  expect(await exportColumns("extend")).toEqual(["geometry", "id", "x"]);
});

test.each([
  ["parquet-no-crs", ".parquet", "(FORMAT PARQUET, GEOPARQUET_VERSION 'NONE')"],
  ["geoparquet-crs84", ".parquet", "(FORMAT PARQUET, GEOPARQUET_VERSION 'V1')"],
])("every source is tagged CRS84 on load (%s)", async (_, suffix, opts) => {
  const select = "SELECT 1 AS x, ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))') AS geom";
  await load(await write(select, `src${suffix}`, opts));
  expect(await scalar("SELECT typeof(geom) FROM layer_01")).toBe("GEOMETRY('OGC:CRS84')");
});

// GDAL's GeoJSON writer corrupts the first byte on the WASM filesystem, so this file is hand-written.
test("a GeoJSON source is tagged CRS84 on load", async () => {
  const geometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const text = JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { x: 1 }, geometry }],
  });
  await load(new File([text], "src.geojson"));
  expect(await scalar("SELECT typeof(geom) FROM layer_01")).toBe("GEOMETRY('OGC:CRS84')");
});

test("a projected source is reprojected and tagged CRS84 on load", async () => {
  await loadFixture(sliverUrl, "sliver.gpkg");
  expect(await scalar("SELECT typeof(geom) FROM layer_01")).toBe("GEOMETRY('OGC:CRS84')");
  expect(await scalar<number>("SELECT ST_XMax(geom) FROM layer_01")).toBeLessThan(180);
});

async function exportedParquet(): Promise<string> {
  await load(await write(wkt(["POINT(0 0)"]), "pt.parquet"));
  await run("CREATE OR REPLACE TABLE layer_05 AS SELECT * FROM layer_01");
  await exportColumns("extend");
  return "_export.parquet";
}

test("an exported geometry is tagged CRS84", async () => {
  const path = await exportedParquet();
  expect(
    await scalar(
      `SELECT column_type FROM (DESCRIBE FROM '${path}') WHERE column_name = 'geometry'`,
    ),
  ).toBe("GEOMETRY('OGC:CRS84')");
});

test("exported geo metadata is 2.0.0 with no explicit default CRS", async () => {
  const path = await exportedParquet();
  const geo = JSON.parse(
    await scalar<string>(
      `SELECT decode(value) FROM parquet_kv_metadata('${path}') WHERE decode(key) = 'geo'`,
    ),
  );
  expect(geo.version).toBe("2.0.0");
  expect(geo.columns.geometry).not.toHaveProperty("crs");
});

test("only rows past world bounds are clipped", async () => {
  const inside = "POLYGON((179 0, 179.5 0, 179.5 1, 179 1, 179 0))";
  const past = "POLYGON((179.5 0, 180.0000001 0, 180.0000001 1, 179.5 1, 179.5 0))";
  await load(await write(wkt([inside, past]), "antimeridian.parquet"));
  const found = await rows<{ t: string; x: number }>(
    "SELECT ST_AsText(geom) AS t, ST_XMax(geom) AS x FROM layer_01 JOIN layer_attr USING (fid) ORDER BY id",
  );
  expect(found[0].t).toBe("POLYGON ((179 0, 179.5 0, 179.5 1, 179 1, 179 0))");
  expect(found[1].x).toBe(180);
});

test("a row outside world bounds raises", async () => {
  const file = await write(
    wkt(["POLYGON((181 0, 182 0, 182 1, 181 1, 181 0))"]),
    "outside.parquet",
  );
  await expect(load(file)).rejects.toThrow(/outside/);
});

test.todo("an explicit layer overrides auto-detection (no TS counterpart)");
test.todo("a sole spatial layer is auto-picked among non-spatial ones (no TS counterpart)");
test.todo("several spatial layers raise, listing each (no TS counterpart)");
test.todo("no spatial layer raises (no TS counterpart)");
test.todo("URL and local input path helpers (no TS counterpart)");
test.todo(
  "shapefile export writes a standard WGS84 .prj (Shapefile export hidden, see export.test.ts)",
);
