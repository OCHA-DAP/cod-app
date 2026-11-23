const HDX = "https://data.humdata.org";

export const hdxDatasetUrl = (dataset: "cod-ab" | "cod-ps", iso3: string): string =>
  `${HDX}/dataset/${dataset}-${iso3.toLowerCase()}`;

export interface HdxDownload {
  label: string;
  url: string;
}

// HDX resource format for each download, in menu order.
const FORMATS: [string, string][] = [
  ["geodatabase", "Geodatabase"],
  ["shp", "Shapefile"],
  ["geojson", "GeoJSON"],
  ["xlsx", "Excel"],
];

// Read at view time, so a dataset update that replaces a resource never leaves a stale link.
export async function hdxDownloads(iso3: string): Promise<HdxDownload[]> {
  const res = await fetch(`${HDX}/api/3/action/package_show?id=cod-ab-${iso3.toLowerCase()}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    result?: { resources?: { format?: string; url?: string }[] };
  };
  const resources = body.result?.resources ?? [];
  return FORMATS.flatMap(([format, label]) => {
    const r = resources.find((x) => x.format?.toLowerCase() === format && x.url);
    return r?.url ? [{ label, url: r.url }] : [];
  });
}
