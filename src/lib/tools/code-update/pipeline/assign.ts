import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { assignNewCodes, quoteIdent, rewriteChildCode, type CodeFormat } from "$lib/db/code";
import type { SideLevels } from "./levels";

const RETAIN_CLASSES = new Set(["unchanged", "renamed"]);
const SINGLE_PREDECESSOR_CLASSES = new Set(["modified", "relocated"]);
const RETIRE_ONLY_CLASSES = new Set(["merge", "complex"]);

const REASONS: Record<string, string> = {
  "unchanged:retained": "geometry and identity unchanged, code retained",
  "renamed:retained": "name changed, geometry unchanged, code retained",
  "modified:retained": "geometry modified, code retained (lenient: codes without a delimiter)",
  "removed:retired": "no NEW counterpart, code retired",
  "merge:retired": "merged into another unit, code retired",
  "complex:retired": "involved in a complex N:M change, code retired",
  "created:new": "new unit, no OLD counterpart",
  "modified:new": "geometry modified past threshold, new code assigned",
  "relocated:new": "unit relocated, new code assigned under its re-derived parent",
  "split:new": "split from predecessor, new code assigned",
  "merge:new": "formed by merging OLD units, new code assigned",
  "complex:new": "formed by a complex N:M change, new code assigned",
};

const COLLIDED_REASON =
  "moved under a new parent where its code is already taken, new code assigned";

export interface ChangeRow {
  level: number;
  oldCode: string | null;
  oldName: string | null;
  newCode: string | null;
  newName: string | null;
  relationshipClass: string;
  clusterId: number;
  matchMethod: string | null;
  codeOutcome: "retained" | "retired" | "new" | "overflow";
  reason: string;
  predecessorCode: string | null;
  bFid: number | null;
}

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

async function fetchStrMap(
  conn: AsyncDuckDBConnection,
  table: string,
  keyCol: string,
  valCol: string,
): Promise<Map<number, string>> {
  const rows = (
    await conn.query(
      `SELECT ${quoteIdent(keyCol)} AS k, ${quoteIdent(valCol)} AS v FROM ${quoteIdent(table)}`,
    )
  ).toArray() as Array<{ k: number | bigint; v: string }>;
  const out = new Map<number, string>();
  for (const r of rows) out.set(Number(r.k), r.v);
  return out;
}

async function fetchIntMap(
  conn: AsyncDuckDBConnection,
  table: string,
  keyCol: string,
  valCol: string,
): Promise<Map<number, number>> {
  const rows = (
    await conn.query(
      `SELECT ${quoteIdent(keyCol)} AS k, ${quoteIdent(valCol)} AS v FROM ${quoteIdent(table)}`,
    )
  ).toArray() as Array<{ k: number | bigint; v: number | bigint }>;
  const out = new Map<number, number>();
  for (const r of rows) out.set(Number(r.k), Number(r.v));
  return out;
}

// Collapses every linked pair's own match_method to one value, joined if mixed.
function reduceMatchMethods(
  pairs: Array<[number, number]>,
  lookup: Map<string, string>,
): string | null {
  const methods = new Set<string>();
  for (const [a, b] of pairs) {
    const m = lookup.get(`${a}:${b}`);
    if (m) methods.add(m);
  }
  return methods.size > 0 ? [...methods].sort().join("+") : null;
}

interface NewBatchMeta {
  bFid: number;
  oldCode: string | null;
  oldName: string | null;
  predecessor: string | null;
  clusterId: number;
  cls: string;
  matchMethod: string | null;
  reason?: string;
}

