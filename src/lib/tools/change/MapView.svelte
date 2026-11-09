<script lang="ts">
  import type {
    ExpressionSpecification,
    FilterSpecification,
    GeoJSONSource,
    LngLatLike,
    Map as MaplibreMap,
    MapMouseEvent,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount, untrack } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { loadMaplibre, loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";
  import { MAP_DISCLAIMER } from "$lib/utils/mapDisclaimer";
  import { REL_COLORS, REL_ORDER } from "./pipeline";
  import MapPopup, { type FeatureInfo } from "$lib/components/MapPopup.svelte";
  import { MAP_COLORS, MAP_STATUS_OPACITY, MAP_TINT_OPACITY } from "$lib/utils/mapColors";

  let {
    overlayGeojson = null,
    outlineAGeojson = null,
    outlineBGeojson = null,
    bounds = null,
    processing = false,
    hoveredClusterId = null,
    hoveredFid = null,
    visibleClasses = null,
    baseClasses = [],
    showSide = "b" as "a" | "b",
    onClusterClick,
    onFeatureHover,
    describe,
  }: {
    overlayGeojson?: string | null;
    outlineAGeojson?: string | null;
    outlineBGeojson?: string | null;
    bounds?: [number, number, number, number] | null;
    processing?: boolean;
    hoveredClusterId?: number | null;
    hoveredFid?: number | null;
    visibleClasses?: Set<string> | null;
    // Drawn in the base fill like other tools' input layer.
    baseClasses?: string[];
    showSide?: "a" | "b";
    onClusterClick?: (id: number | null) => void;
    onFeatureHover?: (payload: { cluster_id: number | null; fid: number | null }) => void;
    // Hover popup content for the unit under the cursor; no popup when unset.
    describe?: (clusterId: number, fid: number) => FeatureInfo[];
  } = $props();

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let overlayUrl: string | undefined;
  let outlineAUrl: string | undefined;
  let outlineBUrl: string | undefined;
  let styleReady = false;
  let hovered = $state<FeatureInfo[]>([]);
  let hoverLngLat = $state<LngLatLike | null>(null);

  function hover(cid: number | null, fid: number | null, lngLat: LngLatLike | null): void {
    if (map) map.getCanvas().style.cursor = cid == null ? "" : "pointer";
    hovered = describe && cid != null && fid != null ? describe(cid, fid) : [];
    hoverLngLat = lngLat;
    onFeatureHover?.({ cluster_id: cid, fid });
  }
  let sidePending: number | undefined;
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  $effect(() => {
    if (processing) stopSpin();
  });

  function fillColorExpr(): ExpressionSpecification {
    const stops = REL_ORDER.flatMap((c) => [c, baseClasses.includes(c) ? MAP_COLORS.original : REL_COLORS[c]]);
    return ["match", ["get", "relationship_class"], ...stops, MAP_COLORS.fallback] as unknown as ExpressionSpecification;
  }

  function fillOpacityExpr(): ExpressionSpecification {
    if (hoveredClusterId == null) {
      return ["match", ["get", "relationship_class"], baseClasses.length ? baseClasses : [""], MAP_TINT_OPACITY, MAP_STATUS_OPACITY] as unknown as ExpressionSpecification;
    }
    // Per-feature hover: the polygon under the cursor goes nearly opaque, its
    // cluster siblings fade back so the hovered one pops without darkening.
    if (hoveredFid != null) {
      return [
        "case",
        ["==", ["get", "fid"], hoveredFid],
        0.92,
        ["==", ["get", "cluster_id"], hoveredClusterId],
        0.55,
        0.35,
      ] as unknown as ExpressionSpecification;
    }
    return [
      "case",
      ["==", ["get", "cluster_id"], hoveredClusterId],
      0.95,
      0.45,
    ] as unknown as ExpressionSpecification;
  }

  function buildFillFilter(): FilterSpecification {
    const conditions: FilterSpecification[] = [polyFilter];
    if (visibleClasses != null) {
      const shown = [...new Set([...visibleClasses, ...baseClasses])];
      conditions.push(["match", ["get", "relationship_class"], shown, true, false] as FilterSpecification);
    }
    return conditions.length === 1 ? conditions[0] : (["all", ...conditions] as FilterSpecification);
  }

  $effect(() => {
    // Read reactive deps before any early return so Svelte tracks them.
    const filter = buildFillFilter();
    if (!map || !styleReady) return;
    for (const layer of ["cw-overlay-fill", "cw-outline-a-fill", "cw-outline-b-fill"]) {
      if (map.getLayer(layer)) map.setFilter(layer, filter);
    }
  });

  $effect(() => {
    // Read reactive deps before any early return so Svelte tracks them.
    const opExpr = fillOpacityExpr();
    const highlightFilter: FilterSpecification =
      hoveredClusterId == null
        ? (["==", ["get", "cluster_id"], -1] as FilterSpecification)
        : (["==", ["get", "cluster_id"], hoveredClusterId] as FilterSpecification);
    if (!map || !styleReady) return;
    for (const layer of ["cw-overlay-fill", "cw-outline-a-fill", "cw-outline-b-fill"]) {
      if (map.getLayer(layer)) map.setPaintProperty(layer, "fill-opacity", opExpr);
    }
    for (const layer of ["cw-highlight-line", "cw-outline-a-highlight", "cw-outline-b-highlight"]) {
      if (map.getLayer(layer)) map.setFilter(layer, highlightFilter);
    }
  });

  function applySideVisibility(side: "a" | "b"): void {
    if (!map) return;
    const vis = (id: string, v: boolean) => {
      if (map!.getLayer(id)) map!.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    };
    const isA = side === "a";
    vis("cw-overlay-fill", false);
    vis("cw-outline-a-fill", isA);
    vis("cw-outline-b-fill", !isA);
    vis("cw-outline-a-line", isA);
    vis("cw-outline-b-line", !isA);
    vis("cw-highlight-line", false);
    vis("cw-outline-a-highlight", isA);
    vis("cw-outline-b-highlight", !isA);
  }

  $effect(() => {
    // Visibility driven by showSide: toggles overlay fill vs side fills + outlines.
    // Read reactive dep before any early return.
    const side = showSide;
    if (!map || !styleReady) return;
    // Cancel any pending frame so rapid changes don't produce intermediate renders.
    if (sidePending !== undefined) cancelAnimationFrame(sidePending);
    sidePending = requestAnimationFrame(() => applySideVisibility(side));
  });

  $effect(() => {
    const b = bounds;
    if (!b || !map) return;
    function apply() {
      if (!map || !b) return;
      const [minLng, minLat, maxLng, maxLat] = b;
      stopSpin();
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 40, animate: true },
      );
    }
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  });

  function setSource(id: string, dataUrl: string): void {
    if (!map) return;
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(dataUrl);
  }

  $effect(() => {
    const data = overlayGeojson;
    if (!data || !map || !styleReady) return;
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    overlayUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    if (!map.getSource("cw-overlay")) {
      map.addSource("cw-overlay", { type: "geojson", data: overlayUrl, promoteId: "cluster_id" });
      map.addLayer({
        id: "cw-overlay-fill",
        type: "fill",
        source: "cw-overlay",
        filter: untrack(buildFillFilter),
        paint: {
          "fill-color": fillColorExpr(),
          "fill-opacity": fillOpacityExpr(),
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5, "rgba(0,0,0,0)",
            8, "rgba(0,0,0,0.25)",
            12, "rgba(0,0,0,0.6)",
          ] as unknown as string,
        },
      });
      // Highlight outline for the selected cluster — sits above outlines so
      // it's always on top. The filter is updated by the selection effect.
      map.addLayer({
        id: "cw-highlight-line",
        type: "line",
        source: "cw-overlay",
        filter: ["==", ["get", "cluster_id"], -1] as FilterSpecification,
        paint: {
          "line-color": MAP_COLORS.outline,
          "line-width": 2.5,
        },
      });
    } else {
      setSource("cw-overlay", overlayUrl);
    }
  });

  function addOutline(side: "a" | "b", dataUrl: string): void {
    if (!map) return;
    const id = `cw-outline-${side}`;
    if (map.getSource(id)) {
      setSource(id, dataUrl);
      return;
    }
    map.addSource(id, { type: "geojson", data: dataUrl });
    const beforeId = map.getLayer("cw-highlight-line") ? "cw-highlight-line" : undefined;
    const outlineWidth = ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 1, 12, 2, 16, 4] as unknown as number;
    // Fill layer for single-side comparison mode — hidden by default, shown when showSide matches.
    map.addLayer(
      {
        id: `cw-outline-${side}-fill`,
        type: "fill",
        source: id,
        filter: untrack(buildFillFilter),
        layout: { visibility: "none" },
        paint: {
          "fill-color": fillColorExpr(),
          "fill-opacity": fillOpacityExpr(),
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5, "rgba(0,0,0,0)",
            8, "rgba(0,0,0,0.25)",
            12, "rgba(0,0,0,0.6)",
          ] as unknown as string,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: `cw-outline-${side}-line`,
        type: "line",
        source: id,
        paint: {
          "line-color": MAP_COLORS.outline,
          "line-width": outlineWidth,
        },
      },
      beforeId,
    );
    // Highlight outline for selected cluster on this side's source.
    map.addLayer({
      id: `cw-outline-${side}-highlight`,
      type: "line",
      source: id,
      filter: ["==", ["get", "cluster_id"], -1] as FilterSpecification,
      layout: { visibility: "none" },
      paint: { "line-color": MAP_COLORS.outline, "line-width": 2.5 },
    });
    map.on("mousemove", `cw-outline-${side}-fill`, (e) => {
      const props = e.features?.[0]?.properties;
      const cid = props?.cluster_id == null ? null : Number(props.cluster_id);
      const fid = props?.fid == null ? null : Number(props.fid);
      hover(cid, fid, e.lngLat);
    });
    map.on("mouseleave", `cw-outline-${side}-fill`, () => {
      hover(null, null, null);
    });
    // Apply current showSide visibility since the effect won't re-fire for newly added layers.
    applySideVisibility(showSide);
  }

  $effect(() => {
    const data = outlineAGeojson;
    if (!data || !map || !styleReady) return;
    if (outlineAUrl) URL.revokeObjectURL(outlineAUrl);
    outlineAUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    addOutline("a", outlineAUrl);
  });

  $effect(() => {
    const data = outlineBGeojson;
    if (!data || !map || !styleReady) return;
    if (outlineBUrl) URL.revokeObjectURL(outlineBUrl);
    outlineBUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    addOutline("b", outlineBUrl);
  });

  function handleMapClick(e: MapMouseEvent): void {
    if (!map || !onClusterClick) return;
    const fillLayer =
      showSide === "a" ? "cw-outline-a-fill"
      : showSide === "b" ? "cw-outline-b-fill"
      : "cw-overlay-fill";
    if (!map.getLayer(fillLayer)) { onClusterClick(null); return; }
    const feats = map.queryRenderedFeatures(e.point, { layers: [fillLayer] });
    if (feats.length === 0) {
      onClusterClick(null);
      return;
    }
    const props = feats[0].properties;
    const cid = props?.cluster_id;
    onClusterClick(cid == null ? null : Number(cid));
  }

  onMount(async () => {
    if (!container) return;
    const maplibregl = await loadMaplibre();
    const style = await loadStyle();
    map = new maplibregl.Map({
      container,
      style,
      center: [20, 5],
      zoom: Math.log2((Math.min(container.clientWidth, container.clientHeight) * Math.PI) / 512),
      attributionControl: { compact: true, customAttribution: MAP_DISCLAIMER },
    });
    map.once("load", () => {
      styleReady = true;
      startSpin();
      map?.on("mousedown", stopSpin);
      map?.on("touchstart", stopSpin);
      map?.on("wheel", stopSpin);
      map?.on("click", handleMapClick);
      map?.on("mousemove", "cw-overlay-fill", (e) => {
        const props = e.features?.[0]?.properties;
        const cid = props?.cluster_id == null ? null : Number(props.cluster_id);
        const sideFid = showSide === "a" ? props?.a_fid : props?.b_fid;
        const fid = sideFid == null ? null : Number(sideFid);
        hover(cid, fid, e.lngLat);
      });
      map?.on("mouseleave", "cw-overlay-fill", () => {
        hover(null, null, null);
      });
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    if (outlineAUrl) URL.revokeObjectURL(outlineAUrl);
    if (outlineBUrl) URL.revokeObjectURL(outlineBUrl);
  });
</script>

<div bind:this={container} class="cw-map"></div>
<MapPopup getMap={() => map} items={hovered} lngLat={hoverLngLat} />

<style>
  .cw-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
</style>
