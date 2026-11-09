import { beforeAll, describe, expect, test } from "vitest";
import { listFormats, runExport, type ExportFormat } from "$lib/db/export";
import { loadFile } from "$lib/db/loader";
import tinyUrl from "./fixtures/clean/tiny.geojson?url";
import { db, ready } from "./helpers";

const FEATURES = 6;

// Loads an exported file back through the app's loader: row count, names and non-empty geometries.
async function readBack(blob: Blob, filename: string) {
  const { db: instance, conn } = db();
  await loadFile(instance, conn, [new File([blob], filename)], { prefix: "rb_" });
  const row = (
    await conn.query(
      `SELECT count(*)::INT AS n, list_sort(list(a.name))::VARCHAR AS names,
         count(*) FILTER (WHERE NOT ST_IsEmpty(g.geom))::INT AS geoms
       FROM rb_layer_01 g JOIN rb_layer_attr a USING (fid)`,
    )
  ).toArray()[0];
  return { n: row.n as number, names: row.names as string, geoms: row.geoms as number };
}

describe("export formats", () => {
  let formats: ExportFormat[] = [];

  beforeAll(async () => {
    await ready();
    const { db: instance, conn } = db();
    const blob = await (await fetch(tinyUrl)).blob();
    await loadFile(instance, conn, [new File([blob], "tiny.geojson")]);
    await conn.query("CREATE OR REPLACE TABLE tc_clean AS SELECT * FROM layer_01");
    formats = await listFormats("clean_topology");
  }, 60_000);

  test("lists the spatial formats", () => {
    expect(formats.map((f) => f.id)).toEqual(
      expect.arrayContaining(["parquet", "gdal:GPKG", "gdal:FlatGeobuf"]),
    );
    expect(formats.map((f) => f.id)).not.toContain("gdal:ESRI Shapefile");
  });

  test.each(["parquet", "gdal:GPKG", "gdal:FlatGeobuf", "gdal:KML", "gdal:GML"])(
    "%s round-trips every feature",
    async (id) => {
      const format = formats.find((f) => f.id === id);
      expect(format, `${id} is listed`).toBeDefined();
      const { blob, filename } = await runExport("clean_topology", format!, "tiny");
      const back = await readBack(blob, filename);
      expect(back.n).toBe(FEATURES);
      expect(back.geoms).toBe(FEATURES);
      expect(back.names).toContain("Region A");
    },
  );

  // Canary: passes while duckdb-wasm writes corrupt shapefiles, fails once a build fixes it.
  test.fails(
    "duckdb-wasm writes a valid shapefile: unhide Shapefile export in export.ts",
    async () => {
      const shapefile: ExportFormat = {
        id: "gdal:ESRI Shapefile",
        label: "Shapefile (.shp.zip)",
        ext: ".shp.zip",
        mime: "application/zip",
        kind: "gdal",
        driver: "ESRI Shapefile",
        rank: 30,
      };
      const { blob, filename } = await runExport("clean_topology", shapefile, "tiny");
      const back = await readBack(blob, filename);
      expect(back.n).toBe(FEATURES);
      expect(back.geoms).toBe(FEATURES);
      expect(back.names).toContain("Region A");
    },
  );

  // Canary: passes while the WASM spatial build lacks OpenFileGDB, fails once a build adds it.
  test.fails("duckdb-wasm has the OpenFileGDB driver: add FileGDB support", async () => {
    const { conn } = db();
    const rows = (
      await conn.query("SELECT short_name FROM ST_Drivers() WHERE short_name = 'OpenFileGDB'")
    ).toArray();
    expect(rows).toHaveLength(1);
  });
});
