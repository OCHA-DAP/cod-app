import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { DuckDBDataProtocol } from "@duckdb/duckdb-wasm";
import { unzip as fflateUnzip, zip as fflateZip } from "fflate";
import { duckdbState } from "./duckdb.svelte";
import { flaggedUnitsSql } from "./flagged";

export type ExportSource =
  | "extend"
  | "clean_topology"
  | "topology_issues"
  | "crosswalk_overlay"
  | "crosswalk_changelog"
  | "match"
  | "match_issues"
  | "stitch"
  | "stitch_issues"
  | "detect_issues"
  | "clip"
  | "clip_issues"
  | "mosaic"
  | "mosaic_issues"
  | "schema_map"
  | "schema_refactor"
  | "schema_fill"
  | "schema_join"
  | "schema_join_issues"
  | "package_polygons_level_0"
  | "package_polygons_level_1"
  | "package_polygons_level_2"
  | "package_polygons_level_3"
  | "package_polygons_level_4"
  | "package_polygons_level_5"
  | "package_polygons_level_6"
  | "package_polygons_level_7"
  | "package_points"
  | "package_lines"
  | "code_create"
  | "code_create_issues"
  | "code_update"
  | "code_update_changelog"
  | "name_detect_issues"
  | "name_clean"
  | "name_clean_issues"
  | "schema_detect_issues"
  | "code_detect_issues"
  | "validate_topo_issues"
  | "validate_summary";

export type ExportKind = "geojson_cached" | "gdal" | "parquet" | "csv";

export type SourceKind = "spatial" | "tabular";

export interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  mime: string;
  kind: ExportKind;
  driver?: string;
  rank: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

interface DriverMeta {
  label: string;
  ext: string;
  mime: string;
  rank: number;
  layerOptions?: string[];
  hidden?: boolean;
}

// Curated set of GDAL output drivers under DuckDB-WASM's spatial extension.
// All route through a registered OPFS FileSystemFileHandle (see exportGdal) —
// duckdb-wasm's plain BUFFER filesystem silently produces 1-byte placeholder
// files instead of erroring. GeoJSON and GPX are excluded (served from the
// cached string, and polygon-incompatible, respectively); KML/LIBKML both
// produce .kml, so we surface whichever the loaded build provides.
const KNOWN_DRIVERS: Record<string, DriverMeta> = {
  GPKG: {
    label: "GeoPackage (.gpkg)",
    ext: ".gpkg",
    mime: "application/geopackage+sqlite3",
    rank: 20,
  },
  "ESRI Shapefile": {
    label: "Shapefile (.shp.zip)",
    ext: ".shp.zip",
    mime: "application/zip",
    rank: 30,
    // ENCODING=UTF-8 makes GDAL write the .cpg sidecar declaring UTF-8 and
    // ensures non-ASCII attribute values round-trip through the .dbf.
    layerOptions: ["ENCODING=UTF-8"],
    // duckdb-wasm 2.0 writes corrupt shapefiles; the canary in tests/export.test.ts fails once fixed.
    hidden: true,
  },
  // FGB writes a spatial index by default; the back-patched header needs
  // random-write semantics, same precedent as Shapefile.
  FlatGeobuf: {
    label: "FlatGeobuf (.fgb)",
    ext: ".fgb",
    mime: "application/vnd.flatgeobuf",
    rank: 40,
  },
  // LIBKML is preferred over KML when the build provides it: the older KML
  // driver writes a minimal <Style> with only <LineStyle>, which QGIS honours
  // by drawing just polygon outlines. LIBKML writes a complete style block.
  // Iteration order matters because both share the same label and the
  // pushUnique de-dup keeps the first one seen.
  LIBKML: {
    label: "KML (.kml)",
    ext: ".kml",
    mime: "application/vnd.google-earth.kml+xml",
    rank: 50,
  },
  KML: {
    label: "KML (.kml)",
    ext: ".kml",
    mime: "application/vnd.google-earth.kml+xml",
    rank: 50,
  },
  GML: {
    label: "GML (.gml)",
    ext: ".gml",
    mime: "application/gml+xml",
    rank: 60,
  },
};

