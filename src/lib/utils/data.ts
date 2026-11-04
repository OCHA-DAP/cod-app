export const DATA_BASE = "https://data.source.coop/hdx/cod-site";
export const COD_AB_BASE = "https://data.source.coop/hdx/cod-ab";

export function codAbUrl(path: string): string {
  return `${COD_AB_BASE}/${path}`;
}

// Mirrors item_dir in scripts/catalog/common.py: explorer/<source>/<layer>/ holds each boundary layer.
export function explorerTilesUrl(layer: string, file = `${layer}.pmtiles`): string {
  return `${DATA_BASE}/explorer/${layer.split("_")[0]}/${layer}/${file}`;
}

export function referenceUrl(table: string): string {
  return `${DATA_BASE}/explorer/reference/${table}/${table}.parquet`;
}

export function toolsUrl(path: string): string {
  return `${DATA_BASE}/tools/${path}`;
}
