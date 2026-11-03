import { toolsUrl } from "$lib/utils/data";

// Admin 1 views the intro cycles through, from the catalog's tools/sources collection: OCHA's COD-AB first, then an older source.
export const PMTILES_URL = toolsUrl("sources/sources_adm1.pmtiles");
export const PMTILES_LAYER = "sources_adm1";

const SOURCES = {
  ocha: "OCHA",
  wfp: "WFP",
  unicef: "UNICEF",
  fao: "FAO",
  wb: "World Bank",
} as const;

type SourceId = keyof typeof SOURCES;
type Bbox = [number, number, number, number];

const COUNTRIES: Record<string, { name: string; bbox: Bbox }> = {
  CAF: { name: "Central African Republic", bbox: [14.42, 2.22, 27.46, 11.01] },
  MLI: { name: "Mali", bbox: [-12.24, 10.15, 4.24, 25.0] },
  BFA: { name: "Burkina Faso", bbox: [-5.51, 9.41, 2.41, 15.08] },
  GHA: { name: "Ghana", bbox: [-3.26, 4.74, 1.2, 11.17] },
  SSD: { name: "South Sudan", bbox: [24.15, 3.49, 35.95, 12.24] },
  MDG: { name: "Madagascar", bbox: [43.18, -25.61, 50.49, -11.95] },
};

const views: { iso3: string; source: SourceId; year?: number; units: number }[] = [
  { iso3: "MLI", source: "ocha", year: 2025, units: 20 },
  { iso3: "MLI", source: "wfp", year: 2023, units: 10 },
  { iso3: "BFA", source: "ocha", year: 2025, units: 17 },
  { iso3: "BFA", source: "unicef", units: 13 },
  { iso3: "GHA", source: "ocha", year: 2021, units: 16 },
  { iso3: "GHA", source: "unicef", units: 10 },
  { iso3: "CAF", source: "ocha", year: 2023, units: 20 },
  { iso3: "CAF", source: "fao", units: 7 },
  { iso3: "SSD", source: "ocha", year: 2020, units: 10 },
  { iso3: "SSD", source: "wb", units: 12 },
  { iso3: "MDG", source: "ocha", units: 24 },
  { iso3: "MDG", source: "wb", units: 6 },
];

export const explorerViews = views.map((v) => ({
  ...v,
  id: `${v.iso3}-${v.source}`,
  bbox: COUNTRIES[v.iso3].bbox,
  caption: `${COUNTRIES[v.iso3].name} · ${SOURCES[v.source]}${v.year ? ` ${v.year}` : ""} · admin 1 · ${v.units} units`,
}));
