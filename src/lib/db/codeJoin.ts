import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Optional code-join precedence with spatial fallback, shared by
// assignOne.ts and match/pipeline/assign.ts (docs/adr/0045).

export const CODE_MISMATCH_REASON =
  "code join picked a different overlay polygon than spatial majority";
export const CODE_FALLBACK_REASON = "no matching code; fell back to spatial majority";

export interface MatchColumnOptions {
  matchColumn?: string;
  overlayMatchColumn?: string;
  inputMatchColumn?: string;
}

export interface ResolvedMatchColumns {
  overlayMatchColumn: string;
  inputMatchColumn: string;
}

export type AssignmentMethod = "code" | "spatial_fallback";

// `matchColumn` and `overlayMatchColumn`/`inputMatchColumn` are mutually
// exclusive (docs/reference/shared.md). Null return means no code join.
export function resolveMatchColumns(opts: MatchColumnOptions): ResolvedMatchColumns | null {
  const { matchColumn, overlayMatchColumn, inputMatchColumn } = opts;
  if (matchColumn != null) {
    if (overlayMatchColumn != null || inputMatchColumn != null) {
      throw new Error(
        "matchColumn is mutually exclusive with overlayMatchColumn/inputMatchColumn.",
      );
    }
    return { overlayMatchColumn: matchColumn, inputMatchColumn: matchColumn };
  }
  if (overlayMatchColumn != null || inputMatchColumn != null) {
    if (overlayMatchColumn == null || inputMatchColumn == null) {
      throw new Error("overlayMatchColumn and inputMatchColumn must both be given.");
    }
    return { overlayMatchColumn, inputMatchColumn };
  }
  return null;
}

interface CodeCandidatesOptions {
  inputAttrTable: string;
  overlayAttrTable: string;
  pairsTable: string;
  pairsInputCol: string;
  pairsOverlayCol: string;
  columns: ResolvedMatchColumns;
}

// Exact code join restricted to pairs already in pairsTable: a code match
// against a non-overlapping overlay feature doesn't count (docs/adr/0045).
function codeCandidatesSql(o: CodeCandidatesOptions): string {
  const inputCol = JSON.stringify(o.columns.inputMatchColumn);
  const overlayCol = JSON.stringify(o.columns.overlayMatchColumn);
  return `
    SELECT c.fid AS input_fid, p.fid AS overlay_fid
    FROM ${o.inputAttrTable} c
    JOIN ${o.overlayAttrTable} p ON c.${inputCol} = p.${overlayCol}
    JOIN ${o.pairsTable} pr ON pr.${o.pairsInputCol} = c.fid AND pr.${o.pairsOverlayCol} = p.fid
  `;
}

// Per-input-feature code winner (match's granularity): one candidate overlay feature per
// input feature, ties broken by the lowest overlay feature fid.
export async function buildPerInputCodeWinners(
  conn: AsyncDuckDBConnection,
  o: CodeCandidatesOptions & { outputTable: string },
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${o.outputTable} AS
    SELECT input_fid, overlay_fid FROM (
      SELECT input_fid, overlay_fid,
             ROW_NUMBER() OVER (PARTITION BY input_fid ORDER BY overlay_fid ASC) AS rn
      FROM (${codeCandidatesSql(o)})
    ) WHERE rn = 1
  `);
}

// Per-file/run code vote (assign-one granularity): winning overlay feature by count
// of code-matched input features, ties broken by the lowest overlay feature fid.
export async function pickFileCodeWinner(
  conn: AsyncDuckDBConnection,
  o: CodeCandidatesOptions,
): Promise<number | null> {
  const rows = (
    await conn.query(`--sql
      SELECT overlay_fid, COUNT(DISTINCT input_fid) AS n_inputs
      FROM (${codeCandidatesSql(o)})
      GROUP BY overlay_fid
      ORDER BY n_inputs DESC, overlay_fid ASC
      LIMIT 1
    `)
  ).toArray() as Array<{ overlay_fid: bigint | number }>;
  return rows.length > 0 ? Number(rows[0].overlay_fid) : null;
}

export interface AssignmentOutcome {
  overlayFid: number;
  assignmentMethod: AssignmentMethod;
  spatialAgrees: boolean | null;
}

// Code wins whenever a match exists, even disagreeing with spatial;
// spatial is the fallback when no code match exists (docs/adr/0045).
// A code overlay tied for the top spatial vote (topOverlayFids) agrees with it.
export function resolveAssignment(
  codeOverlayFid: number | null,
  spatialOverlayFid: number,
  topOverlayFids: number[] = [spatialOverlayFid],
): AssignmentOutcome {
  if (codeOverlayFid != null) {
    return {
      overlayFid: codeOverlayFid,
      assignmentMethod: "code",
      spatialAgrees: topOverlayFids.includes(codeOverlayFid),
    };
  }
  return {
    overlayFid: spatialOverlayFid,
    assignmentMethod: "spatial_fallback",
    spatialAgrees: null,
  };
}

// Combines per-input-feature code and spatial winners: code wins on disagreement,
// spatial is the fallback. An input feature in neither table is absent here.
export async function combinePerInputAssignment(
  conn: AsyncDuckDBConnection,
  o: { codeWinnersTable: string; spatialTable: string; outputTable: string },
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${o.outputTable} AS
    SELECT
      COALESCE(code.input_fid, spatial.input_fid) AS input_fid,
      COALESCE(code.overlay_fid, spatial.overlay_fid) AS overlay_fid,
      CASE WHEN code.overlay_fid IS NOT NULL THEN 'code' ELSE 'spatial_fallback' END AS assignment_method,
      CASE WHEN code.overlay_fid IS NOT NULL THEN code.overlay_fid = spatial.overlay_fid END AS spatial_agrees
    FROM ${o.codeWinnersTable} code
    FULL OUTER JOIN ${o.spatialTable} spatial USING (input_fid)
  `);
}