// A column that sets export row order and is itself left out.
export const ROW_ORDER_COLUMN = "__row_order";

interface SourceConfig {
  table: string;
  attrTable: string | null;
  suffix: string;
  kind: SourceKind;
  // Explicit attribute column allowlist for attrTable === null sources. When
  // unset, buildSpatialSelect passes through every non-geom column from the
  // table (DESCRIBE-based). Use this when the table carries internal columns
  // (e.g. raw-degree measurements, bounding boxes) that shouldn't leak into
  // the exported attribute table.
  columns?: string[];
  // Tabular-only: explicit column list/order for a table with a row-order
  // column that must drive sort but not appear in the export itself.
  tabularColumns?: string[];
  orderBy?: string;
  // Tabular-only: a (key, geom) query whose geometry leads the Parquet export, joined on key.
  parquetGeometry?: string;
}

const SOURCES: Record<ExportSource, SourceConfig> = {
  extend: { table: "layer_05", attrTable: "layer_attr", suffix: "_ee", kind: "spatial" },
  clean_topology: {
    table: "tc_clean",
    attrTable: "layer_attr",
    suffix: "_cleaned",
    kind: "spatial",
  },
  topology_issues: {
    table: "tc_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "near_length_m",
      "fixed",
      "unit_a",
      "unit_b",
      "unit_a_area_change_m2",
      "unit_b_area_change_m2",
      "filled_area_m2",
      "reason",
    ],
  },
  crosswalk_overlay: {
    table: "cw_overlay_render",
    attrTable: null,
    suffix: "_cw_overlay",
    kind: "spatial",
  },
  crosswalk_changelog: {
    table: "cw_changelog",
    attrTable: null,
    suffix: "_changelog",
    kind: "tabular",
  },
  match: {
    table: "ge_results",
    attrTable: "ge_results_attr",
    suffix: "_matched",
    kind: "spatial",
  },
  match_issues: {
    table: "ge_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "fixed",
      "unit_a",
      "unit_b",
      "overlay_fid",
      "reason",
    ],
  },
  stitch: { table: "st_clean", attrTable: "layer_attr", suffix: "_stitched", kind: "spatial" },
  stitch_issues: {
    table: "st_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "fixed",
      "unit_a",
      "unit_b",
      "reason",
    ],
  },
  detect_issues: {
    table: "dt_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "near_length_m",
      "unit_a",
      "unit_b",
    ],
  },
  clip: { table: "cl_clip", attrTable: "input_layer_attr", suffix: "_clipped", kind: "spatial" },
  clip_issues: {
    table: "cl_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "fixed",
      "unit_a",
      "unit_b",
      "overlay_fid",
      "reason",
    ],
  },
  mosaic: {
    table: "st_clean",
    attrTable: "input_layer_attr",
    suffix: "_mosaicked",
    kind: "spatial",
  },
  mosaic_issues: {
    table: "ms_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "fixed",
      "unit_a",
      "unit_b",
      "overlay_fid",
      "reason",
    ],
  },
  schema_map: {
    table: "sm_crosswalk",
    attrTable: null,
    suffix: "_crosswalk",
    kind: "tabular",
    tabularColumns: ["source_column", "target_column", "unique_count", "note"],
    orderBy: "column_order",
  },
  schema_refactor: {
    table: "layer_01",
    attrTable: "sr_result_attr",
    suffix: "_mapped",
    kind: "spatial",
  },
  schema_join: {
    table: "input_layer_01",
    attrTable: "sj_result_attr",
    suffix: "_join",
    kind: "spatial",
  },
  schema_join_issues: {
    table: "sj_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "spatial",
    columns: ["key", "kind", "unit_a", "join_fid", "reason", "area_m2"],
  },
  schema_fill: {
    table: "layer_01",
    attrTable: "sf_result_attr",
    suffix: "_filled",
    kind: "spatial",
  },
  package_polygons_level_0: {
    table: "pp_geom_0",
    attrTable: "pp_attr_0",
    suffix: "_pp_level0",
    kind: "spatial",
  },
  package_polygons_level_1: {
    table: "pp_geom_1",
    attrTable: "pp_attr_1",
    suffix: "_pp_level1",
    kind: "spatial",
  },
  package_polygons_level_2: {
    table: "pp_geom_2",
    attrTable: "pp_attr_2",
    suffix: "_pp_level2",
    kind: "spatial",
  },
  package_polygons_level_3: {
    table: "pp_geom_3",
    attrTable: "pp_attr_3",
    suffix: "_pp_level3",
    kind: "spatial",
  },
  package_polygons_level_4: {
    table: "pp_geom_4",
    attrTable: "pp_attr_4",
    suffix: "_pp_level4",
    kind: "spatial",
  },
  package_polygons_level_5: {
    table: "pp_geom_5",
    attrTable: "pp_attr_5",
    suffix: "_pp_level5",
    kind: "spatial",
  },
  package_polygons_level_6: {
    table: "pp_geom_6",
    attrTable: "pp_attr_6",
    suffix: "_pp_level6",
    kind: "spatial",
  },
  package_polygons_level_7: {
    table: "pp_geom_7",
    attrTable: "pp_attr_7",
    suffix: "_pp_level7",
    kind: "spatial",
  },
  package_points: {
    table: "pkpt_geom",
    attrTable: "pkpt_attr",
    suffix: "_pp_points",
    kind: "spatial",
  },
  package_lines: { table: "pl_geom", attrTable: "pl_attr", suffix: "_pp_lines", kind: "spatial" },
  code_create: { table: "layer_01", attrTable: "cc_attr", suffix: "_coded", kind: "spatial" },
  code_create_issues: {
    table: "cc_issues",
    attrTable: null,
    suffix: "_issues",
    kind: "tabular",
    tabularColumns: [
      "kind",
      "level",
      "parent_code",
      "assigned_code",
      "child_count",
      "min_width",
      "reason",
    ],
  },
  code_update: {
    table: "cu_b_layer_01",
    attrTable: "cu_b_attr",
    suffix: "_coded",
    kind: "spatial",
  },
  code_update_changelog: {
    table: "cu_changelog",
    attrTable: null,
    suffix: "_changelog",
    kind: "tabular",
    tabularColumns: [
      "level",
      "old_code",
      "old_name",
      "new_code",
      "new_name",
      "relationship_class",
      "cluster_id",
      "match_method",
      "code_outcome",
      "reason",
    ],
  },
  name_detect_issues: {
    table: "nd_report",
    attrTable: null,
    suffix: "_name_issues",
    kind: "tabular",
    tabularColumns: [
      "key",
      "kind",
      "severity",
      "level",
      "name_column",
      "code_a",
      "name_a",
      "code_b",
      "name_b",
      "suggested",
      "reason",
    ],
  },
  name_clean: { table: "layer_01", attrTable: "nc_attr", suffix: "_cleaned", kind: "spatial" },
  name_clean_issues: {
    table: "nc_report",
    attrTable: null,
    suffix: "_name_issues",
    kind: "tabular",
    tabularColumns: [
      "key",
      "kind",
      "severity",
      "level",
      "name_column",
      "code_a",
      "name_a",
      "code_b",
      "name_b",
      "suggested",
      "reason",
      "fixed",
    ],
  },
  schema_detect_issues: {
    table: "sd_report",
    attrTable: null,
    suffix: "_schema_issues",
    kind: "tabular",
    tabularColumns: ["key", "kind", "severity", "level", "column", "code", "reason"],
  },
  code_detect_issues: {
    table: "cd_report",
    attrTable: null,
    suffix: "_code_issues",
    kind: "tabular",
    parquetGeometry: `SELECT key, ST_Union_Agg(geom) AS geom FROM (${flaggedUnitsSql("cd_flagged")}) GROUP BY key`,
    tabularColumns: [
      "key",
      "kind",
      "severity",
      "level",
      "column",
      "code_a",
      "name_a",
      "code_b",
      "name_b",
      "reason",
    ],
  },
  validate_topo_issues: {
    table: "dt_issues",
    attrTable: null,
    suffix: "_topo_issues",
    kind: "spatial",
    columns: [
      "key",
      "kind",
      "area_m2",
      "max_width_m",
      "thinness_ratio",
      "near_length_m",
      "unit_a",
      "unit_b",
    ],
  },
  validate_summary: {
    table: "vd_summary",
    attrTable: null,
    suffix: "_validate_summary",
    kind: "tabular",
    tabularColumns: ["stage", "kind", "severity", "count", "report", "reason"],
  },
};

