// The dev server serves a built local catalog/ at /catalog (astro.config.mjs).
export const DATA_BASE =
  import.meta.env.DEV && import.meta.env.LOCAL_CATALOG && globalThis.location
    ? `${globalThis.location.origin}/catalog`
    : "https://data.source.coop/hdx/cod-site";

// Mirrors cod_data/catalog/global_build/publish.py: global/ holds adm{n}-{geom}/ and iso3/<iso3>/.
export function globalUrl(path: string): string {
  return `${DATA_BASE}/global/${path}`;
}

// Mirrors item_dir in cod_data/catalog/common.py: explorer/<source>/<layer>/ holds each boundary layer.
export function explorerTilesUrl(layer: string, file = `${layer}.pmtiles`): string {
  return `${DATA_BASE}/explorer/${layer.split("_")[0]}/${layer}/${file}`;
}

export function referenceUrl(table: string): string {
  return `${DATA_BASE}/explorer/reference/${table}/${table}.parquet`;
}

export function toolsUrl(path: string): string {
  return `${DATA_BASE}/tools/${path}`;
}
