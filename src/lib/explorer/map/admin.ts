import { getBboxForIso3 } from "$lib/explorer/parquet/bbox";
import { getMatchForCountry } from "$lib/explorer/parquet/sourceMatch";
import { getStatsForCountry, type SourceStat } from "$lib/explorer/parquet/sourceStats";
import { getDecision, type Decision } from "$lib/explorer/decisions";
import { ADMIN_SOURCES, adminTiles, getLevelsForSource } from "$lib/explorer/sources";
import type { ViewState } from "$lib/explorer/urlState";
import type * as maplibregl from "maplibre-gl";
import { get } from "svelte/store";
import { allLocations, labelsEnabled, selectedAdmin, selectedIso3, selectedSource } from "./store";

function sourceHasData(stats: SourceStat[], source: string): boolean {
  return stats.some((s) => s.source === source && s.featureCount > 0);
}

// Deepest ("lowest" in admin-hierarchy terms — most granular, e.g. admin4
// over admin1) configured level for `source` that has data for this
// country, or the source's deepest configured level if none has data.
function pickDeepestLevelWithData(stats: SourceStat[], source: string): number {
  const levels = getLevelsForSource(source);
  if (levels.length === 0) return 1;

  const hasData = (l: number) =>
    stats.some((s) => s.source === source && s.level === l && s.featureCount > 0);
  return [...levels].reverse().find(hasData) ?? levels[levels.length - 1];
}

// The configured level for `source` with the most admin units for this
// country — not simply the deepest level with any data, since a deeper
// level is sometimes only partially populated (e.g. admin4 defined for a
// single city) while a shallower level has full national coverage and far
// more total units. Used only for the default level shown on country
// selection; manual source switching keeps pickLevel/pickDeepestLevelWithData's
// "deepest level with any data" semantics.
function pickLevelWithMostUnits(stats: SourceStat[], source: string): number {
  const levels = getLevelsForSource(source);
  if (levels.length === 0) return 1;

  return levelWithMostUnits(
    levels,
    (l) => stats.find((s) => s.source === source && s.level === l)?.featureCount ?? 0,
  );
}

// The level with the most units, the first on a tie; the level both pages open a location on.
export function levelWithMostUnits<L extends number>(
  levels: readonly L[],
  count: (l: L) => number,
): L {
  return levels.reduce((best, l) => (count(l) > count(best) ? l : best), levels[0]);
}

// Runs fn on the first render after the source's tiles have loaded; returns a cancel function.
export function whenSourceLoaded(
  map: maplibregl.Map,
  sourceId: string,
  fn: () => void,
): () => void {
  const onRender = () => {
    if (!map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) return;
    map.off("render", onRender);
    fn();
  };
  map.on("render", onRender);
  return () => map.off("render", onRender);
}

// Resolves which level to show for a source/country: keeps `level` if that
// source actually has data at that level for this country, otherwise falls
// back to the deepest level that does (or the source's deepest configured
// level if it has no data at all).
async function pickLevel(iso3: string, source: string, level: number): Promise<number> {
  const levels = getLevelsForSource(source);
  if (levels.length === 0) return level;

  const stats = await getStatsForCountry(iso3);
  const hasData = (l: number) =>
    stats.some((s) => s.source === source && s.level === l && s.featureCount > 0);

  if (levels.includes(level as (typeof levels)[number]) && hasData(level)) return level;
  return pickDeepestLevelWithData(stats, source);
}

// Default source on country select: the team's pick if it has data (accepted or pending), else the first
// ADMIN_SOURCES entry with data; null (leave as is) when the team picked none or no source has data.
function resolveDefaultSource(decision: Decision | null, stats: SourceStat[]): string | null {
  if (decision?.noSourceSuitable) return null;

  if (decision?.selectedSource && sourceHasData(stats, decision.selectedSource)) {
    return decision.selectedSource;
  }

  return ADMIN_SOURCES.find((s) => sourceHasData(stats, s.id))?.id ?? null;
}

let keptIso3: string | null = null;
let fittedIso3: string | null = null;

// A camera carried over from the other explorer page makes fits for its location jump, not fly.
export function keepCamera(iso3: string | null): void {
  keptIso3 = iso3;
}

// The location the camera was last fit to, so a camera saved mid-flight isn't filed under the next one.
export const lastFittedIso3 = (): string | null => fittedIso3;

// Fits the map to a country's bbox. Split out from selectCountry so it can also
// be re-run on map resize, when the previously fit zoom/pan no longer matches
// the container's new dimensions.
export async function fitCountryBounds(map: maplibregl.Map, iso3: string): Promise<void> {
  if (iso3 !== keptIso3) keptIso3 = null;
  fittedIso3 = null;
  const bbox = await getBboxForIso3(iso3);
  if (!bbox) return;

  // An interrupted move still fires its moveend, so only this fit's own moveend marks it settled.
  const fit = {};
  const settled = (e: object) => {
    if (!("fit" in e) || e.fit !== fit) return;
    map.off("moveend", settled);
    fittedIso3 = iso3;
  };
  map.on("moveend", settled);
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 50, animate: iso3 !== keptIso3 },
    { fit },
  );
}