export function sourceKind(source: ExportSource): SourceKind {
  return SOURCES[source].kind;
}

// GDAL-driven GeoJSON. Used as the primary-button format when DownloadMenu
// has no cached GeoJSON string available (i.e. the cleaned-input fallback
// after a pipeline OOM, where building a JS string would re-trigger the
// heap exhaustion). GDAL streams output through OPFS instead.
export const gdalGeoJSONFormat: ExportFormat = {
  id: "gdal:GeoJSON",
  label: "GeoJSON (.geojson)",
  ext: ".geojson",
  mime: "application/geo+json",
  kind: "gdal",
  driver: "GeoJSON",
  rank: 5,
};

let cachedSpatialFormats: Promise<ExportFormat[]> | null = null;

export function resetFormatsCache(): void {
  cachedSpatialFormats = null;
}

export async function listFormats(source?: ExportSource): Promise<ExportFormat[]> {
  const kind: SourceKind = source ? SOURCES[source].kind : "spatial";
  if (kind === "tabular") return tabularFormats();
  if (!cachedSpatialFormats) cachedSpatialFormats = discoverSpatialFormats();
  return cachedSpatialFormats;
}

function tabularFormats(): ExportFormat[] {
  // Plain tabular sources (e.g. crosswalk_changelog): no geometry, no GDAL drivers.
  // CSV is the primary readable export; Parquet rides the same native COPY path
  // (FORMAT PARQUET) as the spatial Parquet export.
  return [
    {
      id: "csv",
      label: "CSV (.csv)",
      ext: ".csv",
      mime: "text/csv",
      kind: "csv",
      rank: 1,
    },
    {
      id: "parquet",
      label: "Parquet (.parquet)",
      ext: ".parquet",
      mime: "application/vnd.apache.parquet",
      kind: "parquet",
      rank: 10,
    },
  ];
}

