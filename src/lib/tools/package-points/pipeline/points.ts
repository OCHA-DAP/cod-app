import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { genericFamilies } from "$lib/db/adminColumns";
import {
  detectLevelsWithRoot,
  fallbackFamilies,
  groupFamiliesByLevel,
  levelCodeColumns,
  levelFamilyNames,
  verifyFunctionalCluster,
  type LevelColumns,
} from "$lib/tools/schema-map/pipeline/levelColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";

export interface LevelPlan {
  level: number;
  groupBy: string[];
  // The level's own identity columns, each mapped to its generic output name.
  rename: Map<string, string>;
  isRoot: boolean;
}

async function tableColumns(conn: AsyncDuckDBConnection, table: string): Promise<string[]> {
  const desc = await conn.query(`DESCRIBE "${table}"`);
  return (desc.toArray() as Array<{ column_name: string }>).map((r) => r.column_name);
}

async function identityFamilies(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
  levelColumns: Map<number, LevelColumns> | null,
  levels: number[],
  reserved: string[],
): Promise<Map<string, Map<number, string>>> {
  if (schema !== null) {
    const columns = await tableColumns(conn, table);
    return genericFamilies(columns, levels, schema.nameField, schema.codeField, reserved);
  }
  if (levelColumns === null || ![...levelColumns.values()].some((c) => c.groupBy.length)) {
    return new Map();
  }
  const families = await groupFamiliesByLevel(conn, table, levelColumns);
  return families.size ? families : fallbackFamilies(levelColumns, levels);
}

function levelGroupBy(
  schema: TargetSchema | null,
  levelColumns: Map<number, LevelColumns> | null,
  n: number,
  families: Map<string, Map<number, string>>,
): [string[], string[]] {
  const own = [...families.values()].filter((p) => p.has(n)).map((p) => p.get(n)!);
  if (schema !== null) return [[schema.codeField.replace("{n}", String(n))], own];
  const cluster = levelColumns!.get(n)!;
  if (!cluster.groupBy.length && levelColumns!.size > 1 && !cluster.isRoot) {
    throw new Error(`no reliable group-by column detected for level ${n}`);
  }
  return [
    cluster.groupBy,
    own.length ? own : [...new Set([...cluster.groupBy, ...cluster.identityColumns])],
  ];
}

// One dissolve plan per level at or above minLevel, each keeping only its own identity.
export async function resolvePointLevelPlans(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
  depthColumn: string,
  minLevel: number | null = null,
): Promise<LevelPlan[]> {
  const reserved = ["fid", "geom", "geometry", depthColumn];
  let levelColumns: Map<number, LevelColumns> | null = null;
  let levels: number[];
  if (schema !== null) {
    levels = await detectLevels(conn, table, schema);
  } else {
    levelColumns = await detectLevelsWithRoot(conn, table);
    levels = [...levelColumns.keys()].sort((a, b) => a - b);
  }
  const families = await identityFamilies(conn, table, schema, levelColumns, levels, reserved);
  const codes = new Map<number, string | null>();
  if (levelColumns !== null) {
    const perLevel = levelCodeColumns(levelColumns, families, levels);
    levels.forEach((n, i) => codes.set(n, perLevel[i]));
  }

  const selected = levels.filter((n) => minLevel === null || n >= minLevel);
  if (!selected.length) throw new Error(`no admin level at or above min level ${minLevel}`);
  const plans: LevelPlan[] = [];
  for (const n of selected) {
    const [groupBy, own] = levelGroupBy(schema, levelColumns, n, families);
    if (schema === null && groupBy.length) {
      await verifyFunctionalCluster(conn, table, groupBy[0], groupBy);
    }
    const code = groupBy.length ? groupBy[0] : (codes.get(n) ?? null);
    const renames = levelFamilyNames(families, n, code);
    const rename = new Map(own.map((c): [string, string] => [c, renames.get(c) ?? c]));
    plans.push({ level: n, groupBy, rename, isRoot: !!levelColumns?.get(n)?.isRoot });
  }
  return plans;
}
