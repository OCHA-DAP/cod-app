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

export const decisions = parseDecisions(csv);

export function getDecision(iso3: string): Decision | null {
  return decisions.get(iso3) ?? null;
}