async function discoverSpatialFormats(): Promise<ExportFormat[]> {
  const conn = duckdbState.conn;
  if (!conn) throw new Error("DuckDB is not ready yet.");

  // GeoJSON is intentionally omitted: the primary download button already
  // serves the cached GeoJSON, so listing it here would duplicate that entry.
  const formats: ExportFormat[] = [];

  const seenLabels = new Set<string>();
  const pushUnique = (f: ExportFormat) => {
    if (seenLabels.has(f.label)) return;
    seenLabels.add(f.label);
    formats.push(f);
  };

  // Intersect the curated KNOWN_DRIVERS set with what the loaded spatial
  // extension actually supports. A future build that drops a driver simply
  // hides the corresponding menu entry; nothing surfaces beyond the curated
  // list.
  const drivers = await conn.query("SELECT short_name FROM ST_Drivers() WHERE can_create");
  const available = new Set(
    (drivers.toArray() as Array<{ short_name: string }>).map((r) => r.short_name),
  );

  for (const [shortName, meta] of Object.entries(KNOWN_DRIVERS)) {
    if (meta.hidden || !available.has(shortName)) continue;
    pushUnique({
      id: `gdal:${shortName}`,
      label: meta.label,
      ext: meta.ext,
      mime: meta.mime,
      kind: "gdal",
      driver: shortName,
      rank: meta.rank,
    });
  }

  pushUnique({
    id: "parquet",
    label: "GeoParquet (.parquet)",
    ext: ".parquet",
    mime: "application/vnd.apache.parquet",
    kind: "parquet",
    rank: 10,
  });

  formats.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.label.localeCompare(b.label);
  });
  return formats;
}

