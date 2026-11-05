import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { parentPrefix, quoteIdent, widthFor, writeRootCode, type CodeFormat } from "$lib/db/code";
import type { ChangeRow } from "./assign";
import type { SideLevels } from "./levels";

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const BATCH = 500;

// Marks 'new'-outcome rows as 'overflow' when their parent's child count spills
// past that level's width capacity (never under auto); 'retained' rows stay as-is.
function flagOverflow(changelog: ChangeRow[], fmt: CodeFormat): void {
  const byParent = new Map<string, ChangeRow[]>();
  for (const row of changelog) {
    if ((row.codeOutcome !== "new" && row.codeOutcome !== "retained") || row.newCode === null)
      continue;
    const key = `${row.level}:${parentPrefix(row.newCode, fmt)}`;
    const group = byParent.get(key);
    if (group) group.push(row);
    else byParent.set(key, [row]);
  }
  for (const [key, rows] of byParent) {
    const sep = key.indexOf(":");
    const level = Number(key.slice(0, sep));
    const parentCode = key.slice(sep + 1);
    const width = widthFor(fmt, level);
    if (width === null || rows.length <= 10 ** width - 1) continue;
    const reason = `${rows.length} children under ${parentCode} at level ${level} exceeds ${10 ** width - 1} at min_width=${width}`;
    for (const row of rows) {
      if (row.codeOutcome === "new") {
        row.codeOutcome = "overflow";
        row.reason = reason;
      }
    }
  }
}

async function applyMapping(
  conn: AsyncDuckDBConnection,
  finestTable: string,
  mapping: string,
  targetCol: string,
  matchCol: string,
  rows: string[],
): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TEMP TABLE ${quoteIdent(mapping)} (raw_val VARCHAR, new_val VARCHAR)`,
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH).join(", ");
    await conn.query(`INSERT INTO ${quoteIdent(mapping)} VALUES ${slice}`);
  }
  await conn.query(`--sql
    UPDATE ${quoteIdent(finestTable)} t
    SET ${quoteIdent(targetCol)} = m.new_val
    FROM ${quoteIdent(mapping)} m
    WHERE t.${quoteIdent(matchCol)} = m.raw_val
  `);
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(mapping)}`);
}

// Join key is each level's raw value, since dissolved fids don't match the
// finest table's own row fids.
export async function writeOutputs(
  conn: AsyncDuckDBConnection,
  finestTable: string,
  sideA: SideLevels,
  sideB: SideLevels,
  newCodeByFid: Map<number, Map<number, string>>,
  rawValByFid: Map<number, Map<number, string>>,
  changelog: ChangeRow[],
  fmt: CodeFormat,
  predecessorField = "predecessor_code",
): Promise<void> {
  flagOverflow(changelog, fmt);

  const desc = await conn.query(`DESCRIBE ${quoteIdent(finestTable)}`);
  const existing = new Set(
    (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name),
  );

  const finest = Math.max(...sideA.columns.keys());
  const predecessorByBFid = new Map<number, string | null>();
  for (const row of changelog) {
    if (row.level === finest && row.bFid !== null)
      predecessorByBFid.set(row.bFid, row.predecessorCode);
  }

  if (!existing.has(predecessorField)) {
    await conn.query(
      `ALTER TABLE ${quoteIdent(finestTable)} ADD COLUMN ${quoteIdent(predecessorField)} VARCHAR`,
    );
    existing.add(predecessorField);
  }
  const finestRaw = rawValByFid.get(finest)!;
  const predRows = [...predecessorByBFid.entries()]
    .map(([bFid, predecessor]) => {
      const rawVal = finestRaw.get(bFid);
      if (rawVal === undefined) return null;
      return `(${sqlStr(rawVal)}, ${predecessor === null ? "NULL" : sqlStr(predecessor)})`;
    })
    .filter((v): v is string => v !== null);
  const finestRawCol = sideB.columns.get(finest)!;
  if (predRows.length > 0) {
    await applyMapping(
      conn,
      finestTable,
      "cu_out_map_predecessor",
      predecessorField,
      finestRawCol,
      predRows,
    );
  }

  for (const n of [...sideA.columns.keys()].sort((a, b) => a - b)) {
    const outputCol = sideA.columns.get(n)!;
    const rawCol = sideB.columns.get(n)!;
    if (!existing.has(outputCol)) {
      await conn.query(
        `ALTER TABLE ${quoteIdent(finestTable)} ADD COLUMN ${quoteIdent(outputCol)} VARCHAR`,
      );
      existing.add(outputCol);
    }
    const rawForLevel = rawValByFid.get(n)!;
    const rows = [...(newCodeByFid.get(n) ?? new Map()).entries()]
      .map(([fid, code]) => {
        const rawVal = rawForLevel.get(fid);
        if (rawVal === undefined) return null;
        return `(${sqlStr(rawVal)}, ${sqlStr(code)})`;
      })
      .filter((v): v is string => v !== null);
    if (rows.length > 0) {
      await applyMapping(conn, finestTable, `cu_out_map_${n}`, outputCol, rawCol, rows);
    }
  }

  if (sideA.schema !== null) {
    const rootName = sideA.schema.nameField.replace("{n}", "0");
    const after = existing.has(rootName) ? [rootName] : [sideA.columns.get(1), sideB.names.get(1)];
    const root = sideA.schema.codeField.replace("{n}", "0");
    await writeRootCode(conn, finestTable, root, fmt.rootCode, after);
  }
}

export async function buildChangelogTable(
  conn: AsyncDuckDBConnection,
  changelog: ChangeRow[],
): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cu_changelog");
  await conn.query(`--sql
    CREATE TABLE cu_changelog (
      level INTEGER, old_code VARCHAR, old_name VARCHAR, new_code VARCHAR,
      new_name VARCHAR, relationship_class VARCHAR, cluster_id INTEGER,
      match_method VARCHAR, code_outcome VARCHAR, reason VARCHAR
    )
  `);
  if (changelog.length === 0) return;
  const val = (s: string | null) => (s === null ? "NULL" : sqlStr(s));
  for (let i = 0; i < changelog.length; i += BATCH) {
    const values = changelog
      .slice(i, i + BATCH)
      .map(
        (r) =>
          `(${r.level}, ${val(r.oldCode)}, ${val(r.oldName)}, ${val(r.newCode)}, ${val(r.newName)}, ${sqlStr(r.relationshipClass)}, ${r.clusterId}, ${val(r.matchMethod)}, ${sqlStr(r.codeOutcome)}, ${sqlStr(r.reason)})`,
      )
      .join(", ");
    await conn.query(`INSERT INTO cu_changelog VALUES ${values}`);
  }
}
