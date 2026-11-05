import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { unzip } from "fflate";
import { CRS, GEOMETRY_TYPE } from "./constants";
import { randomId } from "./id";
import { SHP_EXTS, SINGLE_EXTS, extOf as ext } from "../utils/formats";

// DuckDB's ST_Read always adds its own FID column literally named "OGC_FID"
// (this is fixed, not configurable via open_options). If the source data
// already has a property with that exact name — common for anything that
// passed through a prior ogr2ogr/GDAL export, since "OGC_FID" is GDAL's own
// default FID field name in many target formats — the resulting relation has
// two same-named columns, and even `SELECT *`/`DESCRIBE` fail to bind at all
// (not just a projection issue). GeoJSON/GeoJSONL are the only formats here
// cheap to fix at the file level (plain JSON, no binary layout to preserve),
// so rename the colliding property before handing the buffer to DuckDB.
function renameCollidingOgcFid(text: string): string {
  const renameProps = (props: Record<string, unknown> | null | undefined): boolean => {
    if (props && Object.prototype.hasOwnProperty.call(props, "OGC_FID")) {
      props.OGC_FID_orig = props.OGC_FID;
      delete props.OGC_FID;
      return true;
    }
    return false;
  };

  if (text.trimStart().startsWith("{")) {
    const geo = JSON.parse(text);
    const features = geo.type === "FeatureCollection" ? geo.features : [geo];
    let renamed = false;
    for (const f of features) renamed = renameProps(f?.properties) || renamed;
    return renamed ? JSON.stringify(geo) : text;
  }

  // GeoJSONL: one Feature per line
  let renamedAny = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    const f = JSON.parse(line);
    if (renameProps(f?.properties)) renamedAny = true;
    return JSON.stringify(f);
  });
  return renamedAny ? lines.join("\n") : text;
}

// Geometry column names a WKB BLOB may carry in a Parquet file without GeoParquet metadata.
const WKB_NAMES = ["geometry", "geom", "wkb_geometry", "the_geom"];

// Normalized geometry expression: fid + MakeValid + Force2D + optional Transform.
// ST_Read tags geometry with source CRS; single-arg ST_Transform infers it.
// read_parquet tags geometry with the GeoParquet CRS; untagged GEOMETRY is taken as WGS84 lon/lat.
// BLOB means WKB from a Parquet file without GeoParquet metadata; parse explicitly.
// MakeValid is applied to the source before Transform so invalid input never reaches the projection.
function loadGeomExpr(geomType: string, quotedCol: string): string {
  if (geomType === "BLOB")
    return `ST_SetCRS(ST_Force2D(ST_MakeValid(ST_GeomFromWKB(${quotedCol}))), '${CRS}')`;
  if (geomType !== "GEOMETRY" && geomType !== GEOMETRY_TYPE)
    return `ST_Force2D(ST_Transform(ST_MakeValid(${quotedCol}), '${CRS}', true))`;
  return `ST_SetCRS(ST_Force2D(ST_MakeValid(${quotedCol})), '${CRS}')`;
}

function isIncluded(file: File): boolean {
  const e = ext(file.name);
  return SINGLE_EXTS.includes(e) || SHP_EXTS.includes(e);
}

async function extractZip(file: File): Promise<File[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (err, result) => (err ? reject(err) : resolve(result)));
  });
  const extracted: File[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.startsWith("__MACOSX/") || bytes.length === 0) continue;
    const name = path.split("/").pop()!;
    const inner = new File([bytes.slice()], name);
    Object.defineProperty(inner, "webkitRelativePath", {
      value: path,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    extracted.push(inner);
  }
  return extracted;
}

async function expandZips(files: File[]): Promise<File[]> {
  const result: File[] = [];
  for (const file of files) {
    if (ext(file.name) === ".zip") {
      result.push(...(await extractZip(file)));
    } else {
      result.push(file);
    }
  }
  return result;
}

function groupByType(files: File[]): {
  parquet?: File;
  spatial?: File;
  shapefile?: File[];
} {
  const filtered = files.filter(isIncluded);
  const shpFiles = filtered.filter((f) => SHP_EXTS.includes(ext(f.name)));
  if (shpFiles.length > 0) return { shapefile: shpFiles };
  const parquet = filtered.find((f) => ext(f.name) === ".parquet");
  if (parquet) return { parquet };
  const spatial = filtered.find(
    (f) => SINGLE_EXTS.includes(ext(f.name)) && ext(f.name) !== ".parquet",
  );
  if (spatial) return { spatial };
  return {};
}

