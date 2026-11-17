import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { detectLevelCodes } from "$lib/tools/schema-map/pipeline/levelColumns";

// Ports topo-tools' api/edge_mosaic.py original pairing for one input file.

export const PAIRED_ORIGINAL = "original_paired";

async function count(conn: AsyncDuckDBConnection, sql: string): Promise<number> {
  return Number(((await conn.query(sql)).toArray()[0] as { n: bigint | number }).n);
}

async function columns(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

// The original's own finest-level code column, null when undetectable.
async function originalKey(conn: AsyncDuckDBConnection): Promise<string | null> {
  // One row gives detection no structure to rank levels by.
  if ((await count(conn, "SELECT count(*) AS n FROM original_layer_attr")) <= 1) return null;
  try {
    const codes = await detectLevelCodes(conn, "original_layer_attr");
    return codes.get(Math.max(...codes.keys())) ?? null;
  } catch {
    return null;
  }
}

// Pairs each original row with the input fid sharing its code into PAIRED_ORIGINAL
// (fid, geom, input_fid); returns that table, or null with a warning when none pairs.
export async function pairOriginals(
  conn: AsyncDuckDBConnection,
  warnings: string[],
): Promise<string | null> {
  await conn.query(`DROP TABLE IF EXISTS ${PAIRED_ORIGINAL}`);
  // A detached piece merges only into a neighbouring row, which one row lacks.
  if ((await count(conn, "SELECT count(*) AS n FROM input_layer_01")) <= 1) return null;
  const key = await originalKey(conn);
  if (key === null) {
    warnings.push("The original has no detectable code column, so it pairs with nothing.");
    return null;
  }
  if (!(await columns(conn, "input_layer_attr")).includes(key)) {
    warnings.push(`The input runs without the original: it has no ${key} column to pair by.`);
    return null;
  }
  await conn.query(`--sql
    CREATE TABLE ${PAIRED_ORIGINAL} AS
    SELECT row_number() OVER () AS fid, g.geom, i.fid AS input_fid
    FROM original_layer_01 g JOIN original_layer_attr o USING (fid)
    LEFT JOIN (SELECT fid, "${key}"::VARCHAR AS k FROM input_layer_attr) i
      ON i.k = o."${key}"::VARCHAR
  `);
  const [{ paired, unmatched }] = (
    await conn.query(`SELECT count(input_fid) AS paired, count(*) - count(input_fid) AS unmatched
      FROM ${PAIRED_ORIGINAL}`)
  )
    .toArray()
    .map((r) => ({ paired: Number(r.paired), unmatched: Number(r.unmatched) }));
  if (!paired) {
    await conn.query(`DROP TABLE ${PAIRED_ORIGINAL}`);
    warnings.push("The input runs without the original: none of its codes match the input.");
    return null;
  }
  if (unmatched) {
    warnings.push(`${unmatched} original ${key} codes match no input feature.`);
  }
  return PAIRED_ORIGINAL;
}
