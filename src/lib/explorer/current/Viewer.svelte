<script lang="ts">
  import type { Map as MaplibreMap } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onMount, untrack } from "svelte";
  import { createExplorerMap } from "$lib/explorer/map";
  import { fitCountryBounds, whenSourceLoaded } from "$lib/explorer/map/admin";
  import { createFeatureHover, featurePopupHtml } from "$lib/explorer/map/interactions/hover-admin";
  import { ADMIN_LAYER_SUFFIXES, adminLayers } from "$lib/explorer/map/layers/admin";
  import { labelsEnabled, selectedIso3 } from "$lib/explorer/map/store";
  import { COUNTRY_LAYERS, COUNTRY_SOURCES } from "$lib/explorer/map/style";
  import { loadMaplibre, loadStyle } from "$lib/utils/mapStyle";
  import { iso3Url } from "$lib/utils/data";
  import { polygonsUrl } from "./metadata";

  let {
    iso3,
    units,
    hidden = false,
    map = $bindable(),
  }: {
    iso3: string;
    // The location and level to draw (level null draws none); null keeps what is drawn while a new location resolves.
    units: { iso3: string; level: number | null } | null;
    hidden?: boolean;
    map?: MaplibreMap;
  } = $props();

  let container: HTMLDivElement;
  let hover: ReturnType<typeof createFeatureHover> | undefined;
  let current: string | null = null;
  let cancelSwap = () => {};
  // Unit layer groups on the map, by id, with the function that unbinds their hover.
  const drawn = new Map<string, () => void>();

  function removeUnits(m: MaplibreMap, keep: string | null): void {
    for (const [id, unbind] of drawn) {
      if (id === keep) continue;
      for (const s of ADMIN_LAYER_SUFFIXES) if (m.getLayer(`${id}-${s}`)) m.removeLayer(`${id}-${s}`);
      for (const s of [id, `${id}-labels`]) if (m.getSource(s)) m.removeSource(s);
      unbind();
      drawn.delete(id);
    }
  }

  function applyVisibility(m: MaplibreMap): void {
    if (!current) return;
    for (const s of ADMIN_LAYER_SUFFIXES) {
      if (s === "mismatch") continue;
      const on = !hidden && (s !== "label" || $labelsEnabled);
      m.setLayoutProperty(`${current}-${s}`, "visibility", on ? "visible" : "none");
    }
  }

  // Draws the new location or level over the old one, removing the old once its tiles are in.
  function show(m: MaplibreMap, u: { iso3: string; level: number | null }): void {
    const n = u.level;
    cancelSwap();
    hover?.popup.remove();
    hover?.clear();
    if (n === null) {
      removeUnits(m, null);
      current = null;
      return;
    }
    const id = `units-${u.iso3.toLowerCase()}-adm${n}`;
    if (!drawn.has(id)) {
      const layer = `adm${n}_polygons`;
      const points = `adm${n}_points`;
      m.addSource(id, {
        type: "vector",
        url: `pmtiles://${polygonsUrl(u.iso3, n, "pmtiles")}`,
        promoteId: { [layer]: `adm${n}_pcode` },
      });
      m.addSource(`${id}-labels`, {
        type: "vector",
        url: `pmtiles://${iso3Url(u.iso3, `${points}.pmtiles`)}`,
      });
      const specs = adminLayers({
        id,
        source: id,
        sourceLayer: layer,
        labelsSource: `${id}-labels`,
        labelsLayer: points,
        nameField: "name",
        codeField: "pcode",
      });
      for (const l of specs) m.addLayer(l);
      const unbind =
        hover?.bind(`${id}-fill`, id, layer, (p) => {
          const k = Math.min(Number(p.level), n);
          return featurePopupHtml(p, p[`adm${k}_name`], p[`adm${k}_pcode`]);
        }) ?? (() => {});
      drawn.set(id, unbind);
    }
    current = id;
    applyVisibility(m);
    cancelSwap = whenSourceLoaded(m, id, () => removeUnits(m, id));
  }

  onMount(() => {
    let cancelled = false;
    let destroy = () => {};
    loadMaplibre().then(async () => {
      const base = await loadStyle();
      if (cancelled) return;
      const created = createExplorerMap(container, {
        style: {
          ...base,
          sources: { ...base.sources, ...COUNTRY_SOURCES },
          layers: [...base.layers, ...COUNTRY_LAYERS],
        },
        onSelect: (i) => selectedIso3.set(i),
      });
      destroy = created.destroy;
      hover = createFeatureHover(created.map);
      created.map.once("load", () => (map = created.map));
    });
    return () => {
      cancelled = true;
      cancelSwap();
      hover?.destroy();
      destroy();
    };
  });

  $effect(() => {
    const m = map;
    const u = units;
    if (m && u) untrack(() => show(m, u));
  });

  $effect(() => {
    const m = map;
    void [hidden, $labelsEnabled];
    if (!m) return;
    applyVisibility(m);
    if (hidden) {
      hover?.popup.remove();
      hover?.clear();
    }
  });

  $effect(() => {
    const m = map;
    const i = iso3;
    if (m && i) fitCountryBounds(m, i);
  });
</script>

<div class="viewer" bind:this={container}></div>

<style>
  .viewer {
    width: 100%;
    height: 100%;
  }
</style>
