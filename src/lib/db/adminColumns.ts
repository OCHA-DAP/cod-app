// Admin-hierarchy column matching against `{n}`-templated field names, by name only.
// Ports topo-tools' core/admin_columns.py.

const NAME = 0;
const OTHER = 1;
const CODE = 2;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fieldPrefix(template: string): string {
  return template.split("{n}")[0];
}

// Groups level columns by suffix, e.g. {"_code": {1: "adm1_code", ...}}.
export function columnFamilies(
  columns: string[],
  levels: number[],
  prefix: string,
): Map<string, Map<number, string>> {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)(.*)$`);
  const families = new Map<string, Map<number, string>>();
  for (const column of columns) {
    const m = pattern.exec(column);
    if (!m) continue;
    const level = Number(m[1]);
    if (!levels.includes(level)) continue;
    if (!families.has(m[2])) families.set(m[2], new Map());
    families.get(m[2])!.set(level, column);
  }
  return families;
}

// Level columns under both templates' prefixes, keyed like "adm{n}_name".
export function templateFamilies(
  columns: string[],
  levels: number[],
  nameField: string,
  codeField: string,
): Map<string, Map<number, string>> {
  const families = new Map<string, Map<number, string>>();
  for (const prefix of new Set([fieldPrefix(codeField), fieldPrefix(nameField)])) {
    for (const [suffix, perLevel] of columnFamilies(columns, levels, prefix)) {
      families.set(`${prefix}{n}${suffix}`, perLevel);
    }
  }
  return families;
}

// A column's index-th numbered sibling, `_`-separated after a trailing digit.
export function siblingName(column: string, index: number): string {
  return /\d$/.test(column) ? `${column}_${index}` : `${column}${index}`;
}

// Column's lowest-numbered sibling name not already in taken.
export function nextFreeSibling(column: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(siblingName(column, n))) n++;
  return siblingName(column, n);
}

// Each column whose numbered siblings aren't in numeric order after it.
export function misorderedSiblings(columns: string[]): string[] {
  const position = new Map(columns.map((c, i) => [c, i]));
  return columns.filter((base) => {
    const family = [base, ...columns.map((_, k) => siblingName(base, k + 1))]
      .filter((c) => position.has(c))
      .map((c) => position.get(c)!);
    return family.some((p, i) => i > 0 && p < family[i - 1]);
  });
}

// Matches a template's own column and its numbered siblings (`adm2_name1`, `GID_2_1`).
function familyPattern(template: string): RegExp {
  const i = template.indexOf("{n}");
  const before = i < 0 ? template : template.slice(0, i);
  const after = i < 0 ? "" : template.slice(i + 3);
  const sep = !after || /\d$/.test(after) ? "_" : "";
  return new RegExp(`^${escapeRegExp(before)}(\\d+)${escapeRegExp(after)}(?:${sep}(\\d+))?$`);
}

// A column's level within a template's family (`adm2_name1` is 2), else null.
export function familyLevel(column: string, template: string): number | null {
  const m = familyPattern(template).exec(column);
  return m ? Number(m[1]) : null;
}

// Deepest level first (names, other, codes), then the rest in input order; also
// returns the deepest level's own code column to sort rows by, if any.
export function canonicalOrder(
  columns: string[],
  nameField: string,
  codeField: string,
): { ordered: string[]; sortColumn: string | null } {
  const nameRe = familyPattern(nameField);
  const codeRe = familyPattern(codeField);
  const prefix = fieldPrefix(codeField);
  const levelRe = prefix ? new RegExp(`^${escapeRegExp(prefix)}(\\d+)(?!\\d)`) : null;
  const keys = new Map<string, [number, number, number]>();
  for (const column of columns) {
    let m: RegExpExecArray | null;
    if ((m = codeRe.exec(column))) keys.set(column, [Number(m[1]), CODE, Number(m[2] ?? 0)]);
    else if ((m = nameRe.exec(column))) keys.set(column, [Number(m[1]), NAME, Number(m[2] ?? 0)]);
  }
  const levels = new Set([...keys.values()].map(([level]) => level));
  columns.forEach((column, position) => {
    const m = keys.has(column) || !levelRe ? null : levelRe.exec(column);
    if (m && levels.has(Number(m[1]))) keys.set(column, [Number(m[1]), OTHER, position]);
  });
  const ordered = [...keys.keys()].sort((a, b) => {
    const [la, ka, sa] = keys.get(a)!;
    const [lb, kb, sb] = keys.get(b)!;
    return lb - la || ka - kb || sa - sb;
  });
  const codes = new Map<number, string>();
  for (const [column, [level]] of keys) {
    if (column === codeField.replaceAll("{n}", String(level))) codes.set(level, column);
  }
  const sortColumn = codes.size > 0 ? codes.get(Math.max(...codes.keys()))! : null;
  return { ordered: [...ordered, ...columns.filter((c) => !keys.has(c))], sortColumn };
}
