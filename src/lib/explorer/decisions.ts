import { SvelteMap } from "svelte/reactivity";
import { parseCsv } from "./csv";
import csv from "./decisions.csv?raw";

export interface Decision {
  iso3: string;
  selectedSource: string | null;
  // selected_source "none": the team found no source suitable, unlike a missing row.
  noSourceSuitable: boolean;
  accepted: boolean;
  rationale: string;
}

export function parseDecisions(text: string): Map<string, Decision> {
  const [header = [], ...rows] = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const [iso3Col, sourceCol, acceptedCol, rationaleCol] = [
    "iso3",
    "selected_source",
    "accepted",
    "rationale",
  ].map(col);
  const map = new Map<string, Decision>();
  for (const row of rows) {
    const iso3 = row[iso3Col]?.trim().toUpperCase();
    if (!iso3) continue;
    const source = row[sourceCol]?.trim().toLowerCase() ?? "";
    map.set(iso3, {
      iso3,
      selectedSource: source && source !== "none" ? source : null,
      noSourceSuitable: source === "none",
      accepted: row[acceptedCol]?.trim().toLowerCase() === "true",
      rationale: row[rationaleCol]?.trim() ?? "",
    });
  }
  return map;
}

const sheet = parseDecisions(csv);
export const decisions = new SvelteMap(sheet);

export function getDecision(iso3: string): Decision | null {
  return decisions.get(iso3) ?? null;
}

// Dev-only pick edits, kept in localStorage until the sheet and decisions.csv catch up.
const EDITS_KEY = "explorer-pick-edits";

export type PickEdit = Pick<
  Decision,
  "selectedSource" | "noSourceSuitable" | "accepted" | "rationale"
>;

function same(a: PickEdit, b: PickEdit | undefined): boolean {
  return (
    !!b &&
    a.selectedSource === b.selectedSource &&
    a.noSourceSuitable === b.noSourceSuitable &&
    a.accepted === b.accepted &&
    a.rationale === b.rationale
  );
}

function storedEdits(): Record<string, PickEdit> {
  try {
    return JSON.parse(localStorage.getItem(EDITS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export const pickEdits = new SvelteMap<string, PickEdit>();

function save() {
  localStorage.setItem(EDITS_KEY, JSON.stringify(Object.fromEntries(pickEdits)));
}

export function editDecision(iso3: string, edit: PickEdit) {
  if (same(edit, sheet.get(iso3))) {
    resetDecision(iso3);
    return;
  }
  pickEdits.set(iso3, edit);
  decisions.set(iso3, { iso3, ...edit });
  save();
}

export function pickSource(iso3: string, sourceId: string) {
  const d = decisions.get(iso3);
  editDecision(iso3, {
    selectedSource: sourceId,
    noSourceSuitable: false,
    accepted: d?.accepted ?? false,
    rationale: d?.rationale ?? "",
  });
}

export function resetDecision(iso3: string) {
  pickEdits.delete(iso3);
  const original = sheet.get(iso3);
  if (original) decisions.set(iso3, original);
  else decisions.delete(iso3);
  save();
}

// selected_source, rationale and accepted in the sheet's column order.
export function pickEditsCsv(): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [...pickEdits].sort(([a], [b]) => a.localeCompare(b));
  return [
    "iso3,selected_source,rationale,accepted",
    ...rows.map(([iso3, e]) =>
      [
        iso3,
        e.noSourceSuitable ? "none" : (e.selectedSource ?? ""),
        quote(e.rationale),
        e.accepted ? "TRUE" : "FALSE",
      ].join(","),
    ),
  ].join("\n");
}

export function sheetDecision(iso3: string): Decision | null {
  return sheet.get(iso3) ?? null;
}

if (import.meta.env.DEV && typeof localStorage !== "undefined") {
  for (const [iso3, edit] of Object.entries(storedEdits())) {
    if (same(edit, sheet.get(iso3))) continue;
    pickEdits.set(iso3, edit);
    decisions.set(iso3, { iso3, ...edit });
  }
  save();
}
