import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { isNoiseColumn } from "$lib/tools/schema-map/pipeline/constants";
import type { CrosswalkRow } from "./crosswalk";

const RESERVED_NAMES = new Set(["fid", "geom", "geometry"]);

// A noise column counts only when `listed` in the crosswalk.
export async function actualColumns(
  conn: AsyncDuckDBConnection,
  listed: Set<string> = new Set(),
): Promise<Set<string>> {
  const desc = await conn.query("DESCRIBE layer_attr");
  const names = (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
  return new Set(names.filter((c) => c !== "fid" && (!isNoiseColumn(c) || listed.has(c))));
}

// Ports topo-tools' _validate_columns_match.
export function validateColumnsMatch(crosswalkColumns: Set<string>, actual: Set<string>): void {
  const missing = [...crosswalkColumns].filter((c) => !actual.has(c)).sort();
  const extra = [...actual].filter((c) => !crosswalkColumns.has(c)).sort();
  if (missing.length === 0 && extra.length === 0) return;

  const details: string[] = [];
  if (missing.length > 0) {
    details.push(`crosswalk references column(s) not in the file: ${JSON.stringify(missing)}`);
  }
  if (extra.length > 0) {
    details.push(`file has column(s) not decided in the crosswalk: ${JSON.stringify(extra)}`);
  }
  throw new Error(
    `crosswalk does not match the columns in the input file (${details.join("; ")}; stale crosswalk, or wrong input file?)`,
  );
}

// Per-row form of validateTargets, keyed by source column, for inline feedback.
export function targetIssues(crosswalk: CrosswalkRow[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const r of crosswalk) {
    if (r.targetColumn) counts.set(r.targetColumn, (counts.get(r.targetColumn) ?? 0) + 1);
  }
  const issues = new Map<string, string>();
  for (const r of crosswalk) {
    const t = r.targetColumn;
    if (!t) continue;
    if (RESERVED_NAMES.has(t.toLowerCase()))
      issues.set(r.sourceColumn, `"${t}" is a reserved name`);
    else if (counts.get(t)! > 1) issues.set(r.sourceColumn, `"${t}" is used by another column`);
  }
  return issues;
}

// Ports topo-tools' _validate_targets, except reserved-name collision is
// checked case-insensitively per this port's own spec, not python's exact-case check.
export function validateTargets(crosswalk: CrosswalkRow[]): void {
  const targets = crosswalk.map((r) => r.targetColumn).filter((t): t is string => !!t);
  const dupes = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))].sort();
  const reservedHits = [
    ...new Set(targets.filter((t) => RESERVED_NAMES.has(t.toLowerCase()))),
  ].sort();
  if (dupes.length === 0 && reservedHits.length === 0) return;

  const details: string[] = [];
  if (dupes.length > 0) {
    details.push(`target_column value(s) used more than once: ${JSON.stringify(dupes)}`);
  }
  if (reservedHits.length > 0) {
    details.push(
      `target_column value(s) collide with reserved names: ${JSON.stringify(reservedHits)}`,
    );
  }
  throw new Error(`crosswalk has invalid target_column value(s) (${details.join("; ")})`);
}
