import type { AdminLevel } from "$lib/explorer/map/layers/admin";
import { codAbUrl, explorerTilesUrl } from "$lib/utils/data";

export const ADMIN_SOURCES = [
  {
    id: "ocha",
    label: "OCHA",
    levels: [1, 2, 3, 4] as AdminLevel[],
    nameField: "adm{level}_name",
    codeField: "adm{level}_pcode",
    countryCodeField: "iso3",
  },
  {
    id: "wfp",
    label: "WFP",
    levels: [1, 2, 3, 4] as AdminLevel[],
    nameField: "adm{level}_name",
    codeField: "source_id",
    countryCodeField: "iso3",
    // "Under National Administration" is a filler polygon standing in for
    // areas without a real admin unit — mostly lakes/seas, but also at least
    // one non-water case (the Korea DMZ) — not a genuine subdivision either
    // way. "N/A"/"Undefined" are the same idea: a polygon with no real name
    // attached isn't usable, differentiated admin data, whether it covers a
    // single sliver or (for some small territories) 100% of that country's
    // rows at this level — showing nothing is preferable to a fake unit.
    junkNameField: "adm{level}_name",
    junkNameValues: ["Under National Administration", "N/A", "Undefined"],
  },
  {
    id: "unicef",
    label: "UNICEF",
    levels: [1, 2, 3, 4] as AdminLevel[],
    nameField: "name",
    codeField: "Source_ID",
    countryCodeField: "adm0_ucode",
    // Same filler convention as WFP (see above).
    junkNameField: "name",
    junkNameValues: ["Under National Administration", "N/A", "Undefined"],
    // Hand-picked exact-match names for polygons carried as literal named
    // features rather than routed through a placeholder — never a
    // substring/keyword match, since e.g. "Lake Placid" (a real NY region)
    // would false-positive on any generic "lake" pattern. Verified per name:
    // Burundi's adm2 "Lake Tanganyika" traces the lake shoreline exactly.
    namedWaterBodies: ["Lake Tanganyika"],
  },
  {
    id: "unhcr",
    label: "UNHCR",
    levels: [1, 2] as AdminLevel[],
    nameField: "gis_name",
    codeField: "adm{level}_source_code",
    countryCodeField: "iso3",
  },
  {
    id: "fao",
    label: "FAO",
    levels: [1, 2] as AdminLevel[],
    nameField: "GAUL{level}_NAME",
    codeField: "GAUL{level}_CODE",
    countryCodeField: "ISO3_CODE",
    // Same filler convention as WFP/UNICEF (see above). "Administrative Unit
    // Not Available" is FAO's own no-name-data placeholder — same as "N/A"
    // elsewhere, including several small territories where it's 100% of that
    // territory's rows at this level.
    junkNameField: "GAUL{level}_NAME",
    junkNameValues: ["Waterbody", "Undefined", "Administrative Unit Not Available"],
  },
];

export function getLevelsForSource(sourceId: string): AdminLevel[] {
  return ADMIN_SOURCES.find((s) => s.id === sourceId)?.levels ?? [];
}

export interface AdminTiles {
  url: string;
  layer: string;
  labelsUrl: string;
  labelsLayer: string;
  idField: string;
}

// OCHA reads COD-AB's global layers; partner layers carry a per-row hover_id.
export function adminTiles(sourceId: string, level: number): AdminTiles {
  if (sourceId === "ocha") {
    const dir = `global/admin${level}`;
    return {
      url: codAbUrl(`${dir}/admin${level}.pmtiles`),
      layer: `admin${level}`,
      labelsUrl: codAbUrl(`${dir}/admin${level}_points.pmtiles`),
      labelsLayer: `admin${level}_points`,
      idField: `adm${level}_pcode`,
    };
  }
  const layer = `${sourceId}_adm${level}`;
  return {
    url: explorerTilesUrl(layer),
    layer,
    labelsUrl: explorerTilesUrl(layer, `${layer}_labels.pmtiles`),
    labelsLayer: `${layer}_labels`,
    idField: "hover_id",
  };
}
