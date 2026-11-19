import * as maplibregl from "maplibre-gl";
import { get } from "svelte/store";
import { fitCountryBounds, initLabelsToggle, keepCamera, lastFittedIso3 } from "./admin";
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
import { viewFromUrl } from "$lib/explorer/urlState";

const CAMERA_KEY = "explorer-camera";

// Camera saved by the other explorer page for the same location, so switching pages doesn't refly from the globe.
function savedCamera(): { iso3: string; center: [number, number]; zoom: number } | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(CAMERA_KEY) ?? "null");
    return c && c.iso3 && c.iso3 === viewFromUrl(location).iso3 ? c : null;
  } catch {
    return null;
  }
}

// The explorer globe both pages draw on: idle spin, refit on resize, location hover and click.
export function createExplorerMap(
  container: HTMLDivElement,
  { style, onSelect }: { style: maplibregl.StyleSpecification; onSelect?: (iso3: string) => void },
): { map: maplibregl.Map; destroy: () => void } {
  pmtilesProtocol(maplibregl);

  const camera = savedCamera();
  keepCamera(camera?.iso3 ?? null);
  const map = new maplibregl.Map({
    container,
    style,
    center: camera?.center ?? [20, 5],
    zoom: camera?.zoom ?? 3,
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
  function onTouch() {
    stopSpinPermanently();
    keepCamera(null);
  }
  map.on("mousedown", onTouch);
  map.on("touchstart", onTouch);
  map.on("wheel", onTouch);

  const unsubscribeSpin = selectedIso3.subscribe((iso3) => {
    if (iso3) stopSpinPermanently();
  });

  function handleVisibilityChange() {
    if (document.hidden) spin.stop();
    else if (!interacted && !get(selectedIso3)) spin.start();
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  function saveCamera() {
    const iso3 = get(selectedIso3);
    if (!iso3 || iso3 !== lastFittedIso3() || map.isMoving()) return;
    const { lng, lat } = map.getCenter();
    try {
      sessionStorage.setItem(
        CAMERA_KEY,
        JSON.stringify({ iso3, center: [lng, lat], zoom: map.getZoom() }),
      );
    } catch {
      // Storage blocked (sandboxed iframe, private mode); the other page flies in as usual.
    }
  }
  window.addEventListener("pagehide", saveCamera);

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
      window.removeEventListener("pagehide", saveCamera);
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
