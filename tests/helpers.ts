import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
import { listFormats, runExport, type ExportSource } from "$lib/db/export";
import { loadFile } from "$lib/db/loader";

export function db() {
  const { db, conn } = duckdbState;
  if (!db || !conn) throw new Error(duckdbState.initError ?? "DuckDB not ready");
  return { db, conn };
}

export async function ready() {
  await initDuckDB();
  return db().conn;
}

// Plain JS rows, BigInt counts narrowed to Number.
export async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const out = (await db().conn.query(sql)).toArray().map((r) => r.toJSON());
  return out.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]),
    ),
  ) as T[];
}

export async function scalar<T = unknown>(sql: string): Promise<T> {
  const [row] = await rows(sql);
  return Object.values(row)[0] as T;
}

export async function run(sql: string): Promise<void> {
  await db().conn.query(sql);
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// CREATE OR REPLACE TABLE name AS VALUES; a column named geom is read as WKT.
export async function table(
  name: string,
  columns: string[],
  values: unknown[][],
  types: Record<string, string> = {},
): Promise<void> {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const select = columns
    .map((c) =>
      c === "geom"
        ? `ST_GeomFromText("geom") AS geom`
        : types[c]
          ? `"${c}"::${types[c]} AS "${c}"`
          : `"${c}"`,
    )
    .join(", ");
  const body = values.map((r) => `(${r.map(literal).join(", ")})`).join(", ");
  await run(
    `CREATE OR REPLACE TABLE "${name}" AS SELECT ${select} FROM (VALUES ${body}) t(${cols})`,
  );
}

// Loads a fixture through the app's loader, giving <prefix>layer_01 + <prefix>layer_attr.
export async function loadFixture(url: string, filename: string, prefix = ""): Promise<void> {
  const { db: instance, conn } = db();
  const blob = await (await fetch(url)).blob();
  await loadFile(instance, conn, [new File([blob], filename)], prefix ? { prefix } : undefined);
}

// Splits a SELECT with a geom column into the loader's layer_01 (fid, geom) + layer_attr.
export async function layer(select: string, prefix = ""): Promise<void> {
  await run(
    `CREATE OR REPLACE TABLE _layer AS SELECT row_number() OVER () AS fid, * FROM (${select})`,
  );
  await run(`CREATE OR REPLACE TABLE ${prefix}layer_01 AS SELECT fid, geom FROM _layer`);
  await run(`CREATE OR REPLACE TABLE ${prefix}layer_attr AS SELECT * EXCLUDE (geom) FROM _layer`);
}

// Column names of a source's Parquet export, read back from the exported bytes.
export async function exportColumns(source: ExportSource): Promise<string[]> {
  const format = (await listFormats(source)).find((f) => f.id === "parquet");
  if (!format) throw new Error(`${source} has no Parquet export`);
  const { blob } = await runExport(source, format, "t");
  await db().db.registerFileBuffer("_export.parquet", new Uint8Array(await blob.arrayBuffer()));
  return (await rows<{ column_name: string }>("DESCRIBE SELECT * FROM '_export.parquet'")).map(
    (r) => r.column_name,
  );
}
