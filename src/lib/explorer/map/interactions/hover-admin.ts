import { labelsEnabled, selectedAdmin, selectedSource } from "$lib/explorer/map/store";
import { ADMIN_SOURCES, adminTiles } from "$lib/explorer/sources";
import * as maplibregl from "maplibre-gl";
import { get } from "svelte/store";

function buildPopupHtml(
  props: Record<string, unknown>,
  src: (typeof ADMIN_SOURCES)[number],
  level: number,
): string | null {
  const nameField = src.nameField.replace("{level}", String(level));
  const codeField = src.codeField.replace("{level}", String(level));
  const name = props[nameField];
  if (!name) return null;
  const code = props[codeField];

  let html = code
    ? `${String(name)}<br><span class="feature-tooltip-code">${String(code)}</span>`
    : String(name);

  const rows = Object.entries(props)
    .filter(([, v]) => (v != null && typeof v === "string" ? v.trim() !== "" : v !== ""))
    .map(
      ([k, v]) =>
        `<tr><td class="feature-tooltip-key">${k}</td><td class="feature-tooltip-val">${String(v)}</td></tr>`,
    )
    .join("");

  if (rows) {
    html += `<table class="feature-tooltip-props">${rows}</table>`;
  }

  return html;
}

export function addAdminHoverInteraction(map: maplibregl.Map): void {
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: "feature-tooltip",
    maxWidth: "260px",
  });

  // Hover highlighting is feature-state keyed off each source's promoted unique id (see adminTiles).
  let hoveredId: string | number | null = null;
  let hoveredSourceId: string | null = null;
  let hoveredSourceLayer: string | null = null;
  let lastPoint: maplibregl.Point | null = null;
  let lastLngLat: maplibregl.LngLat | null = null;

  function clearHover() {
    if (hoveredId !== null && hoveredSourceId && hoveredSourceLayer) {
      map.setFeatureState(
        { source: hoveredSourceId, sourceLayer: hoveredSourceLayer, id: hoveredId },
        { hover: false },
      );
    }
    hoveredId = null;
    hoveredSourceId = null;
    hoveredSourceLayer = null;
  }

  function setHover(sourceId: string, sourceLayer: string, id: string | number) {
    if (id === hoveredId && sourceId === hoveredSourceId) return;
    clearHover();
    hoveredId = id;
    hoveredSourceId = sourceId;
    hoveredSourceLayer = sourceLayer;
    map.setFeatureState({ source: sourceId, sourceLayer, id }, { hover: true });
  }

  selectedAdmin.subscribe(() => {
    popup.remove();
    clearHover();
    lastPoint = null;
    lastLngLat = null;
  });

  labelsEnabled.subscribe((enabled) => {
    if (enabled) popup.remove();
  });

  selectedSource.subscribe((newSource) => {
    clearHover();
    if (!lastPoint || !lastLngLat) return;

    const level = get(selectedAdmin);
    const srcDef = ADMIN_SOURCES.find((s) => s.id === newSource);
    if (!srcDef) return;

    const layerId = `${newSource}-adm${level}-fill`;
    const sourceId = `${newSource}-adm${level}`;
    const sourceLayer = adminTiles(newSource, level).layer;
    const point = lastPoint;
    const lngLat = lastLngLat;
    const labels = get(labelsEnabled);

    const tryUpdate = () => {
      const features = map.queryRenderedFeatures(point, { layers: [layerId] });
      if (!features.length) return false;

      // Restore hover highlight for the new source
      if (features[0].id != null) {
        setHover(sourceId, sourceLayer, features[0].id);
      }

      if (labels) return true;

      const html = buildPopupHtml(features[0].properties ?? {}, srcDef, level);
      if (!html) {
        popup.remove();
        return true;
      }
      popup.setLngLat(lngLat).setHTML(html).addTo(map);
      return true;
    };

    // Always defer to next render so applyAdminFilter (called after selectedSource.set)
    // runs first and doesn't overwrite our hover filter.
    const onRender = () => {
      if (!map.isSourceLoaded(sourceId)) return;
      map.off("render", onRender);
      tryUpdate();
    };
    map.on("render", onRender);
  });

  for (const src of ADMIN_SOURCES) {
    for (const level of src.levels) {
      const layerId = `${src.id}-adm${level}-fill`;
      const sourceId = `${src.id}-adm${level}`;
      const sourceLayer = adminTiles(src.id, level).layer;

      map.on("mousemove", layerId, (e) => {
        if (!e.features?.length) return;
        lastPoint = e.point;
        lastLngLat = e.lngLat;
        if (e.features[0].id != null) {
          setHover(sourceId, sourceLayer, e.features[0].id);
        }
        if (get(labelsEnabled)) return;
        const html = buildPopupHtml(e.features[0].properties ?? {}, src, level);
        if (!html) return;
        map.getCanvas().style.cursor = "pointer";
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });

      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
        clearHover();
        lastPoint = null;
        lastLngLat = null;
      });
    }
  }
}
