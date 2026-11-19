import { whenSourceLoaded } from "$lib/explorer/map/admin";
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
  return featurePopupHtml(props, props[nameField], props[codeField]);
}

// Name and code over a table of the feature's non-empty properties; null without a name.
export function featurePopupHtml(
  props: Record<string, unknown>,
  name: unknown,
  code: unknown,
): string | null {
  if (!name) return null;
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

// Feature-state hover on unit fills, with a properties popup while labels are off.
export function createFeatureHover(map: maplibregl.Map) {
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: "feature-tooltip",
    maxWidth: "260px",
  });
  let hovered: { source: string; sourceLayer: string; id: string | number } | null = null;

  function clear() {
    if (hovered && map.getSource(hovered.source)) map.setFeatureState(hovered, { hover: false });
    hovered = null;
  }

  function set(source: string, sourceLayer: string, id: string | number) {
    if (hovered && id === hovered.id && source === hovered.source) return;
    clear();
    hovered = { source, sourceLayer, id };
    map.setFeatureState(hovered, { hover: true });
  }

  function show(lngLat: maplibregl.LngLatLike, html: string | null) {
    if (!html) return;
    map.getCanvas().style.cursor = "pointer";
    popup.setLngLat(lngLat).setHTML(html).addTo(map);
  }

  const unsubscribe = labelsEnabled.subscribe((enabled) => {
    if (enabled) popup.remove();
  });

  // Returns a function that removes the layer's listeners.
  function bind(
    layerId: string,
    source: string,
    sourceLayer: string,
    html: (props: Record<string, unknown>) => string | null,
    on: { move?: (e: maplibregl.MapLayerMouseEvent) => void; leave?: () => void } = {},
  ): () => void {
    const move = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      on.move?.(e);
      if (f.id != null) set(source, sourceLayer, f.id);
      if (!get(labelsEnabled)) show(e.lngLat, html(f.properties ?? {}));
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
      clear();
      on.leave?.();
    };
    map.on("mousemove", layerId, move);
    map.on("mouseleave", layerId, leave);
    return () => {
      map.off("mousemove", layerId, move);
      map.off("mouseleave", layerId, leave);
    };
  }

  return { popup, set, clear, show, bind, destroy: () => (unsubscribe(), popup.remove()) };
}

export function addAdminHoverInteraction(map: maplibregl.Map): void {
  const hover = createFeatureHover(map);
  let lastPoint: maplibregl.Point | null = null;
  let lastLngLat: maplibregl.LngLat | null = null;

  selectedAdmin.subscribe(() => {
    hover.popup.remove();
    hover.clear();
    lastPoint = null;
    lastLngLat = null;
  });

  selectedSource.subscribe((newSource) => {
    hover.clear();
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
        hover.set(sourceId, sourceLayer, features[0].id);
      }

      if (labels) return true;

      const html = buildPopupHtml(features[0].properties ?? {}, srcDef, level);
      if (!html) {
        hover.popup.remove();
        return true;
      }
      hover.popup.setLngLat(lngLat).setHTML(html).addTo(map);
      return true;
    };

    // Always defer to next render so applyAdminFilter (called after selectedSource.set)
    // runs first and doesn't overwrite our hover filter.
    whenSourceLoaded(map, sourceId, tryUpdate);
  });

  for (const src of ADMIN_SOURCES) {
    for (const level of src.levels) {
      hover.bind(
        `${src.id}-adm${level}-fill`,
        `${src.id}-adm${level}`,
        adminTiles(src.id, level).layer,
        (props) => buildPopupHtml(props, src, level),
        {
          move: (e) => {
            lastPoint = e.point;
            lastLngLat = e.lngLat;
          },
          leave: () => {
            lastPoint = null;
            lastLngLat = null;
          },
        },
      );
    }
  }
}
