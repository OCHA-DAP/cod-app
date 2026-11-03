import type * as maplibregl from "maplibre-gl";
import { adminTiles } from "$lib/explorer/sources";
import { MAP_COLORS, MAP_STATUS_OPACITY, MAP_TINT_OPACITY } from "$lib/utils/mapColors";

export const ADMIN_LEVELS = [1, 2, 3, 4] as const;
export type AdminLevel = (typeof ADMIN_LEVELS)[number];

export function adminLayersForSource(
  sourceId: string,
  level: AdminLevel,
  nameField: string,
  codeField: string,
  countryCodeField: string,
): maplibregl.LayerSpecification[] {
  const source = `${sourceId}-adm${level}`;
  const { layer: sourceLayer, labelsLayer } = adminTiles(sourceId, level);
  return [
    {
      id: `${sourceId}-adm${level}-fill`,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      filter: ["==", ["get", countryCodeField], ""],
      layout: { visibility: "none" },
      paint: { "fill-color": MAP_COLORS.original, "fill-opacity": MAP_TINT_OPACITY },
    },
    {
      id: `${sourceId}-adm${level}-mismatch`,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      filter: ["==", ["get", countryCodeField], ""],
      layout: { visibility: "none" },
      paint: { "fill-color": MAP_COLORS.error, "fill-opacity": MAP_STATUS_OPACITY },
    },
    {
      id: `${sourceId}-adm${level}-hover`,
      type: "line",
      source,
      "source-layer": sourceLayer,
      // Scoped to the selected country like -fill/-line; which feature within
      // that is highlighted is driven by feature-state (see hover-admin.ts),
      // keyed off the source's promoted id (see adminTiles).
      filter: ["==", ["get", countryCodeField], ""],
      layout: { visibility: "none" },
      paint: {
        "line-color": MAP_COLORS.selected,
        "line-width": 3,
        "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0],
      },
    },
    {
      id: `${sourceId}-adm${level}-line`,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", ["get", countryCodeField], ""],
      layout: { visibility: "none" },
      paint: { "line-color": MAP_COLORS.outline, "line-width": 1 },
    },
    {
      id: `${sourceId}-adm${level}-label`,
      type: "symbol",
      source: `${sourceId}-adm${level}-labels`,
      "source-layer": labelsLayer,
      filter: ["==", ["get", countryCodeField], ""],
      layout: {
        visibility: "none",
        "text-field": [
          "format",
          ["get", nameField],
          {},
          ["case", ["has", codeField], ["concat", "\n", ["get", codeField]], ""],
          { "font-scale": 0.75 },
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-anchor": "center",
        "text-max-width": 8,
      },
      paint: {
        "text-color": "#002e6e",
        "text-halo-color": "rgba(255,255,255,0.85)",
        "text-halo-width": 1.5,
      },
    },
  ];
}
