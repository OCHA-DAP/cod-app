import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { checkGenericNames, genericFamilies } from "$lib/db/adminColumns";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";
import {
  detectLevelsWithRoot,
  fallbackFamilies,
  groupFamiliesByLevel,
  levelCodeColumns,
  levelFamilyNames,
} from "./levelColumns";
import type { TargetSchema } from "./targetSchema";

// Ports topo-tools' core/schema_map/_identity_names.py.

// Rekeys auto-detected families by their generic name at their finest level.
export function genericNamesByFamily(
  families: Map<string, Map<number, string>>,
  levels: number[],
  codeColumns: (string | null)[],
): Map<string, Map<number, string>> {
  const named: Array<[string, string, Map<number, string>]> = [];
  for (const [kind, perLevel] of families) {
    const lvl = Math.max(...perLevel.keys());
    const i = levels.indexOf(lvl);
    const code = i >= 0 ? codeColumns[i] : null;
    const generic = levelFamilyNames(new Map([[kind, perLevel]]), lvl, code).get(
      perLevel.get(lvl)!,
    )!;
    named.push([kind, generic, perLevel]);
  }
  checkGenericNames(named.map(([kind, generic]) => [kind, generic]));
  return new Map(named.map(([, generic, perLevel]) => [generic, perLevel]));
}

// Throws ColumnNameError if package-points or package-lines would clash on a name.
export async function checkIdentityNames(
  conn: AsyncDuckDBConnection,
  table: string,
  schema: TargetSchema | null,
  depthColumn = "adm_lvl",
): Promise<void> {
  const reserved = ["fid", "geom", "geometry", depthColumn];
  if (schema !== null) {
    const desc = (await conn.query(`DESCRIBE "${table}"`)).toArray() as Array<{
      column_name: string;
    }>;
    const levels = await detectLevels(conn, table, schema);
    genericFamilies(
      desc.map((r) => r.column_name),
      levels,
      schema.nameField,
      schema.codeField,
      reserved,
    );
    return;
  }
  const levelColumns = await detectLevelsWithRoot(conn, table);
  const levels = [...levelColumns.keys()].sort((a, b) => a - b);
  const grouped = await groupFamiliesByLevel(conn, table, levelColumns);
  const families = grouped.size ? grouped : fallbackFamilies(levelColumns, levels);
  const codes = levelCodeColumns(levelColumns, families, levels);
  levels.forEach((n, i) => {
    checkGenericNames([...levelFamilyNames(families, n, codes[i])], reserved);
  });
  genericNamesByFamily(families, levels, codes);
}