// Sets the selected country, fits the map to its bbox, resolves the default
// source for this country (team decision, else priority-list fallback — see
// resolveDefaultSource) at the level with the most admin units, and applies
// the resulting source/level filter. Shared by CountrySidebar's row clicks
// and the page's URL view handling (applyView) so both go through the same
// sequence. Always re-resolves the source on every call — there's no
// stickiness of a previously-selected source across country switches. An
// explicit `view` source (and optionally level) from the URL skips that.
export async function selectCountry(
  map: maplibregl.Map | null,
  iso3: string,
  view: { source?: string; level?: number } = {},
): Promise<void> {
  if (!iso3) return selectGlobal(map, view);
  selectedIso3.set(iso3);

  const [, stats] = await Promise.all([
    map ? fitCountryBounds(map, iso3) : Promise.resolve(),
    getStatsForCountry(iso3),
  ]);
  const decision = getDecision(iso3);

  const source = view.source ?? resolveDefaultSource(decision, stats);
  if (source !== null) {
    selectedSource.set(source);
    selectedAdmin.set(view.level ?? pickLevelWithMostUnits(stats, source));
  }

  if (!map) return;
  applyAdminFilter(map, iso3);
  applyMismatchHighlight(map, iso3);
}

// The source's level nearest to `level` among those it serves, for views with no location's stats.
function sourceLevel(source: string, level: number): number {
  const levels: number[] = getLevelsForSource(source);
  return levels.includes(level) ? level : (levels[0] ?? level);
}

// Global mode: no location selected, the active source and level drawn for every location.
export function selectGlobal(
  map: maplibregl.Map | null,
  view: { source?: string; level?: number } = {},
): void {
  selectedIso3.set("");
  allLocations.set(true);
  const source = view.source ?? get(selectedSource);
  selectedSource.set(source);
  selectedAdmin.set(sourceLevel(source, view.level ?? get(selectedAdmin)));
  if (!map) return;
  fitWorld(map);
  applyAdminFilter(map, "");
}

export function fitWorld(map: maplibregl.Map): void {
  keptIso3 = null;
  fittedIso3 = null;
  map.fitBounds(
    [
      [-180, -60],
      [180, 80],
    ],
    { padding: 20 },
  );
}

// Switches to a source, keeping the current admin level if it has data for
// this country, otherwise falling back to the deepest level that does. Used
// by CountrySidebar's [ ]-keyboard cycling and StatsComparisonTable's row
// clicks.
export async function selectSource(
  map: maplibregl.Map | null,
  iso3: string,
  source: string,
): Promise<void> {
  selectedSource.set(source);
  if (!iso3 && !get(allLocations)) return;

  selectedAdmin.set(
    iso3 ? await pickLevel(iso3, source, get(selectedAdmin)) : sourceLevel(source, get(selectedAdmin)),
  );

  if (!map) return;
  applyAdminFilter(map, iso3);
  applyMismatchHighlight(map, iso3);
}

// Switches to an exact source/level pair. Used by StatsComparisonTable's cell
// clicks, where the level is already known to be valid for the source.
export function selectSourceLevel(
  map: maplibregl.Map | null,
  iso3: string,
  source: string,
  level: number,
): void {
  selectedSource.set(source);
  selectedAdmin.set(level);

  if (!map) return;
  applyAdminFilter(map, iso3);
  applyMismatchHighlight(map, iso3);
}

// Applies a URL view (see $lib/explorer/urlState): a new country goes through
// selectCountry, the same country only switches source/level.
export async function applyView(map: maplibregl.Map | null, view: ViewState): Promise<void> {
  if (view.iso3 === "ALL") return selectGlobal(map, view);
  if (!view.iso3) return;
  if (view.iso3 !== get(selectedIso3)) return selectCountry(map, view.iso3, view);
  if (view.source && view.level) selectSourceLevel(map, view.iso3, view.source, view.level);
  else if (view.source) await selectSource(map, view.iso3, view.source);
}

let cancelPendingHide: (() => void) | null = null;

