import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { NOTE_SUPPLEMENTAL, WINNER_MAX_COLLAPSE_RATIO } from "./constants";
import { resolveColumns, type ResolvedColumn } from "./inference";
import { commonPrefixSuffix } from "./naming";
import { quoteIdent, spatiallyCoherent } from "./queries";
import { DEFAULT_TARGET_SCHEMA } from "./targetSchema";

export interface LevelColumns {
  groupBy: string[];
  identityColumns: string[];
  hasCode: boolean;
  nameColumn: string | null;
  isRoot?: boolean;
}

const MIN_LEVELS_TO_DIFF = 2;
const LEVEL_DIGIT_RE = /\d+/;
const MIN_PAIRS_FOR_LEAF_TOLERANCE = 2;

export type Anchor = [string, string, string];

// Each level's own (prefix, anchor, suffix) split, diffed against every other.
function levelAnchors(codeColumns: Map<number, string>): Map<number, Anchor> {
  if (codeColumns.size < MIN_LEVELS_TO_DIFF) return new Map();
  const [prefix, suffix] = commonPrefixSuffix([...codeColumns.values()]);
  const anchors = new Map<number, Anchor>();
  for (const [level, name] of codeColumns) {
    const anchor = name.slice(prefix.length, name.length - suffix.length);
    if (anchor) anchors.set(level, [prefix, anchor, suffix]);
  }
  return anchors;
}

export function isLevelIdentityColumn(
  name: string,
  prefix: string,
  anchor: string,
  suffix: string,
): boolean {
  return name.startsWith(prefix + anchor) || name.endsWith(anchor + suffix);
}

function stripAnchor(column: string, prefix: string, anchor: string, suffix: string): string {
  if (column.startsWith(prefix + anchor)) return column.slice(prefix.length + anchor.length);
  return column.slice(0, column.length - anchor.length - suffix.length);
}

function maxCardinalityColumn(rows: Map<string, ResolvedColumn>, columns: string[]): string {
  return columns.reduce((best, c) =>
    rows.get(c)!.uniqueCount > rows.get(best)!.uniqueCount ? c : best,
  );
}

function sharedLength(names: string[]): number {
  const [prefix, suffix] = commonPrefixSuffix(names);
  return prefix.length + suffix.length;
}

// Each level's column to diff naming anchors on, sharing the most text.
function anchorColumns(
  groupByByLevel: Map<number, string[]>,
  codes: Map<number, string>,
): Map<number, string> {
  if (codes.size < MIN_LEVELS_TO_DIFF) return codes;
  let best = codes;
  let bestLength = sharedLength([...codes.values()]);
  let referenceLevel = groupByByLevel.keys().next().value!;
  for (const [level, cols] of groupByByLevel) {
    if (cols.length < groupByByLevel.get(referenceLevel)!.length) referenceLevel = level;
  }
  for (const reference of groupByByLevel.get(referenceLevel)!) {
    const picked = new Map<number, string>();
    for (const [level, cols] of groupByByLevel) {
      picked.set(
        level,
        cols.reduce((m, c) =>
          sharedLength([reference, c]) > sharedLength([reference, m]) ? c : m,
        ),
      );
    }
    picked.set(referenceLevel, reference);
    const length = sharedLength([...picked.values()]);
    if (length > bestLength) {
      best = picked;
      bestLength = length;
    }
  }
  return best;
}

interface ResolvedLevels {
  rows: Map<string, ResolvedColumn>;
  codes: Map<number, string>;
  anchors: Map<number, Anchor>;
  display: Map<number, number>;
}

// Rows, each level's code, naming anchor, and display number.
async function resolveLevels(conn: AsyncDuckDBConnection, table: string): Promise<ResolvedLevels> {
  const rows = await resolveColumns(conn, table, DEFAULT_TARGET_SCHEMA);
  const groupByByLevel = new Map<number, string[]>();
  for (const [source, row] of rows) {
    if (row.level !== null && row.role !== null) {
      if (!groupByByLevel.has(row.level)) groupByByLevel.set(row.level, []);
      groupByByLevel.get(row.level)!.push(source);
    }
  }
  const codes = new Map<number, string>();
  for (const [level, cols] of groupByByLevel) codes.set(level, maxCardinalityColumn(rows, cols));
  const anchors = levelAnchors(anchorColumns(groupByByLevel, codes));
  return { rows, codes, anchors, display: displayLevels(codes, anchors) };
}