export async function loadFile(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  files: File[],
  options: { prefix?: string } = {},
): Promise<void> {
  const prefix = options.prefix ?? "";
  const rawName = `${prefix}raw_layer`;
  const attrName = `${prefix}layer_attr`;
  const geomName = `${prefix}layer_01`;

  const expanded = await expandZips(files);
  const group = groupByType(expanded);

  // Drop any tables from a previous run
  await conn.query(`DROP TABLE IF EXISTS ${rawName}`);
  await conn.query(`DROP TABLE IF EXISTS ${geomName}`);
  await conn.query(`DROP TABLE IF EXISTS ${attrName}`);

  // DuckDB's registered-file namespace is keyed by name, and multiple drops in one
  // session commonly share a literal basename (e.g. every country in the portolan
  // catalog exports as "original.parquet"). Reusing a name across registrations
  // left stale Parquet metadata behind even after dropFile(), producing
  // "ZSTD Decompression failure" on the second load of a same-named file. A
  // per-call id keeps every registration unique regardless of the source filename.
  const uid = randomId();

  let filePath: string;
  let isParquet = false;
  const registered: string[] = [];

  if (group.parquet) {
    const file = group.parquet;
    const registeredName = `${prefix}${uid}_${file.name}`;
    await db.registerFileBuffer(registeredName, new Uint8Array(await file.arrayBuffer()));
    registered.push(registeredName);
    filePath = registeredName;
    isParquet = true;
  } else if (group.spatial) {
    const file = group.spatial;
    const registeredName = `${prefix}${uid}_${file.name}`;
    const e = ext(file.name);
    let buffer = new Uint8Array(await file.arrayBuffer());
    if (e === ".geojson" || e === ".geojsonl") {
      const text = renameCollidingOgcFid(new TextDecoder().decode(buffer));
      buffer = new TextEncoder().encode(text);
    }
    await db.registerFileBuffer(registeredName, buffer);
    registered.push(registeredName);
    filePath = registeredName;
  } else if (group.shapefile) {
    // Register all component files; use the .shp path for ST_Read
    const relPaths = group.shapefile.map(
      (f) =>
        `${prefix}${uid}_${(f as File & { webkitRelativePath: string }).webkitRelativePath || f.name}`,
    );
    await Promise.all(
      group.shapefile.map(async (file, i) => {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await db.registerFileBuffer(relPaths[i], buffer);
      }),
    );
    registered.push(...relPaths);
    filePath = relPaths.find((p) => p.toLowerCase().endsWith(".shp")) ?? relPaths[0];
  } else {
    throw new Error(
      "No supported file found. Drop a GeoJSON, GeoParquet, GeoPackage, Shapefile, or ZIP.",
    );
  }

  // Single-quote the path for SQL string literals (double quotes = identifiers in SQL)
  const sqlPath = "'" + filePath.replace(/'/g, "''") + "'";

  // Load into raw_layer with stable fid.
  // GeoPackage: LIST_ALL_TABLES=NO tells GDAL to only read tables registered in
  // gpkg_contents, preventing stoi("") crashes on unregistered SQLite metadata tables.
  const gpkgOpts = filePath.toLowerCase().endsWith(".gpkg")
    ? `, open_options=['LIST_ALL_TABLES=NO']`
    : "";
  const readFn = isParquet ? `read_parquet(${sqlPath})` : `ST_Read(${sqlPath}${gpkgOpts})`;
  await conn.query(`
    CREATE OR REPLACE TABLE ${rawName} AS
    SELECT *, row_number() OVER () AS fid FROM ${readFn}
  `);

  // Detect geometry column and bbox / *_bbox covering columns to exclude
  const desc = await conn.query(`DESCRIBE ${rawName}`);
  const schema = desc.toArray() as Array<{
    column_name: string;
    column_type: string;
  }>;

  // A Parquet file without GeoParquet metadata carries geometry as a WKB BLOB; detect it by name.
  const geomRow =
    schema.find((r) => r.column_type.startsWith("GEOMETRY")) ??
    (isParquet
      ? schema.find(
          (r) => r.column_type === "BLOB" && WKB_NAMES.includes(r.column_name.toLowerCase()),
        )
      : undefined);
  if (!geomRow) throw new Error("No geometry column found in the loaded file.");

  const { column_name: geomCol, column_type: geomType } = geomRow;
  const excludeCols = schema
    .filter(
      (r) =>
        r.column_type.startsWith("GEOMETRY") ||
        (r.column_type === "BLOB" && r.column_name === geomCol) ||
        ((r.column_name === "bbox" || r.column_name.endsWith("_bbox")) &&
          r.column_type.startsWith("STRUCT")),
    )
    .map((r) => JSON.stringify(r.column_name));
  const excludeSQL = excludeCols.join(", ");

  // Attribute table: all non-geometry, non-bbox columns (keeps fid)
  await conn.query(`
    CREATE OR REPLACE TABLE ${attrName} AS
    SELECT * EXCLUDE (${excludeSQL})
    FROM ${rawName}
  `);

  const quotedGeomCol = JSON.stringify(geomCol);
  await conn.query(`
    CREATE OR REPLACE TABLE ${geomName} AS
    SELECT fid, ${loadGeomExpr(geomType, quotedGeomCol)} AS geom
    FROM ${rawName}
  `);

  await conn.query(`DROP TABLE ${rawName}`);

  // Release the input file buffers — they're not read again past this point,
  // and on a multi-hundred-MB input they'd otherwise stay pinned in WASM heap
  // through stages 2–5.
  for (const name of registered) {
    try {
      await db.dropFile(name);
    } catch {
      // best-effort
    }
  }

  const [extent] = (
    await conn.query(`
      SELECT ST_XMin(e) AS xmin, ST_XMax(e) AS xmax, ST_YMin(e) AS ymin, ST_YMax(e) AS ymax
      FROM (SELECT ST_Extent_Agg(geom) AS e FROM ${geomName})
    `)
  ).toArray() as Array<{
    xmin: number | null;
    xmax: number | null;
    ymin: number | null;
    ymax: number | null;
  }>;
  if (
    extent &&
    extent.xmin !== null &&
    (extent.xmin < -180 || extent.xmax! > 180 || extent.ymin! < -90 || extent.ymax! > 90)
  ) {
    throw new Error(
      "Coordinates fall outside longitude/latitude range, so the layer looks projected but has no usable CRS. Re-export it with its CRS, or reproject it to EPSG:4326.",
    );
  }
}
