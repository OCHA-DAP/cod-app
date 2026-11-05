import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Row-order [lo, hi] rowid ranges of at most `budget` vertices, from a query
// of (rid, n) ordered by rid. Always at least one range, so a loop still runs once.
export async function vertexBatches(
  conn: AsyncDuckDBConnection,
  sizesSql: string,
  budget: number,
): Promise<[number, number][]> {
  const sizes = (await conn.query(sizesSql)).toArray() as Array<{
    rid: bigint | number;
    n: bigint | number;
  }>;
  const batches: [number, number][] = [];
  let total = budget;
  for (const row of sizes) {
    const [rid, n] = [Number(row.rid), Number(row.n)];
    if (total + n > budget) {
      batches.push([rid, rid]);
      total = 0;
    }
    batches[batches.length - 1][1] = rid;
    total += n;
  }
  return batches.length > 0 ? batches : [[0, -1]];
}
