import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import {
  canonicalOrder,
  familyLevel,
  nextFreeSibling,
  siblingName,
  templateFamilies,
} from "$lib/db/adminColumns";
import { ROW_ORDER_COLUMN } from "$lib/db/export";
import { detectLevelColumns } from "$lib/tools/schema-map/pipeline/levelColumns";
import { quoteIdent } from "$lib/tools/schema-map/pipeline/queries";
import {
  DEFAULT_TARGET_SCHEMA,
  type TargetSchema,
} from "$lib/tools/schema-map/pipeline/targetSchema";
import { detectLevels } from "$lib/tools/schema-fill/pipeline/levels";

// One output column. "matches": the input's own column equals the join layer's; "sibling": the
// join layer's `joinColumn`, which `differingRows` joined input features disagree with.
export interface JoinedColumn {
  column: string;
  source: "input" | "matches" | "added" | "sibling";
  joinColumn: string | null;
  differingRows: number;
}

export interface JoinResult {
  columns: JoinedColumn[];
  sortColumn: string | null;
}

async function columnTypes(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<Map<string, string>> {
  const desc = await conn.query(`DESCRIBE ${table}`);
  const rows = desc.toArray() as Array<{ column_name: string; column_type: string }>;
  return new Map(
    rows.filter((r) => r.column_name !== "fid").map((r) => [r.column_name, r.column_type]),
  );
}

// Every admin-hierarchy column in the join layer, in its own column order.
async function joinHierarchyColumns(
  conn: AsyncDuckDBConnection,
  columns: string[],
  schema: TargetSchema | null,
): Promise<string[]> {
  const selected = new Set<string>();
  if (schema) {
    const levels = await detectLevels(conn, "join_layer_attr", schema);
    const families = templateFamilies(columns, levels, schema.nameField, schema.codeField);
    for (const family of families.values()) for (const c of family.values()) selected.add(c);
  } else {
    for (const level of (await detectLevelColumns(conn, "join_layer_attr")).values()) {
      for (const c of level.identityColumns) selected.add(c);
    }
  }
  return columns.filter((c) => selected.has(c));
}

// Input columns in input order, each added column within its hierarchy level.
function outputOrder(
  inputColumns: string[],
  siblings: Array<[string, string]>,
  added: string[],
  { nameField, codeField }: TargetSchema,
): string[] {
  const columns = [...inputColumns];
  for (const [column, sibling] of siblings) {
    const family = new Set([column, ...columns.map((_, i) => siblingName(column, i + 1))]);
    columns.splice(columns.findLastIndex((c) => family.has(c)) + 1, 0, sibling);
  }
  const levelOf = (c: string) => familyLevel(c, nameField) ?? familyLevel(c, codeField);
  const newLevels: string[] = [];
  for (const column of canonicalOrder(added, nameField, codeField).ordered) {
    const level = levelOf(column);
    if (level === null) {
      newLevels.push(column);
      continue;
    }
    const indexes = (match: (c: string) => boolean) =>
      columns.flatMap((c, i) => (match(c) ? [i] : []));
    const same = indexes((c) => levelOf(c) === level);
    const coarser = indexes((c) => (levelOf(c) ?? level) < level);
    const isName = familyLevel(column, nameField) !== null;
    const own = isName ? nameField : codeField;
    const ownColumns = same.filter((i) => familyLevel(columns[i], own) === level);
    const codeColumns = same.filter((i) => familyLevel(columns[i], codeField) === level);
    let at: number;
    if (ownColumns.length) at = ownColumns[ownColumns.length - 1] + 1;
    else if (isName && codeColumns.length) at = codeColumns[0];
    else if (same.length) at = same[same.length - 1] + 1;
    else if (coarser.length) at = coarser[0];
    else {
      newLevels.push(column);
      continue;
    }
    columns.splice(at, 0, column);
  }
  return [...columns, ...newLevels];
}

// Builds sj_result_attr (joined attributes, row order in __row_order) and
// sj_mismatch (each input value that differs from its join feature's).
export async function joinColumns(
  conn: AsyncDuckDBConnection,
  schema: TargetSchema | null,
): Promise<JoinResult> {
  const inputTypes = await columnTypes(conn, "input_layer_attr");
  const joinTypes = await columnTypes(conn, "join_layer_attr");
  const taken = new Set([...inputTypes.keys(), ...joinTypes.keys()]);

  const exprs = new Map([...inputTypes.keys()].map((c) => [c, `c.${quoteIdent(c)}`]));
  const joined = new Map<string, JoinedColumn>(
    [...inputTypes.keys()].map((column) => [
      column,
      { column, source: "input", joinColumn: null, differingRows: 0 },
    ]),
  );
  const mismatchParts: string[] = [];
  const siblings: Array<[string, string]> = [];
  const added: string[] = [];
  const joinLayerColumns = [...joinTypes.keys()];
  for (const column of await joinHierarchyColumns(conn, joinLayerColumns, schema)) {
    const col = quoteIdent(column);
    if (!inputTypes.has(column)) {
      exprs.set(column, `p.${col}`);
      added.push(column);
      joined.set(column, { column, source: "added", joinColumn: column, differingRows: 0 });
      continue;
    }
    // Mismatched types compare as text so an unrelated cast can't fail.
    const cast = inputTypes.get(column) === joinTypes.get(column) ? "" : "::VARCHAR";
    const distinct = `c.${col}${cast} IS DISTINCT FROM p.${col}${cast}`;
    const from = `FROM input_layer_attr c
      JOIN sj_assign a ON a.input_fid = c.fid
      JOIN join_layer_attr p ON p.fid = a.join_fid`;
    const differs = Number(
      (
        (await conn.query(`SELECT COUNT(*) AS n ${from} WHERE ${distinct}`)).toArray()[0] as {
          n: bigint;
        }
      ).n,
    );
    if (!differs) {
      joined.set(column, { column, source: "matches", joinColumn: column, differingRows: 0 });
      continue;
    }
    const sibling = nextFreeSibling(column, taken);
    taken.add(sibling);
    siblings.push([column, sibling]);
    exprs.set(sibling, `p.${col}`);
    joined.set(sibling, {
      column: sibling,
      source: "sibling",
      joinColumn: column,
      differingRows: differs,
    });
    mismatchParts.push(`--sql
      SELECT c.fid AS input_fid, a.join_fid, '${column.replace(/'/g, "''")}' AS column_name,
             c.${col}::VARCHAR AS input_value, p.${col}::VARCHAR AS join_value
      ${from}
      WHERE c.${col} IS NOT NULL AND p.${col} IS NOT NULL AND ${distinct}
    `);
  }

  const template = schema ?? DEFAULT_TARGET_SCHEMA;
  const { sortColumn } = canonicalOrder(
    [...exprs.keys()],
    template.nameField,
    template.codeField,
  );
  const ordered = outputOrder([...inputTypes.keys()], siblings, added, template);
  const select = ordered.map((c) => `, ${exprs.get(c)} AS ${quoteIdent(c)}`).join("");
  const order = sortColumn ? `${exprs.get(sortColumn)} NULLS LAST, ` : "";
  // __row_order is the output row number, so issue rows point at output rows.
  await conn.query(`--sql
    CREATE OR REPLACE TABLE sj_result_attr AS
    SELECT c.fid${select},
           ROW_NUMBER() OVER (ORDER BY ${order}c.fid) AS ${ROW_ORDER_COLUMN}
    FROM input_layer_attr c
    LEFT JOIN sj_assign a ON a.input_fid = c.fid
    LEFT JOIN join_layer_attr p ON p.fid = a.join_fid
  `);
  const empty = `SELECT NULL::BIGINT AS input_fid, NULL::BIGINT AS join_fid,
    NULL::VARCHAR AS column_name, NULL::VARCHAR AS input_value,
    NULL::VARCHAR AS join_value WHERE FALSE`;
  await conn.query(`--sql
    CREATE OR REPLACE TABLE sj_mismatch AS
    ${mismatchParts.length > 0 ? mismatchParts.join(" UNION ALL ") : empty}
  `);
  return { columns: ordered.map((c) => joined.get(c)!), sortColumn };
}
