import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { quoteIdent, quoteLiteral, widthFor, type CodeFormat } from "$lib/db/code";
import type { SourceCodes } from "./assign";
import type { Level } from "./levels";

export interface CodeIssueRow {
  kind: string;
  level: number;
  parentCode: string;
  assignedCode: string;
  childCount: number;
  minWidth: number;
  reason: string;
}

// Groups each numbered level's codes by parent and flags any group over its width's
// capacity, skipping auto and embedded levels. Always (re)writes cc_issues, even empty.
export async function buildCodeIssues(
  conn: AsyncDuckDBConnection,
  table: string,
  levels: Map<number, Level>,
  fmt: CodeFormat,
  sourceCodes: SourceCodes,
  rootSql: string,
): Promise<CodeIssueRow[]> {
  const rows: CodeIssueRow[] = [];
  let parentSql = `${rootSql}::VARCHAR`;
  for (const level of [...levels.keys()].filter((n) => n >= 1).sort((a, b) => a - b)) {
    const { code, seeded } = levels.get(level)!;
    const qCode = quoteIdent(code);
    const width = widthFor(fmt, level);
    if (width === null || (sourceCodes === "embed" && !seeded)) {
      parentSql = qCode;
      continue;
    }
    const capacity = 10 ** width - 1;
    const groups = (
      await conn.query(`--sql
        SELECT ${parentSql} AS parent_code, COUNT(DISTINCT ${qCode}) AS n,
               max(struct_pack(l := length(${qCode}), c := ${qCode})).c AS assigned_code
        FROM ${quoteIdent(table)}
        GROUP BY 1
        HAVING COUNT(DISTINCT ${qCode}) > ${capacity}
        ORDER BY 1
      `)
    ).toArray() as Array<{ parent_code: string; n: number | bigint; assigned_code: string }>;
    for (const g of groups) {
      const count = Number(g.n);
      rows.push({
        kind: "digit-overflow",
        level,
        parentCode: g.parent_code,
        assignedCode: g.assigned_code,
        childCount: count,
        minWidth: width,
        reason: `${count} children exceeds ${capacity} at min_width=${width}`,
      });
    }
    parentSql = qCode;
  }

  await writeIssuesTable(conn, rows);
  return rows;
}

async function writeIssuesTable(conn: AsyncDuckDBConnection, rows: CodeIssueRow[]): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cc_issues");
  await conn.query(`--sql
    CREATE TABLE cc_issues (
      kind VARCHAR, level INTEGER, parent_code VARCHAR, assigned_code VARCHAR,
      child_count INTEGER, min_width INTEGER, reason VARCHAR
    )
  `);
  if (rows.length === 0) return;

  const values = rows
    .map(
      (r) =>
        `(${quoteLiteral(r.kind)}, ${r.level}, ${quoteLiteral(r.parentCode)}, ${quoteLiteral(r.assignedCode)}, ${r.childCount}, ${r.minWidth}, ${quoteLiteral(r.reason)})`,
    )
    .join(", ");
  await conn.query(`INSERT INTO cc_issues VALUES ${values}`);
}
