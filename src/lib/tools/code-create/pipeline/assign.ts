import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { nextFreeSibling } from "$lib/db/adminColumns";
import {
  assignNewCodes,
  checkLevelCount,
  checkUniqueNames,
  quoteIdent,
  seedCodeFromNames,
  widthFor,
  writeRootCode,
  type CodeFormat,
} from "$lib/db/code";
import type { Level } from "./levels";

export const SOURCE_CODES = ["replace", "embed", "copy"] as const;
export type SourceCodes = (typeof SOURCE_CODES)[number];

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

const INTEGER_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
]);

async function columnNames(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  return (
    (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{
      column_name: string;
    }>
  ).map((r) => r.column_name);
}

const ascending = (levels: Map<number, Level>): number[] =>
  [...levels.keys()].sort((a, b) => a - b);

// Keeps each level's source code in its next free numbered sibling column.
async function copySourceCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, Level>,
): Promise<void> {
  const columns = await columnNames(conn, table);
  const taken = new Set(columns);
  const siblings = new Map<string, string>();
  for (const n of ascending(levels)) {
    const level = levels.get(n)!;
    if (level.seeded || (n === 0 && (!levels.has(1) || levels.get(1)!.seeded))) continue;
    const sibling = nextFreeSibling(level.code, taken);
    siblings.set(level.code, sibling);
    taken.add(sibling);
  }
  const select: string[] = [];
  for (const column of columns) {
    select.push(quoteIdent(column));
    const sibling = siblings.get(column);
    if (sibling) select.push(`${quoteIdent(column)}::VARCHAR AS ${quoteIdent(sibling)}`);
  }
  await conn.query(
    `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT ${select.join(", ")} FROM ${quoteIdent(table)}`,
  );
}

// Strips each level's parent source code (or root) where every code repeats it.
async function stripParentPrefixes(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, Level>,
  fmt: CodeFormat,
  integers: Set<number>,
): Promise<void> {
  const numbered = ascending(levels).filter((n) => n >= 1);
  // Finest first, so each parent column still holds its own source code.
  for (const n of [...numbered].reverse()) {
    const level = levels.get(n)!;
    if (level.seeded) continue;
    let prefixSql: string;
    if (n === numbered[0]) prefixSql = sqlStr(fmt.rootCode);
    else if (levels.get(n - 1)!.seeded) continue;
    else prefixSql = `${quoteIdent(levels.get(n - 1)!.code)}::VARCHAR`;
    const codeSql = `${quoteIdent(level.code)}::VARCHAR`;
    const r = (
      await conn.query(`--sql
        SELECT
          COUNT(*) FILTER (
            WHERE starts_with(${codeSql}, ${prefixSql})
              AND length(${codeSql}) > length(${prefixSql})
          ) AS matched,
          COUNT(${codeSql}) AS total,
          COUNT(DISTINCT length(${codeSql}) - length(${prefixSql})) AS rest_lengths
        FROM ${quoteIdent(table)}
      `)
    ).toArray()[0] as {
      matched: number | bigint;
      total: number | bigint;
      rest_lengths: number | bigint;
    };
    const matched = Number(r.matched);
    const total = Number(r.total);
    if (matched === 0) continue;
    // Stripping 110 and 1100 under 11 would leave 0 and 00, so keep them whole.
    const mixed = fmt.delimiter === "" && Number(r.rest_lengths) > 1;
    if (integers.has(n) && (matched < total || mixed)) continue;
    if (matched < total) {
      throw new Error(
        `level ${n} (${JSON.stringify(level.code)}): ${matched} of ${total} source codes start with their parent's code; they must all, or none`,
      );
    }
    await conn.query(
      `UPDATE ${quoteIdent(table)} SET ${quoteIdent(level.code)} = substr(${codeSql}, length(${prefixSql}) + 1)`,
    );
  }
}