// Each displayed level's (prefix, anchor, suffix) naming split.
export async function detectLevelAnchors(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, Anchor>> {
  const { anchors, display } = await resolveLevels(conn, table);
  const out = new Map<number, Anchor>();
  for (const [level, a] of anchors) out.set(display.get(level) ?? level, a);
  return out;
}

async function isFunctionallyDependent(
  conn: AsyncDuckDBConnection,
  table: string,
  canonicalColumn: string,
  column: string,
): Promise<boolean> {
  const qCanon = quoteIdent(canonicalColumn);
  const qOther = quoteIdent(column);
  const r = await conn.query(`
    SELECT MAX(variant_count) AS v FROM (
      SELECT COUNT(DISTINCT ${qOther}) FILTER (WHERE ${qOther} IS NOT NULL) AS variant_count
      FROM ${table}
      WHERE ${qCanon} IS NOT NULL
      GROUP BY ${qCanon}
    )
  `);
  const row = r.toArray()[0] as { v: number | bigint | null };
  return row.v == null || Number(row.v) <= 1;
}

// Renumbers each level to its own naming-anchor digit, when consistent;
// falls back to the structural level itself when no digit or unordered.
function displayLevels(
  codes: Map<number, string>,
  anchors: Map<number, Anchor>,
): Map<number, number> {
  const ordered = [...codes.keys()].sort((a, b) => a - b);
  const identity = new Map(ordered.map((l) => [l, l]));
  const digits: number[] = [];
  for (const level of ordered) {
    const source = anchors.has(level) ? anchors.get(level)![1] : codes.get(level)!;
    const match = LEVEL_DIGIT_RE.exec(source);
    if (match === null) return identity;
    digits.push(Number(match[0]));
  }
  const sortedDigits = [...digits].sort((a, b) => a - b);
  const isSorted = digits.every((d, i) => d === sortedDigits[i]);
  const isUnique = new Set(digits).size === digits.length;
  if (!isSorted || !isUnique) return identity;
  const result = new Map<number, number>();
  ordered.forEach((level, i) => result.set(level, digits[i]));
  return result;
}

async function tableColumnNames(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

// Every column structurally tied to each admin level, in no particular naming.
export async function detectLevelColumns(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, LevelColumns>> {
  const { rows, codes, anchors, display } = await resolveLevels(conn, table);

  const allColumnsByLevel = new Map<number, string[]>();
  const groupByByLevel = new Map<number, string[]>();
  for (const [source, row] of rows) {
    if (row.level === null) continue;
    if (!allColumnsByLevel.has(row.level)) allColumnsByLevel.set(row.level, []);
    allColumnsByLevel.get(row.level)!.push(source);
    if (row.role !== null) {
      if (!groupByByLevel.has(row.level)) groupByByLevel.set(row.level, []);
      groupByByLevel.get(row.level)!.push(source);
    }
  }
  if (allColumnsByLevel.size === 0) {
    throw new Error(`no admin hierarchy level detected in ${table}`);
  }

  const assigned = new Set<string>();
  for (const cols of allColumnsByLevel.values()) for (const c of cols) assigned.add(c);
  const tableColumns = await tableColumnNames(conn, table);

  const rootLevel = Math.min(...allColumnsByLevel.keys());
  const result = new Map<number, LevelColumns>();
  for (const level of [...allColumnsByLevel.keys()].sort((a, b) => a - b)) {
    const groupBy = [...(groupByByLevel.get(level) ?? [])];
    // The root has no parent to embed, so its own shape is never diagnostic.
    const hasCode =
      level === rootLevel ||
      allColumnsByLevel.get(level)!.some((c) => rows.get(c)!.role === "code");
    const nameColumn =
      allColumnsByLevel.get(level)!.find((c) => rows.get(c)!.role === "name") ?? null;
    if (!anchors.has(level)) {
      result.set(level, {
        groupBy,
        identityColumns: [...allColumnsByLevel.get(level)!],
        hasCode,
        nameColumn,
      });
      continue;
    }

    const [prefix, anchor, suffix] = anchors.get(level)!;
    const completed: string[] = [];
    for (const c of tableColumns) {
      if (assigned.has(c)) continue;
      if (!isLevelIdentityColumn(c, prefix, anchor, suffix)) continue;
      if (await isFunctionallyDependent(conn, table, codes.get(level)!, c)) completed.push(c);
    }
    for (const c of completed) assigned.add(c);
    const identity = allColumnsByLevel
      .get(level)!
      .filter((c) => isLevelIdentityColumn(c, prefix, anchor, suffix))
      .concat(completed);
    result.set(level, {
      groupBy: groupBy.concat(completed),
      identityColumns: identity,
      hasCode,
      nameColumn,
    });
  }

  const displayed = new Map<number, LevelColumns>();
  for (const [level, v] of result) displayed.set(display.get(level) ?? level, v);
  const leaf = await detectLeafLevel(conn, table, displayed);
  if (leaf !== null) displayed.set(Math.max(...displayed.keys()) + 1, leaf);
  return displayed;
}

// detectLevelColumns, falling back to one ungrouped level for zero evidence.
export async function detectLevelColumnsOrSingle(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, LevelColumns>> {
  try {
    return await detectLevelColumns(conn, table);
  } catch {
    return new Map([[0, { groupBy: [], identityColumns: [], hasCode: true, nameColumn: null }]]);
  }
}

// Each level's least-collapsed column, never a bracketed/supplemental one.
export async function detectLevelCodes(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, string>> {
  const { codes, display } = await resolveLevels(conn, table);
  if (codes.size === 0) {
    throw new Error(`no admin hierarchy code column detected in ${table}`);
  }
  const result = new Map<number, string>();
  for (const [level, column] of codes) result.set(display.get(level) ?? level, column);
  return result;
}

// Columns detection set aside as a coarser grouping, never as a level.
export async function supplementalColumns(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<string[]> {
  const rows = await resolveColumns(conn, table, DEFAULT_TARGET_SCHEMA);
  return [...rows].filter(([, r]) => r.note.startsWith(NOTE_SUPPLEMENTAL)).map(([c]) => c);
}

// Supplemental columns whose groups cluster on the map (geomTable's geom, by fid),
// as a missed level would.
export async function levelLikeColumns(
  conn: AsyncDuckDBConnection,
  table: string,
  geomTable: string,
): Promise<string[]> {
  const located = `(SELECT t.*, g.geom FROM ${quoteIdent(table)} t JOIN ${quoteIdent(geomTable)} g USING (fid))`;
  const found: string[] = [];
  for (const c of await supplementalColumns(conn, table)) {
    if (await spatiallyCoherent(conn, located, c)) found.push(c);
  }
  return found;
}

// Find an unassigned family's (prefix, anchor, suffix), or null if ambiguous.
export async function rootAnchor(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<Anchor | null> {
  const anchors = await detectLevelAnchors(conn, table);
  if (anchors.size === 0) return null;
  const [prefix, , suffix] = anchors.values().next().value!;
  const usedAnchors = new Set([...anchors.values()].map(([, a]) => a));

  const tableColumns = await tableColumnNames(conn, table);
  const assigned = new Set<string>();
  for (const cols of levelColumns.values()) for (const c of cols.identityColumns) assigned.add(c);

  const candidateAnchors = new Set<string>();
  for (const c of tableColumns) {
    if (assigned.has(c) || !c.startsWith(prefix) || !c.endsWith(suffix)) continue;
    if (c.length <= prefix.length + suffix.length) continue;
    candidateAnchors.add(c.slice(prefix.length, c.length - suffix.length));
  }
  for (const u of usedAnchors) candidateAnchors.delete(u);
  let candidates = [...candidateAnchors];
  if ([...usedAnchors].every((a) => /^\d+$/.test(a))) {
    // Only a coarser digit can be a root; stray columns like adm_lvl never are.
    const coarsest = Math.min(...[...usedAnchors].map(Number));
    candidates = candidates.filter((a) => /^\d+$/.test(a) && Number(a) < coarsest);
  }
  const held: string[] = [];
  for (const a of candidates) {
    if (await hasValue(conn, table, prefix + a + suffix)) held.push(a);
  }
  if (held.length !== 1) return null;
  return [prefix, held[0], suffix];
}

async function hasValue(
  conn: AsyncDuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await conn.query(
    `SELECT 1 FROM ${table} WHERE ${quoteIdent(column)} IS NOT NULL LIMIT 1`,
  );
  return r.numRows > 0;
}

// A coarser, whole-table-constant level named like the detected levels, numbered by its
// own digit when coarser, else one above the coarsest; returns [level, columns].
export async function detectRootLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<[number, LevelColumns] | null> {
  if (levelColumns.size === 0 || Math.min(...levelColumns.keys()) < 1) return null;
  const root = await rootAnchor(conn, table, levelColumns);
  if (root === null) return null;
  const [prefix, anchor, suffix] = root;
  const coarsest = Math.min(...levelColumns.keys());
  const digit = LEVEL_DIGIT_RE.exec(anchor);
  let level = digit ? Number(digit[0]) : coarsest - 1;
  if (level >= coarsest) level = coarsest - 1;

  const tableColumns = await tableColumnNames(conn, table);
  const assigned = new Set<string>();
  for (const cols of levelColumns.values()) for (const c of cols.identityColumns) assigned.add(c);
  const candidates = tableColumns.filter(
    (c) => !assigned.has(c) && isLevelIdentityColumn(c, prefix, anchor, suffix),
  );
  if (candidates.length === 0) return null;

  const select = candidates
    .map(
      (c, i) =>
        `COUNT(DISTINCT ${quoteIdent(c)}) FILTER (WHERE ${quoteIdent(c)} IS NOT NULL) AS "__ra_${i}"`,
    )
    .join(", ");
  const r = await conn.query(`SELECT ${select} FROM ${table}`);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const counts = candidates.map((_c, i) => Number(row[`__ra_${i}`]));
  if (!counts.includes(1)) return null;
  const rootColumns = candidates.filter((_c, i) => counts[i] <= 1);
  return [
    level,
    { groupBy: [], identityColumns: rootColumns, hasCode: true, nameColumn: null, isRoot: true },
  ];
}

// detectLevelColumnsOrSingle, plus a whole-table-constant root level.
export async function detectLevelsWithRoot(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<number, LevelColumns>> {
  const levelColumns = await detectLevelColumnsOrSingle(conn, table);
  const root = await detectRootLevel(conn, table, levelColumns);
  if (root === null) return levelColumns;
  return new Map([[root[0], root[1]], ...levelColumns]);
}

// Each level's own code and name column as `code`/`name`, without anchors.
export function fallbackFamilies(
  levelColumns: Map<number, LevelColumns>,
  levels: number[],
): Map<string, Map<number, string>> {
  const families = new Map<string, Map<number, string>>();
  const put = (kind: string, n: number, column: string) => {
    if (!families.has(kind)) families.set(kind, new Map());
    families.get(kind)!.set(n, column);
  };
  for (const n of levels) {
    const cols = levelColumns.get(n);
    if (cols === undefined) continue;
    const code = cols.groupBy.find((c) => c !== cols.nameColumn);
    if (code !== undefined) put("code", n, code);
    if (cols.nameColumn !== null) put("name", n, cols.nameColumn);
  }
  return families;
}

// Each level's code column; a constant root's sits in the next level's code family.
export function levelCodeColumns(
  levelColumns: Map<number, LevelColumns>,
  families: Map<string, Map<number, string>>,
  levels: number[],
): (string | null)[] {
  const codes = new Map<number, string | null>();
  for (const [n, c] of levelColumns) if (c.groupBy.length) codes.set(n, c.groupBy[0]);
  const root = [...levelColumns].find(([, c]) => c.isRoot)?.[0];
  if (root !== undefined && codes.size) {
    const first = Math.min(...codes.keys());
    const below = levelColumns.get(first)!;
    const nextCode = below.groupBy.find((c) => c !== below.nameColumn) ?? codes.get(first)!;
    const family = [...families.values()].find((perLevel) => perLevel.get(first) === nextCode);
    codes.set(root, family?.get(root) ?? null);
  }
  return levels.map((n) => codes.get(n) ?? null);
}

// (parentColumn, column) pairs are each distinct, tolerating noise.
async function isParentScopedUnique(
  conn: AsyncDuckDBConnection,
  table: string,
  parentColumn: string,
  column: string,
): Promise<boolean> {
  const qp = quoteIdent(parentColumn);
  const qc = quoteIdent(column);
  const r = await conn.query(`
    SELECT COUNT(*) AS populated, COUNT(DISTINCT (${qp}, ${qc})) AS combos
    FROM ${table}
    WHERE ${qc} IS NOT NULL
  `);
  const row = r.toArray()[0] as Record<string, number | bigint>;
  const populated = Number(row.populated);
  if (populated === 0) return false;
  const tolerance = populated > MIN_PAIRS_FOR_LEAF_TOLERANCE ? 1 : 0;
  return populated - Number(row.combos) <= tolerance;
}

// A finer, name-only level one past the deepest one found, mirroring
// detectRootLevel, checked unique scoped to its own parent.
export async function detectLeafLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<LevelColumns | null> {
  const realLevels = [...levelColumns.keys()].filter((k) => k !== 0);
  if (realLevels.length === 0) return null;
  const deepest = Math.max(...realLevels);
  const parentCode = (await detectLevelCodes(conn, table)).get(deepest);
  if (parentCode === undefined) return null;

  const families = await groupFamiliesByLevel(conn, table, levelColumns);
  const tableColumns = await tableColumnNames(conn, table);
  const assigned = new Set<string>();
  for (const cols of levelColumns.values()) for (const c of cols.identityColumns) assigned.add(c);
  const candidates = new Set<string>();
  for (const perLevel of families.values()) {
    const anchors = levelAnchors(perLevel);
    const a = anchors.get(deepest);
    if (a === undefined) continue;
    const [prefix, anchor, suffix] = a;
    const match = LEVEL_DIGIT_RE.exec(anchor);
    if (match === null) continue;
    const nextAnchor = String(Number(match[0]) + 1);
    for (const c of tableColumns) {
      if (!assigned.has(c) && isLevelIdentityColumn(c, prefix, nextAnchor, suffix)) {
        candidates.add(c);
      }
    }
  }
  const valid: string[] = [];
  for (const c of [...candidates].sort()) {
    if (await isParentScopedUnique(conn, table, parentCode, c)) valid.push(c);
  }
  if (valid.length === 0) return null;
  return { groupBy: valid, identityColumns: valid, hasCode: false, nameColumn: valid[0] };
}

// Groups every level's identity columns by shared naming kind, across levels.
export async function groupFamiliesByLevel(
  conn: AsyncDuckDBConnection,
  table: string,
  levelColumns: Map<number, LevelColumns>,
): Promise<Map<string, Map<number, string>>> {
  const anchors = await detectLevelAnchors(conn, table);
  const rootLevel = [...levelColumns].find(([, c]) => c.isRoot)?.[0];
  if (rootLevel !== undefined && !anchors.has(rootLevel)) {
    const realLevels = new Map([...levelColumns].filter(([, c]) => !c.isRoot));
    const root = await rootAnchor(conn, table, realLevels);
    if (root !== null) anchors.set(rootLevel, root);
  }
  const families = new Map<string, Map<number, string>>();
  for (const [level, cols] of levelColumns) {
    if (!anchors.has(level)) continue;
    const [prefix, anchor, suffix] = anchors.get(level)!;
    for (const column of cols.identityColumns) {
      const kind = stripAnchor(column, prefix, anchor, suffix);
      if (!families.has(kind)) families.set(kind, new Map());
      families.get(kind)!.set(level, column);
    }
  }
  return families;
}

// Maps this level's own identity columns to a name shared across levels.
export function levelFamilyNames(
  families: Map<string, Map<number, string>>,
  level: number,
  codeColumn: string | null,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [kind, perLevel] of families) {
    const column = perLevel.get(level);
    if (column === undefined) continue;
    const stripped = kind.replace(/^_+|_+$/g, "");
    const generic = stripped || (column === codeColumn ? "code" : "name");
    names.set(column, generic);
  }
  return names;
}

// Throws if a cluster member takes more than one non-null value per group
// (per-column, not a raw tuple count: that treats an all-NULL row as a group).
export async function verifyFunctionalCluster(
  conn: AsyncDuckDBConnection,
  table: string,
  canonicalColumn: string,
  cluster: string[],
  parentColumn: string | null = null,
): Promise<void> {
  for (const other of cluster) {
    if (other === canonicalColumn) continue;
    if (!(await isFunctionallyDependent(conn, table, canonicalColumn, other))) {
      throw new Error(
        `${table}: grouping by ${JSON.stringify(cluster)} fragments ${JSON.stringify(canonicalColumn)}; ${JSON.stringify(other)} takes more than one non-null value within a group`,
      );
    }
  }
  if (parentColumn !== null) {
    await verifyNoCoarserMember(conn, table, canonicalColumn, cluster, parentColumn);
  }
}

// Throws if a member collapses the level's own units under each parent.
async function verifyNoCoarserMember(
  conn: AsyncDuckDBConnection,
  table: string,
  canonicalColumn: string,
  cluster: string[],
  parentColumn: string,
): Promise<void> {
  const parent = quoteIdent(parentColumn);
  const canonical = quoteIdent(canonicalColumn);
  for (const other of cluster) {
    if (other === canonicalColumn) continue;
    const member = quoteIdent(other);
    // Only rows where the member has a value: an empty alternate-name column
    // would otherwise count as one value per parent.
    const r = await conn.query(`
      SELECT COUNT(DISTINCT (${parent}, ${canonical})) AS units,
             COUNT(DISTINCT (${parent}, ${member})) AS vals
      FROM ${table}
      WHERE ${member} IS NOT NULL
    `);
    const row = r.toArray()[0] as Record<string, number | bigint>;
    const units = Number(row.units);
    const values = Number(row.vals);
    if (units && 1 - values / units > WINNER_MAX_COLLAPSE_RATIO) {
      throw new Error(
        `${table}: ${JSON.stringify(other)} (${values} values under ${JSON.stringify(parentColumn)}) groups ${JSON.stringify(canonicalColumn)} (${units}), a coarser level merged into this one; set the name and code fields explicitly`,
      );
    }
  }
}