export function applyAdminFilter(map: maplibregl.Map, iso3: string): void {
  const activeLevel = get(selectedAdmin);
  const activeSource = get(selectedSource);
  const showLabels = get(labelsEnabled);

  // Cancel any in-progress hide from a previous switch
  if (cancelPendingHide) {
    cancelPendingHide();
    cancelPendingHide = null;
  }

  // Immediately show the new active layer (kicks off tile loading)
  for (const src of ADMIN_SOURCES) {
    for (const l of src.levels) {
      if (src.id === activeSource && l === activeLevel) {
        map.setLayoutProperty(`${src.id}-adm${l}-fill`, "visibility", "visible");
        map.setLayoutProperty(`${src.id}-adm${l}-hover`, "visibility", "visible");
        map.setLayoutProperty(`${src.id}-adm${l}-line`, "visibility", "visible");
        map.setLayoutProperty(
          `${src.id}-adm${l}-label`,
          "visibility",
          showLabels ? "visible" : "none",
        );
        // Left hidden here; applyMismatchHighlight (called right after this
        // function) decides whether there's anything to highlight.
        map.setLayoutProperty(`${src.id}-adm${l}-mismatch`, "visibility", "none");

        // An empty iso3 is global mode: every location.
        const countryFilter: maplibregl.ExpressionSpecification = iso3
          ? ["==", ["slice", ["get", src.countryCodeField], 0, 3], iso3]
          : ["literal", true];
        const excludeNames = [...(src.junkNameValues ?? []), ...(src.namedWaterBodies ?? [])];
        const filter: maplibregl.FilterSpecification = excludeNames.length
          ? [
              "all",
              countryFilter,
              [
                "!",
                [
                  "in",
                  ["get", src.junkNameField!.replace("{level}", String(l))],
                  ["literal", excludeNames],
                ],
              ],
            ]
          : countryFilter;

        map.setFilter(`${src.id}-adm${l}-fill`, filter);
        map.setFilter(`${src.id}-adm${l}-hover`, filter);
        map.setFilter(`${src.id}-adm${l}-line`, filter);
        map.setFilter(`${src.id}-adm${l}-label`, filter);
      }
    }
  }

  // Hide old layers the moment the new source's tiles are ready
  const newSourceId = `${activeSource}-adm${activeLevel}`;

  cancelPendingHide = whenSourceLoaded(map, newSourceId, () => {
    for (const src of ADMIN_SOURCES) {
      for (const l of src.levels) {
        if (src.id !== activeSource || l !== activeLevel) {
          map.setLayoutProperty(`${src.id}-adm${l}-fill`, "visibility", "none");
          map.setLayoutProperty(`${src.id}-adm${l}-hover`, "visibility", "none");
          map.setLayoutProperty(`${src.id}-adm${l}-line`, "visibility", "none");
          map.setLayoutProperty(`${src.id}-adm${l}-label`, "visibility", "none");
          map.setLayoutProperty(`${src.id}-adm${l}-mismatch`, "visibility", "none");
          map.setFilter(`${src.id}-adm${l}-fill`, ["==", ["get", src.countryCodeField], ""]);
          map.setFilter(`${src.id}-adm${l}-hover`, ["==", ["get", src.countryCodeField], ""]);
          map.setFilter(`${src.id}-adm${l}-line`, ["==", ["get", src.countryCodeField], ""]);
          map.setFilter(`${src.id}-adm${l}-label`, ["==", ["get", src.countryCodeField], ""]);
          map.setFilter(`${src.id}-adm${l}-mismatch`, ["==", ["get", src.countryCodeField], ""]);
        }
      }
    }
    cancelPendingHide = null;
  });
}

// No highlight when the active source is the team's own pick (see StatsComparisonTable).
export async function applyMismatchHighlight(map: maplibregl.Map, iso3: string): Promise<void> {
  const activeSource = get(selectedSource);
  const activeLevel = get(selectedAdmin);
  const src = ADMIN_SOURCES.find((s) => s.id === activeSource);
  const layerId = `${activeSource}-adm${activeLevel}-mismatch`;
  if (!src || !iso3) return;

  const decision = getDecision(iso3);
  const matches = await getMatchForCountry(iso3);

  // Bail if a newer selectSource/selectSourceLevel call landed while awaiting.
  if (get(selectedSource) !== activeSource || get(selectedAdmin) !== activeLevel) return;

  const preferredSource = decision?.selectedSource;
  const match =
    preferredSource && activeSource !== preferredSource
      ? matches.find(
          (m) =>
            m.source === activeSource &&
            m.level === activeLevel &&
            m.preferredSource === preferredSource,
        )
      : undefined;

  if (match && match.unmatchedCodes.length) {
    // MapLibre's "in" is type-strict and tile ids can decode as numbers, so compare strings.
    map.setFilter(layerId, [
      "all",
      ["==", ["slice", ["get", src.countryCodeField], 0, 3], iso3],
      [
        "in",
        ["to-string", ["get", adminTiles(activeSource, activeLevel).idField]],
        ["literal", match.unmatchedCodes],
      ],
    ]);
    map.setLayoutProperty(layerId, "visibility", "visible");
  } else {
    map.setLayoutProperty(layerId, "visibility", "none");
  }
}

export function initLabelsToggle(map: maplibregl.Map): void {
  labelsEnabled.subscribe((enabled) => {
    if (!get(selectedIso3) && !get(allLocations)) return;
    const activeSource = get(selectedSource);
    const activeLevel = get(selectedAdmin);
    map.setLayoutProperty(
      `${activeSource}-adm${activeLevel}-label`,
      "visibility",
      enabled ? "visible" : "none",
    );
  });
}
