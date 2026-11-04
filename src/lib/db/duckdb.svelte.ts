import * as duckdb from "@duckdb/duckdb-wasm";
import { randomId } from "./id";

// The worker is self-hosted and the ~34 MB engine wasm comes from jsDelivr, whose URL carries
// the installed package version. The threads bundle needs cross-origin isolation, which is off.
import duckdbBaseWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";

export const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  base: { mainModule: duckdb.getJsDelivrBundles().base.mainModule, mainWorker: duckdbBaseWorker },
};

const SESSION_PREFIX = "__edge_matcher_";

class DuckDBState {
  db: duckdb.AsyncDuckDB | null = null;
  conn: duckdb.AsyncDuckDBConnection | null = null;
  ready = $state(false);
  initError = $state<string | null>(null);
}

export const duckdbState = new DuckDBState();

// Delete earlier tabs' session DBs; a live tab's DB is open, so the browser refuses its removal.
async function sweepSessionDbs(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const duckdbDir = await root.getDirectoryHandle("duckdb", { create: true });
  const fs = await duckdbDir.getDirectoryHandle("fs", { create: true });
  const names: string[] = [];
  for await (const name of fs.keys()) {
    if (name.startsWith(SESSION_PREFIX) && name.endsWith(".duckdb")) names.push(name);
  }
  for (const name of names) {
    const removed = await fs.removeEntry(name).then(
      () => true,
      () => false,
    );
    if (removed) await fs.removeEntry(`${name}.wal`).catch(() => {});
  }
}

export async function initDuckDB(): Promise<void> {
  if (duckdbState.ready || duckdbState.initError) return;
  try {
    const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const instance = new duckdb.AsyncDuckDB(logger, worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);

    await sweepSessionDbs().catch(() => {});
    // An opfs:// session DB lets tables outgrow the WASM heap, and "auto" file handling registers
    // opfs:// literals per query, which the GPKG export's SQLite journal needs.
    await instance.open({
      path: `opfs://${SESSION_PREFIX}${randomId()}.duckdb`,
      accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      opfs: { fileHandling: "auto" },
    });

    duckdbState.db = instance;
    const conn = await instance.connect();
    duckdbState.conn = conn;

    await conn.query("SET preserve_insertion_order = false");
    // Cache core's OGC:CRS84 before spatial's PROJ lookup, whose WKT2 export of "CRS84" throws stoi
    // in WASM. Outside an explicit transaction the cast throws an INTERNAL error.
    await conn.query("BEGIN");
    await conn.query("SELECT NULL::GEOMETRY('OGC:CRS84')");
    await conn.query("COMMIT");

    try {
      try {
        await conn.query("LOAD spatial;");
      } catch {
        await conn.query("INSTALL spatial; LOAD spatial;");
      }
      await conn.query("SET geometry_always_xy = true");
    } catch {
      console.warn("DuckDB spatial extension unavailable, GDAL support disabled.");
    }

    duckdbState.ready = true;
  } catch (e) {
    duckdbState.initError = e instanceof Error ? e.message : String(e);
  }
}
