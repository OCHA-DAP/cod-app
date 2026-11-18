<script lang="ts">
  import type { Map as MaplibreMap, Popup } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onMount } from "svelte";
  import { getBboxForIso3 } from "$lib/explorer/parquet/bbox";
  import { MAP_COLORS, MAP_TINT_OPACITY } from "$lib/utils/mapColors";
  import { MAP_DISCLAIMER } from "$lib/utils/mapDisclaimer";
  import { lineWidth, loadMaplibre, loadStyle } from "$lib/utils/mapStyle";
  import { pmtilesProtocol } from "$lib/utils/pmtiles";
  import { polygonsUrl } from "./metadata";

  let { iso3, level }: { iso3: string; level: number } = $props();

  let container: HTMLDivElement;
  let map = $state<MaplibreMap | undefined>();
  let popup: Popup | undefined;

  function show(m: MaplibreMap, iso3: string, n: number): void {
    for (const id of ["units-fill", "units-line"]) if (m.getLayer(id)) m.removeLayer(id);
    if (m.getSource("units")) m.removeSource("units");
    if (!iso3) return;
    m.addSource("units", { type: "vector", url: `pmtiles://${polygonsUrl(iso3, n, "pmtiles")}` });
    const layer = `adm${n}_polygons`;
    m.addLayer({
      id: "units-fill",
      type: "fill",
      source: "units",
      "source-layer": layer,
      paint: { "fill-color": MAP_COLORS.original, "fill-opacity": MAP_TINT_OPACITY },
    });
    m.addLayer({
      id: "units-line",
      type: "line",
      source: "units",
      "source-layer": layer,
      paint: { "line-color": MAP_COLORS.outline, "line-width": lineWidth },
    });
  }

  onMount(() => {
    let cancelled = false;
    loadMaplibre().then(async (maplibregl) => {
      if (cancelled) return;
      pmtilesProtocol(maplibregl);
      const m = new maplibregl.Map({
        container,
        style: await loadStyle(),
        center: [20, 5],
        zoom: 2,
        attributionControl: { compact: true, customAttribution: MAP_DISCLAIMER },
      });
      popup = new maplibregl.Popup({ closeButton: false, className: "feature-tooltip" });
      m.on("mousemove", "units-fill", (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const n = Math.min(Number(p.level), level);
        m.getCanvas().style.cursor = "pointer";
        popup
          ?.setLngLat(e.lngLat)
          .setHTML(
            `${p[`adm${n}_name`] ?? ""}<div class="feature-tooltip-code">${p[`adm${n}_pcode`] ?? ""}</div>`,
          )
          .addTo(m);
      });
      m.on("mouseleave", "units-fill", () => {
        m.getCanvas().style.cursor = "";
        popup?.remove();
      });
      m.once("load", () => (map = m));
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  });

  $effect(() => {
    const m = map;
    const [i, n] = [iso3, level];
    if (!m) return;
    show(m, i, n);
  });

  $effect(() => {
    const m = map;
    const i = iso3;
    if (!m || !i) return;
    getBboxForIso3(i).then((b) => {
      if (b && i === iso3) m.fitBounds(b, { padding: 40, duration: 0 });
    });
  });
</script>

<div class="viewer" bind:this={container}></div>

<style>
  .viewer {
    width: 100%;
    height: 100%;
  }
</style>
