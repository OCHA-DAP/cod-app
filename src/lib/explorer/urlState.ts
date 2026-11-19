import { ADMIN_SOURCES } from "$lib/explorer/sources";

export interface ViewState {
  iso3: string;
  source?: string;
  level?: number;
  kiosk: boolean;
}

function parseView(params: URLSearchParams): ViewState {
  const source = params.get("source") ?? "";
  const level = Number(params.get("level"));
  return {
    iso3: (params.get("iso3") ?? params.get("country") ?? "").toUpperCase(),
    source: ADMIN_SOURCES.some((s) => s.id === source) ? source : undefined,
    level: Number.isInteger(level) && level > 0 ? level : undefined,
    kiosk: params.has("kiosk"),
  };
}

// A hash view wins over the query string, so an embedding page can drive the map by changing
// only the hash, which fires hashchange instead of reloading the iframe.
export function viewFromUrl(url: URL | Location): ViewState {
  const hash = new URLSearchParams(url.hash.slice(1));
  return parseView(hash.size > 0 ? hash : new URLSearchParams(url.search));
}

// Kiosk, source and hash views are the Partners tab's, so /explorer/ links carrying them go there.
export function isPartnersView(url: URL | Location): boolean {
  const params = new URLSearchParams(url.search);
  return url.hash.length > 1 || params.has("kiosk") || params.has("source");
}
