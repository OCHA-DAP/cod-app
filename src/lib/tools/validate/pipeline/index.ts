import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { GEOMETRY_TYPE } from "$lib/db/constants";
import { flaggedLayer, type FlaggedLayer } from "$lib/db/flagged";
import { runCodeDetect } from "$lib/tools/code-detect/pipeline/index";
import { runNameDetect } from "$lib/tools/name-detect/pipeline/index";
import { runSchemaDetect } from "$lib/tools/schema-detect/pipeline/index";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
import { computeBounds, scanTopology } from "$lib/tools/topo-detect/pipeline/index";

// Ported from topo-tools' core/validate and api/validate.py.

export const STAGES = ["schema", "topo", "code", "name"] as const;
export type Stage = (typeof STAGES)[number];

// A gap may be a real enclosed hole (an enclave), so only it is a warning.
const TOPO_SEVERITY: Record<string, string> = {
  gap: "warn",
  overlap: "error",
  "micro-polygon": "error",
};

// A schema finding that leaves Code Detect and Name Detect nothing to check.
const BLOCKING_KINDS = ["levels-undetected"];

const REPORTS: Record<Stage, { table: string; suffix: string }> = {
  schema: { table: "sd_report", suffix: "_schema_issues.csv" },
  topo: { table: "dt_issues", suffix: "_topo_issues.parquet" },
  code: { table: "cd_report", suffix: "_code_issues.csv" },
  name: { table: "nd_report", suffix: "_name_issues.csv" },
};

export const SUMMARY_COLUMNS = ["stage", "kind", "severity", "count", "report", "reason"];

export interface SummaryRow {
  key: string;
  stage: Stage;
  kind: string;
  severity: string;
  count: number | null;
  report: string | null;
  reason: string;
}

export interface ValidateResult {
  issues: SummaryRow[];
  ran: Stage[];
  map: FlaggedLayer;
}

const lit = (v: string | null): string => (v === null ? "NULL" : "'" + v.replace(/'/g, "''") + "'");

// Each flagged unit or topology region, keyed `stage:kind` like its summary row; the map colors
// topology regions by kind and units by severity.
function stageUnitsSql(stage: Stage): string {
  if (stage === "topo") return `SELECT 'topo:' || kind AS key, NULL::VARCHAR AS severity, kind, geom FROM dt_issues`;
  const p = REPORTS[stage].table.replace(/_report$/, "");
  return `--sql
    SELECT DISTINCT '${stage}:' || r.kind AS key, r.severity, NULL::VARCHAR AS kind, g.geom
    FROM ${p}_flagged f JOIN ${p}_report r USING (key) JOIN layer_01 g USING (fid)
  `;
}

// Writes vd_summary: every stage's issues counted by kind and severity.
export async function runValidate(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
  stem: string,
): Promise<ValidateResult> {
  const runs: Record<Stage, () => Promise<unknown>> = {
    schema: () => runSchemaDetect(conn, schema),
    topo: async () => {
      await computeBounds(conn);
      await scanTopology(conn);
    },
    code: () => runCodeDetect(conn, schema),
    name: () => runNameDetect(conn, schema),
  };
  await conn.query(`--sql
    CREATE OR REPLACE TABLE vd_summary (
      stage VARCHAR, kind VARCHAR, severity VARCHAR, count INTEGER, report VARCHAR, reason VARCHAR
    )
  `);
  const outcome = (stage: Stage, kind: string, severity: string, reason: string) =>
    conn.query(
      `INSERT INTO vd_summary VALUES (${[stage, kind, severity].map(lit).join(", ")}, NULL, NULL, ${lit(reason)})`,
    );
  const ran: Stage[] = [];
  let blocked = false;
  for (const stage of STAGES) {
    if (blocked && (stage === "code" || stage === "name")) {
      await outcome(stage, "skipped", "warn", "levels could not be detected; see the schema report");
      continue;
    }
    try {
      await runs[stage]();
    } catch (e) {
      // One failing stage must not hide the rest.
      console.warn(`${stage} detect failed`, e);
      await outcome(stage, "failed", "error", e instanceof Error ? e.message : String(e));
      continue;
    }
    ran.push(stage);
    const { table, suffix } = REPORTS[stage];
    const report = lit(stem + suffix);
    const severity =
      stage === "topo"
        ? `CASE kind ${Object.entries(TOPO_SEVERITY)
            .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
            .join(" ")} ELSE 'error' END`
        : "severity";
    await conn.query(`--sql
      INSERT INTO vd_summary
      SELECT '${stage}', kind, ${severity}, count(*), ${report}, NULL FROM ${table} GROUP BY ALL
    `);
    await conn.query(`--sql
      INSERT INTO vd_summary
      SELECT '${stage}', NULL, NULL, 0, ${report}, 'no issues'
      WHERE NOT EXISTS (SELECT 1 FROM vd_summary WHERE stage = '${stage}')
    `);
    if (stage === "schema") {
      const hit = await conn.query(
        `SELECT count(*) > 0 AS hit FROM vd_summary WHERE stage = 'schema' AND kind IN (${BLOCKING_KINDS.map(lit).join(", ")})`,
      );
      blocked = Boolean((hit.toArray()[0] as { hit: boolean }).hit);
    }
  }
  const order = `list_position([${STAGES.map((s) => `'${s}'`).join(", ")}], stage), severity, kind`;
  await conn.query(`CREATE OR REPLACE TABLE vd_summary AS SELECT * FROM vd_summary ORDER BY ${order}`);
  const rows = (await conn.query(`SELECT * FROM vd_summary`)).toArray() as Array<
    Record<string, unknown>
  >;
  return {
    issues: rows.map((r) => ({
      key: `${r.stage}:${r.kind ?? ""}`,
      stage: r.stage as Stage,
      kind: (r.kind as string | null) ?? "",
      severity: (r.severity as string | null) ?? "",
      count: r.count === null ? null : Number(r.count),
      report: (r.report as string | null) ?? null,
      reason: (r.reason as string | null) ?? "",
    })),
    ran,
    map: await flaggedLayer(conn, ran.map(stageUnitsSql).join(" UNION ALL ") || NO_UNITS),
  };
}

const NO_UNITS = `SELECT NULL::VARCHAR AS key, NULL::${GEOMETRY_TYPE} AS geom WHERE false`;
