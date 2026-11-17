import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildFlagged, flaggedLayer, flaggedUnitsSql, type FlaggedLayer } from "$lib/db/flagged";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { runSchemaChecks } from "./checks";
import { SEVERITY, type SchemaIssueKind, type Severity } from "./constants";
import { buildSchemaLevels } from "./levels";

export type { SchemaIssueKind, Severity } from "./constants";

export const REPORT_COLUMNS = ["key", "kind", "severity", "level", "column", "code", "reason"];

export interface SchemaIssueRow {
  key: string;
  kind: SchemaIssueKind;
  severity: Severity;
  level: number | null;
  column: string | null;
  code: string | null;
  reason: string;
}

export interface SchemaResult {
  issues: SchemaIssueRow[];
  map: FlaggedLayer;
}

// Writes `${prefix}_report` over layer_attr's columns, one row per finding.
export async function runSchemaDetect(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  prefix = "sd",
): Promise<SchemaResult> {
  await buildSchemaLevels(conn, "layer_attr", prefix, schema);
  await runSchemaChecks(conn, prefix, "layer_attr", schema);
  const severity = Object.entries(SEVERITY)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(" ");
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${prefix}_report AS
    SELECT kind || '-' || row_number() OVER (
             PARTITION BY kind ORDER BY level, column_name, code
           ) AS key,
           kind, CASE kind ${severity} END AS severity, level,
           column_name AS "column", code, reason
    FROM ${prefix}_03
    ORDER BY severity, level, kind, "column", code
  `);
  const rows = (await conn.query(`SELECT * FROM ${prefix}_report`)).toArray() as Array<
    Record<string, unknown>
  >;
  const codeColumns = (
    (
      await conn.query(
        `SELECT level, column_name AS column FROM ${prefix}_02 WHERE is_code AND problem IS NULL`,
      )
    ).toArray() as Array<{ level: number; column: string }>
  ).map((r) => ({ level: Number(r.level), column: r.column }));
  await buildFlagged(conn, `${prefix}_flagged`, `${prefix}_report`, "layer_attr", codeColumns, [
    "code",
  ]);
  return {
    issues: rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as SchemaIssueKind,
      severity: r.severity as Severity,
      level: r.level === null ? null : Number(r.level),
      column: (r.column as string | null) ?? null,
      code: (r.code as string | null) ?? null,
      reason: r.reason as string,
    })),
    map: await flaggedLayer(conn, flaggedUnitsSql(`${prefix}_flagged`, `${prefix}_report`)),
  };
}
