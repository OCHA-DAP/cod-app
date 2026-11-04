import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { bboxColumnsSql, subdivideSql } from "./bbox";
import { SNAP_TOLERANCE } from "./constants";

export interface GridPairsOptions {
  on: string;
  tol: number;
  key?: string;
  rightKey?: string;
}

// Ported from topo-tools' grid_pairs: creates `out` (pid, near_pid), the left/right
// rows whose tol-padded bboxes overlap, joined on grid cells and counted once each.
export async function gridPairs(
  conn: AsyncDuckDBConnection,
  left: string,
  right: string,
  out: string,
  { on, tol, key = "pid", rightKey }: GridPairsOptions,
): Promise<void> {
  // A 99th-percentile-extent cell keeps cells per row and rows per cell small.
  const cellRow = (
    await conn.query(`--sql
      SELECT greatest(quantile_cont(e, 0.99) FILTER (WHERE e > 0), ${tol}) AS cell
      FROM (
        SELECT greatest(xmax - xmin, ymax - ymin) AS e FROM ${left}
        UNION ALL SELECT greatest(xmax - xmin, ymax - ymin) FROM ${right}
      )
    `)
  ).toArray()[0] as { cell: number | null };
  const cell = cellRow.cell ?? tol;
  const cells = (table: string, a: string) => `(
    SELECT ${a}.*, cx, cy
    FROM (
      SELECT *, xmin - ${tol} AS x0, ymin - ${tol} AS y0, xmax + ${tol} AS x1, ymax + ${tol} AS y1
      FROM ${table}
    ) ${a},
    LATERAL (SELECT UNNEST(range(
      floor(${a}.x0 / ${cell})::BIGINT, floor(${a}.x1 / ${cell})::BIGINT + 1
    )) AS cx),
    LATERAL (SELECT UNNEST(range(
      floor(${a}.y0 / ${cell})::BIGINT, floor(${a}.y1 / ${cell})::BIGINT + 1
    )) AS cy)
  )`;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${out} AS
    SELECT l.${key} AS pid, r.${rightKey ?? key} AS near_pid
    FROM ${cells(left, "l")} l JOIN ${cells(right, "r")} r USING (cx, cy)
    WHERE r.x0 <= l.x1 AND r.x1 >= l.x0 AND r.y0 <= l.y1 AND r.y1 >= l.y0
      AND cx = floor(greatest(l.x0, r.x0) / ${cell})::BIGINT
      AND cy = floor(greatest(l.y0, r.y0) / ${cell})::BIGINT
      AND (${on})
  `);
}

// Ported from topo-tools' _near_part_pairs: creates `out` (pid, near_pid), the
// left/right parts within tol; heavy parts are compared split.
export async function nearPartPairs(
  conn: AsyncDuckDBConnection,
  left: string,
  right: string,
  out: string,
  { on = "TRUE", tol = SNAP_TOLERANCE }: { on?: string; tol?: number } = {},
): Promise<void> {
  await gridPairs(conn, left, right, `${out}_cand`, { on, tol });
  const candL = `SELECT pid FROM ${out}_cand`;
  const candR = `SELECT near_pid FROM ${out}_cand`;
  const sides: [string, string, string][] =
    left === right
      ? [["l", left, `${candL} UNION ${candR}`]]
      : [
          ["l", left, candL],
          ["r", right, candR],
        ];
  for (const [side, table, pids] of sides) {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE ${out}_${side} AS
      WITH s AS (
        SELECT pid, UNNEST(${subdivideSql("geom")}) AS geom FROM ${table}
        WHERE pid IN (${pids})
      )
      SELECT row_number() OVER () AS qid, pid, geom, ${bboxColumnsSql("geom")} FROM s
    `);
  }
  const rp = `${out}_${left === right ? "l" : "r"}`;
  await gridPairs(conn, `${out}_l`, rp, `${out}_pp`, { on: "TRUE", tol, key: "qid" });
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${out} AS
    WITH j AS (
      SELECT a.pid, b.pid AS near_pid, a.geom AS ag, b.geom AS bg
      FROM ${out}_pp pp
      JOIN ${out}_l a ON a.qid = pp.pid JOIN ${rp} b ON b.qid = pp.near_pid
    )
    SELECT DISTINCT pid, near_pid FROM j
    SEMI JOIN ${out}_cand USING (pid, near_pid) WHERE ST_DWithin(ag, bg, ${tol})
  `);
  for (const side of ["cand", "l", "r", "pp"]) {
    await conn.query(`DROP TABLE IF EXISTS ${out}_${side}`);
  }
}