export async function runExport(
  source: ExportSource,
  format: ExportFormat,
  filenameStem: string,
  cachedGeoJSON?: string,
): Promise<ExportResult> {
  const { suffix } = SOURCES[source];
  const filename = `${filenameStem}${suffix}${format.ext}`;

  switch (format.kind) {
    case "geojson_cached": {
      if (!cachedGeoJSON) throw new Error("No cached GeoJSON to download.");
      return {
        blob: new Blob([cachedGeoJSON], { type: format.mime }),
        filename,
      };
    }
    case "gdal":
      return exportGdal(source, format, filenameStem);
    case "parquet":
      return exportParquet(source, format, filenameStem);
    case "csv":
      return exportCsv(source, format, filenameStem);
  }
}

// Exports every source in one format into a single zip, flattening multi-file formats into it.
export async function runExportZip(
  sources: ExportSource[],
  format: ExportFormat,
  filenameStem: string,
  zipName: string,
): Promise<ExportResult> {
  const files: Record<string, Uint8Array> = {};
  for (const source of sources) {
    const r = await runExport(source, format, filenameStem);
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    if (format.ext.endsWith(".zip")) {
      const parts = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
        fflateUnzip(bytes, (err, data) => (err ? reject(err) : resolve(data))),
      );
      Object.assign(files, parts);
    } else files[r.filename] = bytes;
  }
  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    fflateZip(files, (err, data) => (err ? reject(err) : resolve(data))),
  );
  return { blob: toBlob(zipped, "application/zip"), filename: `${zipName}.zip` };
}

function requireDb(): { db: AsyncDuckDB; conn: AsyncDuckDBConnection } {
  const db = duckdbState.db;
  const conn = duckdbState.conn;
  if (!db || !conn) throw new Error("DuckDB is not ready yet.");
  return { db, conn };
}

function exportId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function vfsName(ext: string): string {
  return `__edge_export_${exportId()}${ext}`;
}

async function readOpfsFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array> {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function duckdbFsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const duckdbDir = await root.getDirectoryHandle("duckdb", { create: true });
  return duckdbDir.getDirectoryHandle("fs", { create: true });
}

// Best-effort cleanup of the main file plus any SQLite siblings the GPKG driver left behind.
async function removeOpfsEntries(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  for (const sfx of ["", "-journal", "-wal", "-shm"]) {
    await dir.removeEntry(name + sfx).catch(() => {});
  }
}

