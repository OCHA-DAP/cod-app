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
  const { layer, labelsLayer } = adminTiles(sourceId, level);
  return adminLayers({
    id: `${sourceId}-adm${level}`,
    source: `${sourceId}-adm${level}`,
    sourceLayer: layer,
    labelsSource: `${sourceId}-adm${level}-labels`,
    labelsLayer,
    nameField,
    codeField,
    hiddenFilter: ["==", ["get", countryCodeField], ""],
  });
}

// Layer ids adminLayers creates, each as `${id}-${suffix}`.
export const ADMIN_LAYER_SUFFIXES = ["fill", "mismatch", "hover", "line", "label"] as const;

// One admin level's fill, mismatch, hover, line and label layers, shared by both explorer tabs.
export function adminLayers(o: {
  id: string;
  source: string;
  sourceLayer: string;
  labelsSource: string;
  labelsLayer: string;
  nameField: string;
  codeField: string;
  hiddenFilter?: maplibregl.FilterSpecification;
}): maplibregl.LayerSpecification[] {
  const scope = o.hiddenFilter
    ? { filter: o.hiddenFilter, layout: { visibility: "none" as const } }
    : {};
  return [
    {
      id: `${o.id}-fill`,
      type: "fill",
      source: o.source,
      "source-layer": o.sourceLayer,
      ...scope,
      paint: { "fill-color": MAP_COLORS.original, "fill-opacity": MAP_TINT_OPACITY },
    },
    {
      id: `${o.id}-mismatch`,
      type: "fill",
      source: o.source,
      "source-layer": o.sourceLayer,
      filter: o.hiddenFilter ?? ["literal", false],
      layout: { visibility: "none" },
      paint: { "fill-color": MAP_COLORS.error, "fill-opacity": MAP_STATUS_OPACITY },
    },
    {
      id: `${o.id}-hover`,
      type: "line",
      source: o.source,
      "source-layer": o.sourceLayer,
      // Which feature is highlighted is driven by feature-state (see hover-admin.ts),
      // keyed off the source's promoted id.
      ...scope,
      paint: {
        "line-color": MAP_COLORS.selected,
        "line-width": 3,
        "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0],
      },
    },
    {
      id: `${o.id}-line`,
      type: "line",
      source: o.source,
      "source-layer": o.sourceLayer,
      ...scope,
      paint: { "line-color": MAP_COLORS.outline, "line-width": 1 },
    },
    {
      id: `${o.id}-label`,
      type: "symbol",
      source: o.labelsSource,
      "source-layer": o.labelsLayer,
      ...(o.hiddenFilter ? { filter: o.hiddenFilter } : {}),
      layout: {
        visibility: o.hiddenFilter ? "none" : "visible",
        "text-field": [
          "format",
          ["get", o.nameField],
          {},
          ["case", ["has", o.codeField], ["concat", "\n", ["get", o.codeField]], ""],
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
