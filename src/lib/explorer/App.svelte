<script lang="ts">
  import CountrySidebar from "$lib/explorer/components/CountrySidebar.svelte";
  import StatsPanel from "$lib/explorer/components/StatsPanel.svelte";
  import { initMap } from "$lib/explorer/map";
  import { applyView } from "$lib/explorer/map/admin";
  import { mapStore, selectedAdmin, selectedIso3, selectedSource } from "$lib/explorer/map/store";
  import { viewFromUrl } from "$lib/explorer/urlState";
  import { loadMaplibre } from "$lib/utils/mapStyle";
  import type * as maplibregl from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import "$lib/explorer/tooltip.css";
  import { onMount, tick } from "svelte";

  let mapContainer: HTMLDivElement;
  let kiosk = $state(false);

  onMount(() => {
    let cleanup = () => {};
    let cancelled = false;

    function showView() {
      const view = viewFromUrl(location);
      const map = $mapStore;
      if (view.kiosk !== kiosk) {
        kiosk = view.kiosk;
        document.body.classList.toggle("kiosk", kiosk);
        tick().then(() => map?.resize());
      }
      if (!map || map.loaded()) applyView(map, view);
      else map.once("load", () => applyView(map as maplibregl.Map, view));
    }

    loadMaplibre().then(() => {
      if (cancelled) return;
      cleanup = initMap(mapContainer);
      showView();
      window.addEventListener("hashchange", showView);
    });

    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", showView);
      cleanup();
    };
  });

  // Mirrors the selection into the query string so any view can be shared as a link.
  $effect(() => {
    const iso3 = $selectedIso3;
    const source = $selectedSource;
    const level = $selectedAdmin;
    if (!iso3 || kiosk) return;
    const page = new URL(location.href);
    page.hash = "";
    page.searchParams.delete("country");
    page.searchParams.set("iso3", iso3);
    page.searchParams.set("source", source);
    page.searchParams.set("level", String(level));
    history.replaceState(history.state, "", page);
  });
</script>

<div class="app-shell">
  {#if !kiosk}
    <CountrySidebar />
  {/if}
  <div class="map-area">
    <div bind:this={mapContainer} class="map"></div>
    {#if !kiosk}
      <StatsPanel iso3={$selectedIso3} />
    {/if}
  </div>
</div>

<style>
  .app-shell {
    display: flex;
    width: 100%;
    height: 100%;
  }

  .map-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    height: 100%;
  }

  .map {
    flex: 1;
    min-height: 0;
    width: 100%;
  }
</style>
