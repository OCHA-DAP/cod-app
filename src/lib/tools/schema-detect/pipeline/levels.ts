import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent } from "$lib/db/code";
import {
  detectLevelAnchors,
  detectLevelColumns,
  detectRootLevel,
  rootAnchor,
  supplementalColumns,
  type Anchor,
  type LevelColumns,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { resolveLevels } from "$lib/tools/schema-map/pipeline/resolveLevels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

// Ported from topo-tools' core/schema_detect/_02_levels.py.

interface Row {
  level: number | null;
  columnName: string | null;
  family: string | null;
  rawFamily: string | null;
  anchored: boolean | null;
  isCode: boolean;
  problem: string | null;
  reason: string | null;
}

const row = (level: number | null, fields: Partial<Row> = {}): Row => ({
  level,
  columnName: null,
  family: null,
  rawFamily: null,
  anchored: null,
  isCode: false,
  problem: null,
  reason: null,
  ...fields,
});

const norm = (text: string): string => text.toLowerCase().replace(/[^0-9a-z]/g, "");
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

// Column minus head (or tail), unless that splits a run of digits.
function strip(column: string, head: string, tail: string): string | null {
  if (head && column.startsWith(head)) {
    const rest = column.slice(head.length);
    if (!(isDigit(head.at(-1)) && isDigit(rest[0]))) return rest;
  }
  if (tail && column.endsWith(tail)) {
    const rest = column.slice(0, column.length - tail.length);
    if (!(isDigit(tail[0]) && isDigit(rest.at(-1)))) return rest;
  }
  return null;
}

// Classifies column against its level's (prefix, anchor, suffix) naming split.
function columnRow(level: number, column: string, anchor: Anchor | null, isCode: boolean): Row {
  if (anchor === null) return row(level, { columnName: column, isCode });
  const [prefix, digits, suffix] = anchor;
  const raw = strip(column, prefix + digits, digits + suffix);
  if (raw !== null) {
    return row(level, { columnName: column, family: norm(raw), rawFamily: raw, anchored: true, isCode });
  }
  const loose = strip(norm(column), norm(prefix + digits), norm(digits + suffix));
  return row(level, { columnName: column, family: loose ?? norm(column), anchored: false, isCode });
}

function skippedRows(found: number[]): Row[] {
  const rows: Row[] = [];
  for (let n = found[0]; n <= found[found.length - 1]; n++) {
    if (!found.includes(n)) {
      rows.push(
        row(n, {
          problem: "level-skipped",
          reason: `levels ${found[0]} to ${found[found.length - 1]} found, but no level ${n} columns`,
        }),
      );
    }
  }
  return rows;
}

function explicitRows(columns: string[], codeField: string): Row[] {
  const at = codeField.indexOf("{n}");
  const [prefix, suffix] = [codeField.slice(0, at), codeField.slice(at + 3)];
  const pattern = new RegExp(`^${norm(prefix)}(\\d+)${norm(suffix)}$`);
  const codes = new Map<number, string>();
  for (const c of columns) {
    const m = pattern.exec(norm(c));
    if (m === null) continue;
    const n = Number(m[1]);
    if (!codes.has(n) || c === codeField.replace("{n}", String(n))) codes.set(n, c);
  }
  if (codes.size === 0) {
    return [row(null, { problem: "levels-undetected", reason: `no column matches the code template ${codeField}` })];
  }
  const found = [...codes.keys()].sort((a, b) => a - b);
  const rows = skippedRows(found);
  for (const n of found) {
    const [head, tail] = [prefix + String(n), String(n) + suffix];
    for (const c of columns) {
      if (strip(c, head, tail) !== null || strip(norm(c), norm(head), "") !== null) {
        rows.push(columnRow(n, c, [prefix, String(n), suffix], c === codes.get(n)));
      }
    }
  }
  return rows;
}

// The code column naming every level shares, as "adm{n}_pcode", or null.
function sharedTemplate(codes: Map<number, string>): string | null {
  const found: string[] = [];
  for (const [n, column] of codes) {
    const spots = [...column.matchAll(/\d+/g)].filter((m) => Number(m[0]) === n);
    if (spots.length !== 1) return null;
    const m = spots[0];
    found.push(column.slice(0, m.index) + "{n}" + column.slice(m.index! + m[0].length));
  }
  if (new Set(found.map(norm)).size !== 1) return null;
  return mostCommon(found);
}

// The most frequent value, ties going to the first seen.
function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  for (const [v, n] of counts) if (n > counts.get(best)!) best = v;
  return best;
}

async function tableColumns(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  return (
    (await conn.query(`DESCRIBE ${quoteIdent(table)}`)).toArray() as Array<{ column_name: string }>
  ).map((r) => r.column_name);
}

