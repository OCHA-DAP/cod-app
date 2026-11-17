// Ported from topo-tools' core/schema_detect/_constants.py.

export const SEVERITY = {
  "check-failed": "error",
  "levels-undetected": "error",
  "level-skipped": "error",
  "multiple-parents": "error",
  "orphan-child": "error",
  "varying-column": "error",
  "unusable-column-name": "error",
  "supplemental-column": "warn",
  "column-naming": "warn",
  "column-set-mismatch": "warn",
} as const;

export type SchemaIssueKind = keyof typeof SEVERITY;
export type Severity = (typeof SEVERITY)[SchemaIssueKind];