// Casts code columns to VARCHAR, blanks to NULL; returns the integer levels.
async function prepareSourceCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, Level>,
): Promise<Set<number>> {
  const types = new Map(
    (
      (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{
        column_name: string;
        column_type: string;
      }>
    ).map((r) => [r.column_name, r.column_type]),
  );
  const integers = new Set<number>();
  for (const n of ascending(levels)) {
    const level = levels.get(n)!;
    if (!types.has(level.code)) continue;
    if (INTEGER_TYPES.has(types.get(level.code)!)) integers.add(n);
    const qCode = quoteIdent(level.code);
    await conn.query(`ALTER TABLE ${quoteIdent(table)} ALTER ${qCode} TYPE VARCHAR`);
    await conn.query(`UPDATE ${quoteIdent(table)} SET ${qCode} = NULL WHERE trim(${qCode}) = ''`);
    if (n === 0 || level.seeded) continue;
    const r = (
      await conn.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${qCode} IS NULL`)
    ).toArray()[0] as { n: number | bigint };
    const nulls = Number(r.n);
    if (nulls > 0) {
      // Ranking would merge every code-less unit under a parent into one.
      throw new Error(
        `level ${n} (${JSON.stringify(level.code)}) has ${nulls} row(s) with no source code`,
      );
    }
  }
  return integers;
}

// Without a delimiter, zero-pads integer codes to one width; throws if text codes are mixed.
async function fixWidth(
  conn: AsyncDuckDBConnection,
  table: string,
  n: number,
  level: Level,
  fmt: CodeFormat,
  integer: boolean,
): Promise<void> {
  if (fmt.delimiter !== "") return;
  const lengths = (
    (
      await conn.query(
        `SELECT DISTINCT length(${quoteIdent(level.code)}) AS l FROM ${quoteIdent(table)}`,
      )
    ).toArray() as Array<{ l: number | bigint | null }>
  )
    .filter((r) => r.l !== null)
    .map((r) => Number(r.l))
    .sort((a, b) => a - b);
  if (lengths.length > 1 && !integer) {
    throw new Error(
      `level ${n} (${JSON.stringify(level.code)}) source codes vary in length ${JSON.stringify(lengths)}; without a delimiter the code can't be split`,
    );
  }
  if (integer && lengths.length > 0) {
    const width = Math.max(widthFor(fmt, n) ?? 0, lengths[lengths.length - 1]);
    const qCode = quoteIdent(level.code);
    await conn.query(`UPDATE ${quoteIdent(table)} SET ${qCode} = lpad(${qCode}, ${width}, '0')`);
  }
}

// Assigns a code into each level's own column, in place, root to leaf.
export async function assignCreateCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, Level>,
  fmt: CodeFormat,
  sourceCodes: SourceCodes,
): Promise<void> {
  if (!SOURCE_CODES.includes(sourceCodes)) {
    throw new Error(
      `source codes must be one of ${SOURCE_CODES.join(", ")}, got ${JSON.stringify(sourceCodes)}`,
    );
  }
  const qTable = quoteIdent(table);
  const order = ascending(levels);
  const finest = order[order.length - 1];
  checkLevelCount(fmt, order.filter((n) => n >= 1).length);
  const integers = await prepareSourceCodes(conn, table, levels);
  if (sourceCodes === "copy") await copySourceCodes(conn, table, levels);
  for (const n of order) {
    const level = levels.get(n)!;
    if (!level.seeded) continue;
    await seedCodeFromNames(conn, table, n, level.code, level.name);
    if (n === finest) {
      // Level 0's column may not exist until the root code is written.
      const parent = levels.get(n - 1)?.code ?? null;
      const present = parent !== null && (await columnNames(conn, table)).includes(parent);
      await checkUniqueNames(conn, table, n, level.code, present ? parent : null);
    }
  }
  if (sourceCodes === "embed") await stripParentPrefixes(conn, table, levels, fmt, integers);
  if (levels.has(0)) {
    const root = levels.get(0)!;
    const top = levels.get(1);
    const after = root.name ? [root.name] : [top?.name, top?.code];
    await writeRootCode(conn, table, root.code, fmt.rootCode, after);
  }

  let parentSql = sqlStr(fmt.rootCode);
  let parentColumn: string | null = null;
  for (const n of order.filter((l) => l >= 1)) {
    const level = levels.get(n)!;
    const qCode = quoteIdent(level.code);
    if (sourceCodes === "embed" && !level.seeded) {
      await fixWidth(conn, table, n, level, fmt, integers.has(n));
      await conn.query(
        `UPDATE ${qTable} SET ${qCode} = ${parentSql} || ${sqlStr(fmt.delimiter)} || ${qCode}::VARCHAR`,
      );
      parentSql = qCode;
      parentColumn = level.code;
      continue;
    }
    const stagingName = `${table}_code_lvl${n}`;
    const staging = quoteIdent(stagingName);
    await conn.query(`--sql
      CREATE OR REPLACE TEMP TABLE ${staging} AS
      SELECT ROW_NUMBER() OVER () AS row_id, orig_code, orig_code AS code_val, parent_code
      FROM (SELECT DISTINCT ${qCode} AS orig_code, ${parentSql} AS parent_code FROM ${qTable}) d
    `);
    await assignNewCodes(conn, stagingName, {
      idColumn: "row_id",
      parentColumn: "parent_code",
      sortColumns: ["code_val"],
      codeColumn: "code_val",
      fmt,
      level: n,
    });
    // A raw value MAY repeat across parents; match on parent too so this
    // never collides with, or drops, the same value/NULL elsewhere.
    const parentMatch =
      parentColumn === null
        ? "TRUE"
        : `t.${quoteIdent(parentColumn)} IS NOT DISTINCT FROM s.parent_code`;
    await conn.query(`--sql
      UPDATE ${qTable} t
      SET ${qCode} = s.code_val
      FROM ${staging} s
      WHERE t.${qCode} IS NOT DISTINCT FROM s.orig_code AND ${parentMatch}
    `);
    await conn.query(`DROP TABLE IF EXISTS ${staging}`);
    parentSql = qCode;
    parentColumn = level.code;
  }
}
