import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Shared hierarchical-code primitive, ported from topo-tools' core.code.
// A leaf module: no dependency on code-create or code-update.

// One width for every level, one per level coarsest first, or each level's widest tail.
export type MinWidth = number | number[] | "auto";

export interface CodeFormat {
  rootCode: string;
  delimiter: string;
  minWidth: MinWidth;
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function formatMinWidth(minWidth: MinWidth): string {
  return Array.isArray(minWidth) ? minWidth.join(",") : String(minWidth);
}

// Level's zero-pad floor (levels count from 1), null under auto.
export function widthFor(fmt: CodeFormat, level: number): number | null {
  if (fmt.minWidth === "auto") return null;
  if (Array.isArray(fmt.minWidth)) return fmt.minWidth[level - 1];
  return fmt.minWidth;
}

export function checkLevelCount(fmt: CodeFormat, count: number): void {
  if (Array.isArray(fmt.minWidth) && fmt.minWidth.length !== count) {
    throw new Error(
      `min width lists ${fmt.minWidth.length} widths (${formatMinWidth(fmt.minWidth)}) but ${count} level(s) are numbered`,
    );
  }
}

// A width ("3"), a coarsest-first list ("2,2,4"), or "auto".
export function parseMinWidth(value: string | number): MinWidth {
  let widths: number[];
  if (typeof value === "number") {
    widths = [value];
  } else {
    if (value.trim().toLowerCase() === "auto") return "auto";
    const parts = value.split(",");
    if (parts.some((p) => !/^\s*[+-]?\d+\s*$/.test(p))) {
      throw new Error(
        `min width must be a number, a comma list, or auto, got ${JSON.stringify(value)}`,
      );
    }
    widths = parts.map(Number);
  }
  if (widths.length === 0 || widths.some((w) => !Number.isInteger(w) || w < 1)) {
    throw new Error(`min width must be positive, got ${JSON.stringify(value)}`);
  }
  return widths.length === 1 ? widths[0] : widths;
}

export function resolveCodeFormat(
  rootCode: string,
  delimiter: string,
  minWidth: string | number,
  { allowEmptyDelimiter = false }: { allowEmptyDelimiter?: boolean } = {},
): CodeFormat {
  if (!rootCode) throw new Error("root code must be a non-empty string");
  if (!(allowEmptyDelimiter && delimiter === "") && [...delimiter].length !== 1) {
    throw new Error(`delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }
  return { rootCode, delimiter, minWidth: parseMinWidth(minWidth) };
}

// Components, root first; split by per-level width when there is no delimiter.
export function parseCode(code: string, fmt: CodeFormat): string[] {
  if (fmt.delimiter) return code.split(fmt.delimiter);
  if (!code.startsWith(fmt.rootCode)) {
    throw new Error(
      `code ${JSON.stringify(code)} does not start with root ${JSON.stringify(fmt.rootCode)}`,
    );
  }
  const components = [fmt.rootCode];
  let rest = code.slice(fmt.rootCode.length);
  let level = 1;
  while (rest) {
    const width = widthFor(fmt, level);
    if (width === null || width === undefined || rest.length < width) {
      throw new Error(`code ${JSON.stringify(code)} can't be split by width under this format`);
    }
    components.push(rest.slice(0, width));
    rest = rest.slice(width);
    level++;
  }
  return components;
}

export function buildCode(components: string[], fmt: CodeFormat): string {
  return components.join(fmt.delimiter);
}

// Drops code's own last component, i.e. its parent's code; throws for a
// root-only, single-component code (no parent to return).
export function parentPrefix(code: string, fmt: CodeFormat): string {
  const components = parseCode(code, fmt);
  if (components.length <= 1) {
    throw new Error(`code ${JSON.stringify(code)} has no parent under this format`);
  }
  return buildCode(components.slice(0, -1), fmt);
}

export function lastComponent(code: string, fmt: CodeFormat): string {
  const components = parseCode(code, fmt);
  return components[components.length - 1];
}

export function rewriteChildCode(oldCode: string, newParentCode: string, fmt: CodeFormat): string {
  return `${newParentCode}${fmt.delimiter}${lastComponent(oldCode, fmt)}`;
}

// The integers parentCode's own direct children already use.
export function usedIntegers(
  existingCodes: string[],
  parentCode: string,
  fmt: CodeFormat,
): Set<number> {
  const prefix = `${parentCode}${fmt.delimiter}`;
  const used = new Set<number>();
  for (const code of existingCodes) {
    if (!code.startsWith(prefix)) continue;
    const tail = code.slice(prefix.length);
    if (fmt.delimiter && tail.includes(fmt.delimiter)) continue;
    if (/^\d+$/.test(tail)) used.add(Number(tail));
  }
  return used;
}

export function nextAvailableInteger(
  existingCodes: string[],
  parentCode: string,
  fmt: CodeFormat,
): number {
  return Math.max(0, ...usedIntegers(existingCodes, parentCode, fmt)) + 1;
}

export interface AssignNewCodesOptions {
  idColumn: string;
  parentColumn: string;
  sortColumns: string[];
  codeColumn: string;
  fmt: CodeFormat;
  level: number;
  existingCodes?: string[];
}

// Ranks each row into a fresh sequential code per parent group. Without a
// delimiter at a fixed width, numbers stay below the top-10% placeholder range.
export async function assignNewCodes(
  conn: AsyncDuckDBConnection,
  table: string,
  opts: AssignNewCodesOptions,
): Promise<void> {
  const { idColumn, parentColumn, sortColumns, codeColumn, fmt, level } = opts;
  const existingCodes = opts.existingCodes ?? [];
  const qTable = quoteIdent(table);
  const qId = quoteIdent(idColumn);
  const qParent = quoteIdent(parentColumn);
  const qCode = quoteIdent(codeColumn);
  const width = widthFor(fmt, level);

  const counts = (
    await conn.query(`SELECT ${qParent} AS p, COUNT(*) AS n FROM ${qTable} GROUP BY 1`)
  ).toArray() as Array<{ p: string | null; n: number | bigint }>;

  const bases: Array<[string | null, number]> = [];
  for (const { p, n } of counts) {
    const count = Number(n);
    const used = p === null ? new Set<number>() : usedIntegers(existingCodes, p, fmt);
    let base = Math.max(0, ...used) + 1;
    if (fmt.delimiter === "" && width !== null && base + count - 1 >= 10 ** width) {
      const cutoff = 9 * 10 ** (width - 1);
      base = Math.max(0, ...[...used].filter((i) => i < cutoff)) + 1;
      const last = base + count - 1;
      if (last >= cutoff) {
        throw new Error(
          `level ${level}: ${JSON.stringify(p)} needs codes up to ${last}, past the top 10% (${cutoff}+) kept for placeholders at min width ${width}; without a delimiter the code can't be split, use a wider width`,
        );
      }
    }
    bases.push([p, base]);
  }

  const baseTable = quoteIdent(`${table}_code_base`);
  await conn.query(`--sql
    CREATE OR REPLACE TEMP TABLE ${baseTable} (parent_code VARCHAR, base_n INTEGER)
  `);
  for (let i = 0; i < bases.length; i += 500) {
    const values = bases
      .slice(i, i + 500)
      .map(([p, n]) => `(${p === null ? "NULL" : quoteLiteral(p)}, ${n})`)
      .join(", ");
    await conn.query(`INSERT INTO ${baseTable} VALUES ${values}`);
  }

  let widthSql: string;
  if (width === null) {
    // auto: pad every tail at this level to the widest one, retained included.
    const existingWidth = Math.max(
      1,
      ...existingCodes.map((c) => (fmt.delimiter ? c.split(fmt.delimiter).pop()! : c).length),
    );
    widthSql = `GREATEST(${existingWidth}, MAX(LENGTH(tail)) OVER ())`;
  } else {
    widthSql = String(width);
  }

  const orderSql = sortColumns.map((c) => `${quoteIdent(c)} NULLS LAST`).join(", ");
  const rankedTable = quoteIdent(`${table}_code_ranked`);
  await conn.query(`--sql
    CREATE OR REPLACE TEMP TABLE ${rankedTable} AS
    WITH numbered AS (
      SELECT
        src.${qId} AS id_value,
        src.${qParent} AS parent_code,
        CAST(
          base.base_n - 1 + ROW_NUMBER() OVER (
            PARTITION BY src.${qParent} ORDER BY ${orderSql}
          ) AS VARCHAR
        ) AS tail
      FROM ${qTable} src
      JOIN ${baseTable} base ON base.parent_code IS NOT DISTINCT FROM src.${qParent}
    )
    SELECT
      id_value,
      parent_code || ${quoteLiteral(fmt.delimiter)} ||
      lpad(tail, CAST(GREATEST(${widthSql}, LENGTH(tail)) AS INTEGER), '0') AS new_code
    FROM numbered
  `);

  await conn.query(`--sql
    UPDATE ${qTable} t
    SET ${qCode} = r.new_code
    FROM ${rankedTable} r
    WHERE t.${qId} = r.id_value
  `);

  await conn.query(`DROP TABLE IF EXISTS ${baseTable}`);
  await conn.query(`DROP TABLE IF EXISTS ${rankedTable}`);
}

// Fills a VARCHAR code column with level's names; throws without a name column.
export async function seedCodeFromNames(
  conn: AsyncDuckDBConnection,
  table: string,
  level: number,
  code: string,
  name: string | null,
): Promise<void> {
  if (name === null) {
    throw new Error(
      `level ${level} has neither ${JSON.stringify(code)} nor a name column in ${table}`,
    );
  }
  const nameSql = `${quoteIdent(name)}::VARCHAR`;
  if ((await describeColumns(conn, table)).includes(code)) {
    await conn.query(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(code)} = ${nameSql}`);
  } else {
    await insertColumnAfter(conn, table, code, nameSql, [name]);
  }
}

async function describeColumns(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE ${quoteIdent(table)}`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

// Adds column (valued by sql) after the last column starting with any of after, else last.
async function insertColumnAfter(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
  sql: string,
  after: Array<string | null | undefined>,
): Promise<void> {
  const columns = await describeColumns(conn, table);
  const hits = columns.flatMap((c, i) => (after.some((a) => a && c.startsWith(a)) ? [i] : []));
  const select = columns.map(quoteIdent);
  const at = hits.length ? hits[hits.length - 1] + 1 : columns.length;
  select.splice(at, 0, `${sql} AS ${quoteIdent(column)}`);
  await conn.query(
    `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT ${select.join(", ")} FROM ${quoteIdent(table)}`,
  );
}

// Sets column to rootCode on every row, adding it after `after` if missing.
export async function writeRootCode(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
  rootCode: string,
  after: Array<string | null | undefined>,
): Promise<void> {
  if (!(await describeColumns(conn, table)).includes(column)) {
    await insertColumnAfter(conn, table, column, "NULL::VARCHAR", after);
  }
  const literal = "'" + rootCode.replace(/'/g, "''") + "'";
  await conn.query(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ${literal}`);
}

// Throws if two rows share a name under one parent, so seeding would merge them.
export async function checkUniqueNames(
  conn: AsyncDuckDBConnection,
  table: string,
  level: number,
  name: string,
  parent: string | null = null,
): Promise<void> {
  const keys = [parent, name]
    .filter((c): c is string => c !== null)
    .map((c) => `${quoteIdent(c)}::VARCHAR`)
    .join(", ");
  const repeats = (
    await conn.query(`--sql
      SELECT concat_ws(' > ', ${keys}) AS k FROM ${quoteIdent(table)}
      WHERE ${quoteIdent(name)} IS NOT NULL
      GROUP BY ALL HAVING COUNT(*) > 1 ORDER BY 1
    `)
  ).toArray() as Array<{ k: string }>;
  if (repeats.length > 0) {
    const examples = repeats
      .slice(0, 5)
      .map((r) => JSON.stringify(r.k))
      .join(", ");
    throw new Error(
      `level ${level}: ${repeats.length} name(s) repeat under one parent in ${table} (${examples}); codes seeded from names would merge them, so tell them apart or add a code column`,
    );
  }
}

const SAMPLE_LIMIT = 10_000;

export async function detectCodeFormat(
  conn: AsyncDuckDBConnection,
  table: string,
  codeColumn: string,
): Promise<CodeFormat> {
  const qc = quoteIdent(codeColumn);
  const rows = (
    await conn.query(`--sql
      SELECT DISTINCT ${qc}::VARCHAR AS v FROM ${quoteIdent(table)}
      WHERE ${qc} IS NOT NULL
      LIMIT ${SAMPLE_LIMIT}
    `)
  ).toArray() as Array<{ v: string }>;
  const codes = rows.map((r) => r.v);
  if (codes.length === 0) {
    throw new Error(
      `no non-null values in ${JSON.stringify(codeColumn)} to detect a code format from`,
    );
  }

  const delimiter = detectDelimiter(codes, codeColumn);
  const rootCode = detectRoot(codes, delimiter, codeColumn);
  const minWidth = detectMinWidth(codes, delimiter, codeColumn);
  return { rootCode, delimiter, minWidth };
}

// Whether any sampled code in codeColumn has a non-alphanumeric character.
export async function hasDelimiter(
  conn: AsyncDuckDBConnection,
  table: string,
  codeColumn: string,
): Promise<boolean> {
  const qc = quoteIdent(codeColumn);
  const r = (
    await conn.query(`--sql
      SELECT bool_or(regexp_matches(${qc}::VARCHAR, '[^A-Za-z0-9]')) AS d
      FROM (
        SELECT DISTINCT ${qc} FROM ${quoteIdent(table)}
        WHERE ${qc} IS NOT NULL LIMIT ${SAMPLE_LIMIT}
      )
    `)
  ).toArray()[0] as { d: boolean | null };
  return r.d === true;
}

// Root and per-level widths from one code column per level, no delimiter.
export async function detectUndelimitedFormat(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, string>,
): Promise<CodeFormat> {
  const levels = [...levelColumns.keys()].sort((a, b) => a - b);
  const first = quoteIdent(levelColumns.get(levels[0])!);
  const roots = (
    (
      await conn.query(`--sql
        SELECT DISTINCT regexp_extract(${first}::VARCHAR, '^[^0-9]*') AS r
        FROM ${quoteIdent(table)} WHERE ${first} IS NOT NULL
      `)
    ).toArray() as Array<{ r: string }>
  ).map((r) => r.r);
  if (roots.length !== 1 || !roots[0]) {
    throw new Error(
      `${JSON.stringify(levelColumns.get(levels[0]))} does not share one non-numeric root (found ${JSON.stringify(roots.sort())}); set the root code explicitly`,
    );
  }
  const rootCode = roots[0];
  const widths: number[] = [];
  let parentSql = String(rootCode.length);
  for (const n of levels) {
    const column = levelColumns.get(n)!;
    const qc = quoteIdent(column);
    const found = (
      (
        await conn.query(`--sql
          SELECT DISTINCT length(${qc}::VARCHAR) - ${parentSql} AS w
          FROM ${quoteIdent(table)} WHERE ${qc} IS NOT NULL
        `)
      ).toArray() as Array<{ w: number | bigint }>
    ).map((r) => Number(r.w));
    if (found.length !== 1 || found[0] < 1) {
      throw new Error(
        `level ${n} (${JSON.stringify(column)}) codes add ${JSON.stringify(found.sort((a, b) => a - b))} characters to their parent's; without a delimiter each level needs one width`,
      );
    }
    widths.push(found[0]);
    parentSql = `length(${qc}::VARCHAR)`;
  }
  const minWidth = new Set(widths).size === 1 ? widths[0] : widths;
  return { rootCode, delimiter: "", minWidth };
}

// The single non-alphanumeric character common to every sampled code.
function detectDelimiter(codes: string[], codeColumn: string): string {
  let candidates: Set<string> | null = null;
  for (const code of codes) {
    const nonAlnum = new Set([...code].filter((c) => !/[a-zA-Z0-9]/.test(c)));
    if (candidates === null) {
      candidates = nonAlnum;
    } else {
      const prior: Set<string> = candidates;
      candidates = new Set([...prior].filter((c) => nonAlnum.has(c)));
    }
  }
  if (!candidates || candidates.size !== 1) {
    throw new Error(
      `could not infer a single recurring delimiter from ${JSON.stringify(codeColumn)}'s existing values: ${JSON.stringify(codeColumn)} may not be a formatted hierarchical code column`,
    );
  }
  return [...candidates][0];
}

// The shared first delimiter-split component across every sampled code.
function detectRoot(codes: string[], delimiter: string, codeColumn: string): string {
  const roots = new Set(codes.map((c) => c.split(delimiter)[0]));
  if (roots.size !== 1) {
    throw new Error(
      `${JSON.stringify(codeColumn)} does not share one constant root component (found ${JSON.stringify([...roots].sort())}); it may not be this dataset's own root-anchored hierarchy column`,
    );
  }
  return [...roots][0];
}

// Each position's most common width (first seen on ties); one number if all agree.
function detectMinWidth(codes: string[], delimiter: string, codeColumn: string): MinWidth {
  const byLevel: Array<Map<number, number>> = [];
  for (const code of codes) {
    code
      .split(delimiter)
      .slice(1)
      .forEach((part, i) => {
        if (i === byLevel.length) byLevel.push(new Map());
        byLevel[i].set(part.length, (byLevel[i].get(part.length) ?? 0) + 1);
      });
  }
  if (byLevel.length === 0) {
    throw new Error(
      `no delimited components found in ${JSON.stringify(codeColumn)} to measure width from`,
    );
  }
  const widths = byLevel.map((counts) => {
    let best = -1;
    let bestCount = -1;
    for (const [w, c] of counts) {
      if (c > bestCount) {
        best = w;
        bestCount = c;
      }
    }
    return best;
  });
  return new Set(widths).size === 1 ? widths[0] : widths;
}