async function structuralRows(conn: AsyncDuckDBConnection, table: string): Promise<Row[]> {
  let detected: Map<number, LevelColumns>;
  try {
    detected = await detectLevelColumns(conn, table);
  } catch (e) {
    return [row(null, { problem: "levels-undetected", reason: e instanceof Error ? e.message : String(e) })];
  }
  const coded = new Map([...detected].filter(([, cols]) => cols.groupBy.length > 0));
  if (coded.size === 0) {
    return [row(null, { problem: "levels-undetected", reason: "no admin level with a code column detected" })];
  }
  const rows = skippedRows([...coded.keys()].sort((a, b) => a - b));
  for (const column of await supplementalColumns(conn, table)) {
    rows.push(
      row(null, {
        columnName: column,
        problem: "supplemental-column",
        reason:
          "set aside as a coarser grouping, not a level; if it is one, set the name/code templates",
      }),
    );
  }
  const anchors = await detectLevelAnchors(conn, table);
  const byLevel = new Map<number, Row[]>();
  for (const [n, cols] of coded) {
    const own = [...new Set([...cols.groupBy.slice(0, 1), ...cols.identityColumns])];
    byLevel.set(n, own.map((c) => columnRow(n, c, anchors.get(n) ?? null, false)));
  }
  const columns = await tableColumns(conn, table);
  const assigned = new Set([...byLevel.values()].flat().map((r) => r.columnName));
  for (const [n, [prefix, digits]] of anchors) {
    if (!byLevel.has(n)) continue;
    for (const c of columns) {
      if (!assigned.has(c) && strip(norm(c), norm(prefix + digits), "") !== null) {
        byLevel.get(n)!.push(columnRow(n, c, anchors.get(n)!, false));
      }
    }
  }
  // groupBy[0] can be a constant non-identity column, so the shared family wins.
  const votes = [...byLevel].flatMap(([n, found]) =>
    found.filter((r) => r.columnName === coded.get(n)!.groupBy[0]).map((r) => r.family),
  );
  const codeFamily = mostCommon(votes);
  for (const [n, found] of [...byLevel].sort((a, b) => a[0] - b[0])) {
    const cols = coded.get(n)!;
    const code =
      found.find((r) => r.anchored && r.family === codeFamily)?.columnName ?? cols.groupBy[0];
    for (const r of found) {
      if (r.columnName === code || cols.identityColumns.includes(r.columnName!) || !r.anchored) {
        rows.push({ ...r, isCode: r.columnName === code });
      }
    }
  }
  const codes = new Map<number, string>();
  for (const r of rows) if (r.isCode) codes.set(r.level!, r.columnName!);
  const template = sharedTemplate(codes);
  if (template !== null) {
    // Detection can merge a nested level's columns into the next one, so
    // level membership follows the shared naming once one exists.
    return [...rows.filter((r) => r.problem === "supplemental-column"), ...explicitRows(columns, template)];
  }
  return [...rows, ...(await rootRows(conn, table, detected, rows))];
}

// A whole-table-constant root level above the coarsest, named like the rest.
async function rootRows(
  conn: AsyncDuckDBConnection,
  table: string,
  detected: Map<number, LevelColumns>,
  rows: Row[],
): Promise<Row[]> {
  const coarsest = Math.min(...rows.filter((r) => r.isCode).map((r) => r.level!));
  const root = await detectRootLevel(conn, table, detected);
  const anchor = await rootAnchor(conn, table, detected);
  if (root === null || anchor === null || coarsest < 1) return [];
  const [level, rootColumns] = root;
  const codeFamily = rows.find((r) => r.isCode && r.level === coarsest)!.family;
  return rootColumns.identityColumns
    .map((c) => columnRow(level, c, anchor, false))
    .map((r) => ({ ...r, isCode: r.family === codeFamily }));
}

const lit = (v: string | number | boolean | null): string =>
  v === null ? "NULL" : typeof v === "string" ? "'" + v.replace(/'/g, "''") + "'" : String(v);

// Writes `${prefix}_02`: one row per level column, plus any unresolved-level row.
export async function buildSchemaLevels(
  conn: AsyncDuckDBConnection,
  table: string,
  prefix: string,
  schema: TargetSchema | null,
): Promise<void> {
  const rows =
    schema === null
      ? await structuralRows(conn, table)
      : explicitRows(await tableColumns(conn, table), schema.codeField);
  // Code Detect and Name Detect resolve levels this way, so their refusal is ours.
  if (!rows.some((r) => r.problem === "levels-undetected")) {
    try {
      await resolveLevels(conn, table, schema);
    } catch (e) {
      rows.push(row(null, { problem: "levels-undetected", reason: e instanceof Error ? e.message : String(e) }));
    }
  }
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${prefix}_02 (
      level INTEGER, column_name VARCHAR, family VARCHAR, raw_family VARCHAR,
      anchored BOOLEAN, is_code BOOLEAN, problem VARCHAR, reason VARCHAR
    )
  `);
  if (rows.length === 0) return;
  const values = rows
    .map(
      (r) =>
        `(${[r.level, r.columnName, r.family, r.rawFamily, r.anchored, r.isCode, r.problem, r.reason]
          .map(lit)
          .join(", ")})`,
    )
    .join(", ");
  await conn.query(`INSERT INTO ${prefix}_02 VALUES ${values}`);
}
