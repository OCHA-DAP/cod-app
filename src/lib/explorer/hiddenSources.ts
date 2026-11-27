import { derived, writable } from "svelte/store";
import { getDecision } from "$lib/explorer/decisions";
import { selectedIso3, selectedSource } from "$lib/explorer/map/store";
import { ADMIN_SOURCES } from "$lib/explorer/sources";

const KEY = "explorer-source-choice";
export const DEFAULT_HIDDEN = ADMIN_SOURCES.filter((s) => "hiddenByDefault" in s).map((s) => s.id);

// The viewer's saved choice, else the defaults.
function initial(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(ids)) return ids.filter((id) => ADMIN_SOURCES.some((s) => s.id === id));
  } catch {
    // Unreadable storage falls back to the defaults.
  }
  return DEFAULT_HIDDEN;
}

export const hiddenSources = writable<string[]>(
  typeof localStorage === "undefined" ? DEFAULT_HIDDEN : initial(),
);

export function toggleSource(id: string): void {
  hiddenSources.update((ids) => {
    const next = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  });
}

export function resetSources(): void {
  localStorage.removeItem(KEY);
  hiddenSources.set(DEFAULT_HIDDEN);
}

// Every source not hidden, plus the active one and the location's pick, which always keep their columns.
export const shownSources = derived(
  [hiddenSources, selectedSource, selectedIso3],
  ([hidden, active, iso3]) => {
    const pick = iso3 ? getDecision(iso3)?.selectedSource : null;
    return ADMIN_SOURCES.filter((s) => !hidden.includes(s.id) || s.id === active || s.id === pick);
  },
);
