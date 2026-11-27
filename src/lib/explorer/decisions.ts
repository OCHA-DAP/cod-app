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

// Dev-only pick edits, each kept with the CSV row it was made on until decisions.csv matches.
const EDITS_KEY = "explorer-pick-edits";

export type PickEdit = Pick<
  Decision,
  "selectedSource" | "noSourceSuitable" | "accepted" | "rationale"
>;

function key(d: PickEdit | undefined): string {
  return d ? JSON.stringify([d.selectedSource, d.noSourceSuitable, d.accepted, d.rationale]) : "";
}

export const pickEdits = new SvelteMap<string, PickEdit>();

function save() {
  const stored = Object.fromEntries(
    [...pickEdits].map(([iso3, edit]) => [iso3, { edit, base: key(sheet.get(iso3)) }]),
  );
  localStorage.setItem(EDITS_KEY, JSON.stringify(stored));
}

export function editDecision(iso3: string, edit: PickEdit) {
  if (!sheet.has(iso3)) return;
  if (key(edit) === key(sheet.get(iso3))) {
    resetDecision(iso3);
    return;
  }
  pickEdits.set(iso3, edit);
  decisions.set(iso3, { iso3, ...edit });
  save();
}

// A new source starts unaccepted, unless it is the sheet's own pick.
export function pickSource(iso3: string, sourceId: string) {
  const original = sheet.get(iso3);
  editDecision(iso3, {
    selectedSource: sourceId,
    noSourceSuitable: false,
    accepted: original?.selectedSource === sourceId && original.accepted,
    rationale: decisions.get(iso3)?.rationale ?? "",
  });
}

export function resetDecision(iso3: string) {
  pickEdits.delete(iso3);
  const original = sheet.get(iso3);
  if (original) decisions.set(iso3, original);
  save();
}

export function sheetDecision(iso3: string): Decision | null {
  return sheet.get(iso3) ?? null;
}

// selected_source, rationale and accepted for every row in sheet order, to paste at the first one.
export function sheetBlock(): string {
  const cell = (v: string) => {
    const text = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [...sheet.keys()]
    .map((iso3) => {
      const d = decisions.get(iso3)!;
      const source = d.noSourceSuitable ? "none" : (d.selectedSource ?? "");
      return [source, cell(d.rationale), d.accepted ? "TRUE" : "FALSE"].join("\t");
    })
    .join("\n");
}

if (import.meta.env.DEV && typeof localStorage !== "undefined") {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(EDITS_KEY) ?? "{}");
  } catch {
    stored = {};
  }
  if (stored && typeof stored === "object") {
    for (const [iso3, value] of Object.entries(stored)) {
      const { edit, base } = (value ?? {}) as { edit?: PickEdit; base?: string };
      const original = sheet.get(iso3);
      // Dropped once decisions.csv holds it, or when the sheet changed under it.
      if (!edit || !original || base !== key(original) || key(edit) === key(original)) continue;
      pickEdits.set(iso3, edit);
      decisions.set(iso3, { iso3, ...edit });
    }
  }
  save();
}
