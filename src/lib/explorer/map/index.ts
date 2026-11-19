import * as maplibregl from "maplibre-gl";
import { get } from "svelte/store";
import { fitCountryBounds, initLabelsToggle } from "./admin";
import {
  addAdminHoverInteraction,
  addClickInteraction,
  addHoverInteraction,
} from "./interactions/index";
import { createSpin } from "./spin";
import { mapStore, selectedIso3 } from "./store";
import MAP_STYLE from "./style";
import { MAP_DISCLAIMER } from "$lib/utils/mapDisclaimer";
import { pmtilesProtocol } from "$lib/utils/pmtiles";

// The explorer globe both tabs draw on: idle spin, refit on resize, location hover and click.
export function createExplorerMap(
  container: HTMLDivElement,
  { style, onSelect }: { style: maplibregl.StyleSpecification; onSelect?: (iso3: string) => void },
): { map: maplibregl.Map; destroy: () => void } {
  pmtilesProtocol(maplibregl);

  const map = new maplibregl.Map({
    container,
    style,
    center: [20, 5],
    zoom: 3,
    attributionControl: { compact: true, customAttribution: MAP_DISCLAIMER },
  });

  map.on("style.load", () => {
    map.setProjection({ type: "globe" });
  });

  // Idle globe spin, shown only until a location is picked or the user touches the map;
  // one way, since nothing returns to the overview once a location is selected.
  const spin = createSpin(() => map);
  let interacted = false;

  function stopSpinPermanently() {
    interacted = true;
    spin.stop();
  }

  map.once("load", () => {
    if (!interacted && !get(selectedIso3)) spin.start();
  });
  map.on("mousedown", stopSpinPermanently);
  map.on("touchstart", stopSpinPermanently);
  map.on("wheel", stopSpinPermanently);

  const unsubscribeSpin = selectedIso3.subscribe((iso3) => {
    if (iso3) stopSpinPermanently();
  });

  function handleVisibilityChange() {
    if (document.hidden) spin.stop();
    else if (!interacted && !get(selectedIso3)) spin.start();
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  map.on("resize", () => {
    const iso3 = get(selectedIso3);
    if (iso3) fitCountryBounds(map, iso3);
  });

  addHoverInteraction(map);
  addClickInteraction(map, onSelect);

  return {
    map,
    destroy() {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribeSpin();
      spin.stop();
      map.remove();
    },
  };
}

export function initMap(container: HTMLDivElement): () => void {
  const { map, destroy } = createExplorerMap(container, { style: MAP_STYLE });
  mapStore.set(map);
  addAdminHoverInteraction(map);
  initLabelsToggle(map);

  return () => {
    mapStore.set(null);
    destroy();
  };
}