// Clusters whose rewritten code repeats an OLD code or another rewrite.
function collisions(
  rewritten: Map<number, string>,
  original: Map<number, string>,
  oldCodes: Set<string>,
): Set<number> {
  const taken = new Set([...rewritten.values()].filter((c) => oldCodes.has(c)));
  const collided = new Set<number>();
  const keys = [...rewritten.keys()].sort((a, b) => {
    const ca = rewritten.get(a)!;
    const cb = rewritten.get(b)!;
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  for (const key of keys) {
    if (rewritten.get(key) === original.get(key)) continue;
    if (taken.has(rewritten.get(key)!)) collided.add(key);
    else taken.add(rewritten.get(key)!);
  }
  return collided;
}

// Reads cw_pairs_classified/cw_polygon_class, so this must run immediately
// after classifyLevel(n), before the next level's call overwrites them.
export async function assignLevel(
  conn: AsyncDuckDBConnection,
  n: number,
  prevLevel: number | null,
  sideA: SideLevels,
  sideB: SideLevels,
  fmt: CodeFormat,
  newCodeByFid: Map<number, Map<number, string>>,
  changelog: ChangeRow[],
): Promise<void> {
  const codeColA = sideA.columns.get(n)!;
  const oldCodeByFid = await fetchStrMap(conn, `cu_dsl_${n}_a`, "fid", codeColA);
  const nameColA = sideA.names.get(n) ?? null;
  const oldNameByFid = nameColA
    ? await fetchStrMap(conn, `cu_dsl_${n}_a`, "fid", nameColA)
    : new Map<number, string>();
  const nameColB = sideB.names.get(n) ?? null;
  const newNameByFid = nameColB
    ? await fetchStrMap(conn, `cu_dsl_${n}_b`, "fid", nameColB)
    : new Map<number, string>();
  const childToParentFid =
    prevLevel !== null
      ? await fetchIntMap(conn, `cu_reparent_${n}_assign`, "input_fid", "overlay_fid")
      : new Map<number, number>();

  function newParentCode(bFid: number): string {
    if (prevLevel === null) return fmt.rootCode!;
    const parentFid = childToParentFid.get(bFid);
    if (parentFid === undefined) {
      throw new Error(`level ${n}: no re-derived parent for new fid ${bFid}`);
    }
    const code = newCodeByFid.get(prevLevel)!.get(parentFid);
    if (code === undefined) {
      throw new Error(
        `level ${n}: no assigned code for parent fid ${parentFid} at level ${prevLevel}`,
      );
    }
    return code;
  }

  const pairMethodRows = (
    await conn.query("SELECT a_fid, b_fid, match_method FROM cw_pairs_classified")
  ).toArray() as Array<{ a_fid: number | bigint; b_fid: number | bigint; match_method: string }>;
  const pairMethod = new Map<string, string>();
  for (const r of pairMethodRows)
    pairMethod.set(`${Number(r.a_fid)}:${Number(r.b_fid)}`, r.match_method);

  const bRows = (
    await conn.query("SELECT side, fid, cluster_id, relationship_class FROM cw_polygon_class")
  ).toArray() as Array<{
    side: string;
    fid: number | bigint;
    cluster_id: number | bigint;
    relationship_class: string;
  }>;
  const clusters = new Map<number, { a: number[]; b: number[]; cls: string }>();
  for (const r of bRows) {
    const cid = Number(r.cluster_id);
    let c = clusters.get(cid);
    if (!c) {
      c = { a: [], b: [], cls: r.relationship_class };
      clusters.set(cid, c);
    }
    if (r.side === "a") c.a.push(Number(r.fid));
    else c.b.push(Number(r.fid));
  }

  // Codes without a delimiter (ISO2-style) are lenient: a 1:1 match keeps its code.
  const retainClasses = new Set([...RETAIN_CLASSES, ...(fmt.delimiter === "" ? ["modified"] : [])]);
  const retainedCodes: string[] = [];
  const newBatch: Array<[string, string]> = [];
  const newBatchMeta = new Map<string, NewBatchMeta>();
  const levelNewCodes = new Map<number, string>();

  const oldCodes = new Set([...oldCodeByFid.values()].filter((c) => c !== null));
  // A code kept as-is wins; a rewritten one that repeats any OLD code or an
  // earlier rewrite (a unit moved under a new parent) gets a new code.
  const rewritten = new Map<number, string>();
  const original = new Map<number, string>();
  for (const [clusterId, c] of clusters) {
    if (!retainClasses.has(c.cls)) continue;
    const oldCode = oldCodeByFid.get(c.a[0])!;
    rewritten.set(clusterId, rewriteChildCode(oldCode, newParentCode(c.b[0]), fmt));
    original.set(clusterId, oldCode);
  }
  const collided = collisions(rewritten, original, oldCodes);

  for (const [clusterId, c] of clusters) {
    const rel = c.cls;

    if (retainClasses.has(rel) && !collided.has(clusterId)) {
      const aFid = c.a[0];
      const bFid = c.b[0];
      const oldCode = oldCodeByFid.get(aFid)!;
      const newCode = rewritten.get(clusterId)!;
      levelNewCodes.set(bFid, newCode);
      retainedCodes.push(newCode);
      changelog.push({
        level: n,
        oldCode,
        oldName: oldNameByFid.get(aFid) ?? null,
        newCode,
        newName: newNameByFid.get(bFid) ?? null,
        relationshipClass: rel,
        clusterId,
        matchMethod: pairMethod.get(`${aFid}:${bFid}`) ?? null,
        codeOutcome: "retained",
        reason: REASONS[`${rel}:retained`],
        predecessorCode: null,
        bFid,
      });
      continue;
    }

    if (rel === "removed") {
      for (const aFid of c.a) {
        changelog.push({
          level: n,
          oldCode: oldCodeByFid.get(aFid)!,
          oldName: oldNameByFid.get(aFid) ?? null,
          newCode: null,
          newName: null,
          relationshipClass: rel,
          clusterId,
          matchMethod: null,
          codeOutcome: "retired",
          reason: REASONS["removed:retired"],
          predecessorCode: null,
          bFid: null,
        });
      }
      continue;
    }

    if (RETIRE_ONLY_CLASSES.has(rel)) {
      for (const aFid of c.a) {
        changelog.push({
          level: n,
          oldCode: oldCodeByFid.get(aFid)!,
          oldName: oldNameByFid.get(aFid) ?? null,
          newCode: null,
          newName: null,
          relationshipClass: rel,
          clusterId,
          matchMethod: reduceMatchMethods(
            c.b.map((b): [number, number] => [aFid, b]),
            pairMethod,
          ),
          codeOutcome: "retired",
          reason: REASONS[`${rel}:retired`],
          predecessorCode: null,
          bFid: null,
        });
      }
      for (const bFid of c.b) {
        const fidKey = `n${n}_${bFid}`;
        newBatch.push([fidKey, newParentCode(bFid)]);
        newBatchMeta.set(fidKey, {
          bFid,
          oldCode: null,
          oldName: null,
          predecessor: null,
          clusterId,
          cls: rel,
          matchMethod: reduceMatchMethods(
            c.a.map((a): [number, number] => [a, bFid]),
            pairMethod,
          ),
        });
      }
      continue;
    }

    if (rel === "created") {
      const bFid = c.b[0];
      const fidKey = `n${n}_${bFid}`;
      newBatch.push([fidKey, newParentCode(bFid)]);
      newBatchMeta.set(fidKey, {
        bFid,
        oldCode: null,
        oldName: null,
        predecessor: null,
        clusterId,
        cls: rel,
        matchMethod: null,
      });
      continue;
    }

    if (SINGLE_PREDECESSOR_CLASSES.has(rel) || collided.has(clusterId)) {
      const aFid = c.a[0];
      const bFid = c.b[0];
      const oldCode = oldCodeByFid.get(aFid)!;
      const fidKey = `n${n}_${bFid}`;
      newBatch.push([fidKey, newParentCode(bFid)]);
      newBatchMeta.set(fidKey, {
        bFid,
        oldCode,
        oldName: oldNameByFid.get(aFid) ?? null,
        predecessor: oldCode,
        clusterId,
        cls: rel,
        matchMethod: pairMethod.get(`${aFid}:${bFid}`) ?? null,
        reason: collided.has(clusterId) ? COLLIDED_REASON : undefined,
      });
      continue;
    }

    if (rel === "split") {
      const aFid = c.a[0];
      const oldCode = oldCodeByFid.get(aFid)!;
      for (const bFid of c.b) {
        const fidKey = `n${n}_${bFid}`;
        newBatch.push([fidKey, newParentCode(bFid)]);
        newBatchMeta.set(fidKey, {
          bFid,
          oldCode: null,
          oldName: null,
          predecessor: oldCode,
          clusterId,
          cls: rel,
          matchMethod: pairMethod.get(`${aFid}:${bFid}`) ?? null,
        });
      }
      continue;
    }

    throw new Error(`unexpected relationship_class ${JSON.stringify(rel)}`);
  }

  if (newBatch.length > 0) {
    const staging = "cu_assign_new";
    await conn.query(
      `CREATE OR REPLACE TEMP TABLE ${quoteIdent(staging)} (fid_key VARCHAR, code_val VARCHAR, parent_code VARCHAR)`,
    );
    const values = newBatch
      .map(([k, p]) => `(${sqlStr(k)}, ${sqlStr(k)}, ${sqlStr(p)})`)
      .join(", ");
    await conn.query(`INSERT INTO ${quoteIdent(staging)} VALUES ${values}`);
    await assignNewCodes(conn, staging, {
      idColumn: "fid_key",
      parentColumn: "parent_code",
      sortColumns: ["fid_key"],
      codeColumn: "code_val",
      fmt,
      level: n,
      existingCodes: [...retainedCodes, ...oldCodes],
    });
    const assigned = (
      await conn.query(`SELECT fid_key, code_val FROM ${quoteIdent(staging)}`)
    ).toArray() as Array<{ fid_key: string; code_val: string }>;
    await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(staging)}`);

    for (const { fid_key, code_val } of assigned) {
      const meta = newBatchMeta.get(fid_key)!;
      levelNewCodes.set(meta.bFid, code_val);
      changelog.push({
        level: n,
        oldCode: meta.oldCode,
        oldName: meta.oldName,
        newCode: code_val,
        newName: newNameByFid.get(meta.bFid) ?? null,
        relationshipClass: meta.cls,
        clusterId: meta.clusterId,
        matchMethod: meta.matchMethod,
        codeOutcome: "new",
        reason: meta.reason ?? REASONS[`${meta.cls}:new`],
        predecessorCode: meta.predecessor,
        bFid: meta.bFid,
      });
    }
  }

  newCodeByFid.set(n, levelNewCodes);
}