function quotePath(p: string): string {
  return "'" + p.replace(/'/g, "''") + "'";
}

async function dropFileSafe(db: AsyncDuckDB, name: string): Promise<void> {
  try {
    await db.dropFile(name);
  } catch {
    // best-effort cleanup; leaks are page-session-scoped
  }
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  // Copy into a fresh ArrayBuffer so the Blob constructor's BlobPart type
  // resolves cleanly under SharedArrayBuffer-aware DOM lib typings.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Blob([ab], { type });
}

async function buildSpatialSelect(
  conn: AsyncDuckDBConnection,
  source: SourceConfig,
  geomExpr: string,
): Promise<string> {
  if (!source.attrTable) {
    // Source carries its own props on the row. An explicit allowlist (when
    // given) takes precedence; otherwise passthrough every non-geom column.
    const desc = await conn.query(`DESCRIBE ${source.table}`);
    const schema = desc.toArray() as Array<{ column_name: string; column_type: string }>;
    const cols = (
      source.columns ??
      schema.map((r) => r.column_name).filter((c) => c !== "geom" && c !== ROW_ORDER_COLUMN)
    ).map((c) => `a.${JSON.stringify(c)}`);
    const extra = cols.length > 0 ? ", " + cols.join(", ") : "";
    const order = schema.some((r) => r.column_name === ROW_ORDER_COLUMN)
      ? ` ORDER BY a.${ROW_ORDER_COLUMN}`
      : "";
    return `SELECT ${geomExpr}${extra} FROM ${source.table} AS a WHERE a.geom IS NOT NULL${order}`;
  }
  const attrDesc = await conn.query(`DESCRIBE ${source.attrTable}`);
  const attrSchema = attrDesc.toArray() as Array<{
    column_name: string;
    column_type: string;
  }>;
  const isIncompatible = (t: string) =>
    t === "BLOB" ||
    t === "HUGEINT" ||
    t === "UHUGEINT" ||
    t.startsWith("STRUCT") ||
    t.startsWith("MAP") ||
    t.includes("[]");
  const attrExprs = attrSchema
    .filter((r) => r.column_name !== "fid" && r.column_name !== ROW_ORDER_COLUMN)
    .map((r) => {
      const col = JSON.stringify(r.column_name);
      return isIncompatible(r.column_type) ? `CAST(b.${col} AS VARCHAR) AS ${col}` : `b.${col}`;
    });
  const cols = attrExprs.length > 0 ? ", " + attrExprs.join(", ") : "";
  const order = attrSchema.some((r) => r.column_name === ROW_ORDER_COLUMN)
    ? ` ORDER BY b.${ROW_ORDER_COLUMN}`
    : "";
  return `SELECT ${geomExpr}${cols} FROM ${source.table} AS a LEFT JOIN ${source.attrTable} AS b ON a.fid = b.fid WHERE a.geom IS NOT NULL${order}`;
}

async function buildTabularSelect(source: SourceConfig): Promise<string> {
  const cols = source.tabularColumns
    ? source.tabularColumns.map((c) => JSON.stringify(c)).join(", ")
    : "*";
  const order = source.orderBy ? ` ORDER BY ${source.orderBy}` : "";
  return `SELECT ${cols} FROM ${source.table}${order}`;
}

async function exportGdal(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  const { suffix } = cfg;
  const meta = format.driver ? KNOWN_DRIVERS[format.driver] : undefined;
  const select = await buildSpatialSelect(conn, cfg, "ST_Multi(a.geom) AS geom");

  const layerOptionsClause =
    meta?.layerOptions && meta.layerOptions.length > 0
      ? `, LAYER_CREATION_OPTIONS (${meta.layerOptions.map(quotePath).join(", ")})`
      : "";

  const layerName = `${stem}${suffix}`;
  const layerNameClause = `, LAYER_NAME ${quotePath(layerName)}`;
  // The pipeline transforms input geometries to EPSG:4326 (loader.ts) and
  // the DB session sets geometry_always_xy=true, so all output GDAL drivers
  // should declare WGS84 explicitly. Without this, GDAL writes no CRS info
  // (no .prj for Shapefile, "Undefined geographic SRS" in GPKG, no
  // srsName in GML).
  const srsClause = `, SRS 'EPSG:4326'`;
  const filename = `${layerName}${format.ext}`;

  const root = await navigator.storage.getDirectory();
  const baseName = `__edge_export_${exportId()}`;

  if (format.driver === "ESRI Shapefile") {
    // Shapefile is multi-file. Pre-register OPFS handles for each
    // companion (.shp/.shx/.dbf/.prj/.cpg) so GDAL can write through
    // them, then bundle the results with fflate. /vsizip/ would be
    // cleaner but rejects the random-write pattern Shapefile uses.
    const exts = [".shp", ".shx", ".dbf", ".prj", ".cpg"];
    const companions: Array<{ ext: string; name: string; handle: FileSystemFileHandle }> = [];
    for (const ext of exts) {
      const fname = `${baseName}${ext}`;
      const handle = await root.getFileHandle(fname, { create: true });
      await db.registerFileHandle(fname, handle, DuckDBDataProtocol.BROWSER_FSACCESS, true);
      companions.push({ ext, name: fname, handle });
    }
    try {
      await conn.query(
        `COPY (${select}) TO ${quotePath(`${baseName}.shp`)} WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile'${srsClause}${layerNameClause}${layerOptionsClause})`,
      );
      const filesToZip: Record<string, Uint8Array> = {};
      for (const c of companions) {
        const file = await c.handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > 0) {
          filesToZip[`${layerName}${c.ext}`] = bytes;
        }
      }
      if (!filesToZip[`${layerName}.shp`]) {
        throw new Error("Shapefile export produced no .shp output");
      }
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        fflateZip(filesToZip, (err, data) => (err ? reject(err) : resolve(data)));
      });
      return { blob: toBlob(zipped, format.mime), filename };
    } finally {
      for (const c of companions) {
        await dropFileSafe(db, c.name);
        try {
          await root.removeEntry(c.name);
        } catch {
          // not present — fine
        }
      }
    }
  }

  // Single-file formats (GPKG, FlatGeobuf, KML, LIBKML, GML) write to an opfs:// path, whose files
  // DuckDB keeps under duckdb/fs/ and which also holds the GPKG driver's SQLite journal.
  const name = `${baseName}${format.ext}`;
  const fs = await duckdbFsDir();
  try {
    await conn.query(
      `COPY (${select}) TO ${quotePath(`opfs://${name}`)} WITH (FORMAT GDAL, DRIVER ${quotePath(format.driver!)}${srsClause}${layerNameClause}${layerOptionsClause})`,
    );
    const bytes = await readOpfsFileBytes(await fs.getFileHandle(name));
    return { blob: toBlob(bytes, format.mime), filename };
  } finally {
    await removeOpfsEntries(fs, name);
  }
}

