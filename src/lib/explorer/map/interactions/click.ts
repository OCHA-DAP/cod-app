import { selectCountry } from "$lib/explorer/map/admin";
import { selectedIso3 } from "$lib/explorer/map/store";
import type * as maplibregl from "maplibre-gl";
import { get } from "svelte/store";

export function addClickInteraction(
  map: maplibregl.Map,
  onSelect: (iso3: string) => void = (iso3) => selectCountry(map, iso3),
): void {
  map.on("click", "countries-hover", (e) => {
    if (!e.features?.length) return;

    const iso3: string | undefined = e.features[0].properties?.iso3cd;
    if (!iso3 || iso3 === get(selectedIso3)) return;

    onSelect(iso3);
  });
}
