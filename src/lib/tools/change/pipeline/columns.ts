import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { resolveLevels } from "$lib/tools/schema-map/pipeline/resolveLevels";

// The finest level's code and primary name column, null where not found.
export async function detectUnitColumns(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<{ code: string | null; name: string | null }> {
  try {
    const levels = await resolveLevels(conn, table, null);
    const finest = levels.get(Math.max(...levels.keys()))!;
    return { code: finest.code, name: finest.names[0] ?? null };
  } catch {
    return { code: null, name: null };
  }
}
