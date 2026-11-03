import { ADMIN_SOURCES, adminTiles } from "$lib/explorer/sources";
import { explorerTilesUrl } from "$lib/utils/data";
import type * as maplibregl from "maplibre-gl";
import positron from "$lib/utils/basemap/positron.json";
import { adminLayersForSource } from "./layers/admin";
import { layers as countriesLayers } from "./layers/countries";
import { layers as countryLineLayers } from "./layers/country-lines";

const pmtiles = (layer: string, file?: string) => `pmtiles://${explorerTilesUrl(layer, file)}`;

const admSources = Object.fromEntries(
  ADMIN_SOURCES.flatMap((src) =>
    src.levels.flatMap((l) => {
      const tiles = adminTiles(src.id, l);
      return [
        [
          `${src.id}-adm${l}`,
          {
            type: "vector" as const,
            url: `pmtiles://${tiles.url}`,
            // A unique per-row id lets MapLibre's promoteId/feature-state target one row.
            promoteId: { [tiles.layer]: tiles.idField },
          },
        ],
        [
          `${src.id}-adm${l}-labels`,
          { type: "vector" as const, url: `pmtiles://${tiles.labelsUrl}` },
        ],
      ];
    }),
  ),
);

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sprite: positron.sprite,
  glyphs: positron.glyphs,
  sources: {
    ...(positron.sources as maplibregl.StyleSpecification["sources"]),
    countries: {
      type: "vector",
      url: pmtiles("ungeodata_adm0"),
      promoteId: { ungeodata_adm0: "objectid" },
    },
    "country-lines": {
      type: "vector",
      url: pmtiles("ungeodata_lines"),
    },
    ...admSources,
  },
  layers: [
    ...(positron.layers as maplibregl.LayerSpecification[]),
    ...countriesLayers,
    ...countryLineLayers,
    ...ADMIN_SOURCES.flatMap((src) =>
      src.levels.flatMap((l) =>
        adminLayersForSource(
          src.id,
          l,
          src.nameField.replace("{level}", String(l)),
          src.codeField.replace("{level}", String(l)),
          src.countryCodeField,
        ),
      ),
    ),
  ],
};

export default MAP_STYLE;