async function exportParquet(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  let select: string;
  if (cfg.kind === "spatial") select = await buildSpatialSelect(conn, cfg, "a.geom AS geometry");
  else if (cfg.parquetGeometry) {
    const cols = cfg.tabularColumns!.map((c) => `r.${JSON.stringify(c)}`).join(", ");
    select = `--sql
      SELECT g.geom AS geometry, ${cols}
      FROM (SELECT *, row_number() OVER () AS __rn FROM ${cfg.table}) r
      LEFT JOIN (${cfg.parquetGeometry}) g USING (key)
      ORDER BY r.__rn`;
  } else select = await buildTabularSelect(cfg);

  const path = vfsName(format.ext);
  try {
    await conn.query(
      `COPY (${select}) TO ${quotePath(path)} (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 15, GEOPARQUET_VERSION 'BOTH')`,
    );
    const bytes = await db.copyFileToBuffer(path);
    return {
      blob: toBlob(bytes, format.mime),
      filename: `${stem}${cfg.suffix}${format.ext}`,
    };
  } finally {
    await dropFileSafe(db, path);
  }
}

async function exportCsv(
  source: ExportSource,
  format: ExportFormat,
  stem: string,
): Promise<ExportResult> {
  const { db, conn } = requireDb();
  const cfg = SOURCES[source];
  if (cfg.kind !== "tabular") {
    throw new Error(`CSV export is only supported for tabular sources (got ${source}).`);
  }
  const select = await buildTabularSelect(cfg);
  const path = vfsName(format.ext);
  try {
    await conn.query(`COPY (${select}) TO ${quotePath(path)} (FORMAT CSV, HEADER)`);
    const csv = await db.copyFileToBuffer(path);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const bytes = new Uint8Array(bom.byteLength + csv.byteLength);
    bytes.set(bom, 0);
    bytes.set(new Uint8Array(csv), bom.byteLength);
    return {
      blob: toBlob(bytes, format.mime),
      filename: `${stem}${cfg.suffix}${format.ext}`,
    };
  } finally {
    await dropFileSafe(db, path);
  }
}
