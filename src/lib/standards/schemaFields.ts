import schema from "./schema.json";

export interface SchemaField {
  name: string;
  type: string;
  description: string;
}

type Spec = { type: string | string[]; format?: string; description: string };

// "^adm\\d_pcode$" names the family adm{N}_pcode.
const fieldName = (pattern: string) => pattern.replace(/^\^|\$$/g, "").replace("\\d", "{N}");

function typeLabel({ type, format }: Spec): string {
  const t = [type].flat().find((x) => x !== "null");
  if (format === "date") return "Date";
  return t === "integer" ? "Integer" : t === "number" ? "Float" : "String";
}

// Fields in the order the Specification lists them: per-level families first.
export const SCHEMA_FIELDS: SchemaField[] = [
  ...Object.entries(schema.patternProperties).map(([k, v]) => [fieldName(k), v] as const),
  ...Object.entries(schema.properties),
].map(([name, spec]) => ({ name, type: typeLabel(spec as Spec), description: spec.description }));
