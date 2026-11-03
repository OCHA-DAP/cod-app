<script lang="ts">
  import { onMount } from "svelte";
  import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { loadMaplibre } from "$lib/utils/mapStyle";
  import { MAP_DISCLAIMER } from "$lib/utils/mapDisclaimer";
  import { PMTiles } from "pmtiles";
  import { pmtilesProtocol, prefetchDirectories } from "$lib/utils/pmtiles";
  import { base } from "$lib/utils/paths";
  import { codAbUrl } from "$lib/utils/data";

  const LEVELS = [1, 2, 3, 4] as const;
  type Level = (typeof LEVELS)[number];

  const archiveUrl = (n: Level) => codAbUrl(`global/admin${n}/admin${n}.pmtiles`);
  const DEGREES_PER_SECOND = 3;
  // The spin-in slows from SPIN_IN_PEAK to cruising speed over SPIN_IN_MS, passing SETTLE_LNG as it ends.
  const SPIN_IN_PEAK = 60;
  const SPIN_IN_MS = 4500;
  const SETTLE_LNG = 22;
  const SPIN_IN_DEGREES =
    (DEGREES_PER_SECOND * SPIN_IN_MS + ((SPIN_IN_PEAK - DEGREES_PER_SECOND) * SPIN_IN_MS) / 4) / 1000;
  const START_LNG = SETTLE_LNG + SPIN_IN_DEGREES;
  // Time constant for easing between cruising, holding still while the first boundaries load, and coasting after a drag.
  const SPEED_EASE_MS = 500;
  const RESUME_IDLE_MS = 10000;
  const CENTER_LAT = 5;
  // MapLibre's globe radius is about 64.4 px per 2^zoom; FIT is the share of the container it fills.
  const RADIUS_PX_AT_Z0 = 64.4;
  const FIT = 0.9;
  const LINE = "#009edb";
  const LAND = "#ffffff";
  const REVEAL_MS = 2500;
  const CYCLE_MS = 1000;

  let container: HTMLDivElement;
  let level = $state<Level>(1);
  let map: MaplibreMap | undefined;
  let ready = false;
  let entered = $state(false);
  let revealed = $state<Level[]>([]);
  let shown: Level | undefined;
  let pauseCycle = () => {};

  const fitZoom = () =>
    Math.log2((FIT * Math.min(container.clientWidth, container.clientHeight)) / 2 / RADIUS_PX_AT_Z0);

  function addLevel(m: MaplibreMap, n: Level) {
    if (m.getSource(`adm${n}`)) return;
    m.addSource(`adm${n}`, { type: "vector", url: `pmtiles://${archiveUrl(n)}` });
    m.addLayer({
      id: `adm${n}-line`,
      type: "line",
      source: `adm${n}`,
      "source-layer": `admin${n}`,
      paint: { "line-color": LINE, "line-width": 0.4, "line-opacity": 0 },
    });
  }

  function show(n: Level) {
    level = n;
    if (!map || !ready) return;
    addLevel(map, n);
    paint(map);
  }

  // The shown level stays on screen until the selected one has fully loaded, then swaps in instantly.
  // Only the page's first boundaries fade in.
  function paint(m: MaplibreMap) {
    const first = shown === undefined;
    if (revealed.includes(level)) shown = level;
    const transition = { duration: first ? REVEAL_MS : 0, delay: 0 };
    for (const l of LEVELS) {
      if (!m.getLayer(`adm${l}-line`)) continue;
      m.setPaintProperty(`adm${l}-line`, "line-opacity-transition", transition);
      m.setPaintProperty(`adm${l}-line`, "line-opacity", l === shown ? 1 : 0);
    }
  }

  onMount(() => {
    let stopped = false;
    let frame = 0;
    let onScreen = true;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const lng = reduceMotion.matches ? SETTLE_LNG : START_LNG;
    let last = performance.now();

    let spinStart = 0;
    let spinningIn = !reduceMotion.matches;
    let speed = DEGREES_PER_SECOND;
    let dragging = false;
    let touchedAt = -Infinity;
    let firstRevealAt = Infinity;

    const run = () => {
      if (frame || !map || !onScreen || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(spin);
    };

    // Horizontal drags spin the globe about its axis; releasing hands the drag velocity to the spin easing.
    let dragX = 0;
    let dragAt = 0;
    const onPointerDown = (e: PointerEvent) => {
      if (!map) return;
      dragging = true;
      spinningIn = false;
      speed = 0;
      dragX = e.clientX;
      dragAt = e.timeStamp;
      container.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!map || !dragging) return;
      const degrees = ((e.clientX - dragX) * 180) / (Math.PI * RADIUS_PX_AT_Z0 * 2 ** map.getZoom());
      const { lng: from, lat } = map.getCenter();
      map.setCenter([from - degrees, lat]);
      speed = (degrees * 1000) / Math.max(e.timeStamp - dragAt, 1);
      dragX = e.clientX;
      dragAt = e.timeStamp;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      touchedAt = performance.now();
      if (e.timeStamp - dragAt > 100 || reduceMotion.matches) speed = 0;
      run();
    };
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);

    const spin = (now: number) => {
      frame = 0;
      const dt = Math.min(now - last, 100);
      last = now;
      if (!map || !onScreen || document.hidden || reduceMotion.matches) return;
      const left = 1 - (now - spinStart) / SPIN_IN_MS;
      spinningIn &&= left > 0;
      if (spinningIn) {
        // Position from elapsed time, so dropped frames can't move the landing point.
        map.setCenter([
          SETTLE_LNG +
            (DEGREES_PER_SECOND * SPIN_IN_MS * left +
              ((SPIN_IN_PEAK - DEGREES_PER_SECOND) * SPIN_IN_MS * left ** 4) / 4) /
              1000,
          CENTER_LAT,
        ]);
      } else if (!dragging) {
        // Hold still (or coast after a drag) until the first boundaries arrive and the user has been idle.
        const target = firstRevealAt <= now && now - touchedAt > RESUME_IDLE_MS ? DEGREES_PER_SECOND : 0;
        speed += (target - speed) * (1 - Math.exp(-dt / SPEED_EASE_MS));
        if (Math.abs(speed) > 0.001) {
          const { lng: from, lat } = map.getCenter();
          map.setCenter([from - (speed * dt) / 1000, lat]);
        }
      }
      frame = requestAnimationFrame(spin);
    };

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      run();
      advance();
    });
    observer.observe(container);
    document.addEventListener("visibilitychange", run);
    // Cycles through the levels in order, pausing RESUME_IDLE_MS after a chip click, holding until the next one has loaded.
    let cycle: ReturnType<typeof setTimeout> | undefined;
    let due = false;
    const advance = () => {
      const next = LEVELS[level % LEVELS.length];
      if (!due || !revealed.includes(next) || !onScreen || document.hidden) return;
      due = false;
      show(next);
      wait();
    };
    const wait = (ms = CYCLE_MS) => {
      clearTimeout(cycle);
      cycle = setTimeout(() => {
        due = true;
        advance();
      }, ms);
    };
    pauseCycle = () => {
      due = false;
      wait(RESUME_IDLE_MS);
    };
    document.addEventListener("visibilitychange", advance);
    const resize = new ResizeObserver(() => map?.setZoom(fitZoom()));
    resize.observe(container);

    // Fetch every level's directories while MapLibre's bundle is still loading.
    const archives = LEVELS.map((n) => new PMTiles(archiveUrl(n)));
    archives.forEach((a) => prefetchDirectories(a, fitZoom()).catch(() => {}));

    (async () => {
      const maplibregl = await loadMaplibre();
      if (stopped) return;
      const protocol = pmtilesProtocol(maplibregl);
      archives.forEach((a, i) => protocol.get(archiveUrl(LEVELS[i])) || protocol.add(a));
      const style: StyleSpecification = {
        version: 8,
        projection: { type: "globe" },
        sky: { "atmosphere-blend": 0 },
        sources: { land: { type: "geojson", data: `${base}data/land_globe.geojson` } },
        layers: [
          { id: "water", type: "background", paint: { "background-color": "#e3edf6" } },
          { id: "land", type: "fill", source: "land", paint: { "fill-color": LAND } },
        ],
      };
      const m = new maplibregl.Map({
        container,
        style,
        center: [lng, CENTER_LAT],
        zoom: fitZoom(),
        interactive: false,
        attributionControl: { compact: false, customAttribution: MAP_DISCLAIMER },
      });
      map = m;
      m.on("sourcedata", (e) => {
        const n = Number(e.sourceId.replace("adm", "")) as Level;
        if (!LEVELS.includes(n) || revealed.includes(n) || !m.isSourceLoaded(e.sourceId)) return;
        revealed = [...revealed, n];
        firstRevealAt = Math.min(firstRevealAt, performance.now());
        const first = shown === undefined;
        paint(m);
        // The first boundaries hold through their fade-in before the cycle starts.
        if (first && shown !== undefined) wait(REVEAL_MS + CYCLE_MS);
        else advance();
      });
      m.once("load", () => {
        ready = true;
        entered = true;
        show(level);
        // All levels load at once, at opacity 0 rather than visibility none, so each is ready for the cycle.
        LEVELS.forEach((n) => addLevel(m, n));
        spinStart = performance.now();
        run();
      });
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      clearTimeout(cycle);
      document.removeEventListener("visibilitychange", advance);
      document.removeEventListener("visibilitychange", run);
      observer.disconnect();
      resize.disconnect();
      map?.remove();
      map = undefined;
    };
  });
</script>

<div class="globe" style="--spin-in: {SPIN_IN_MS}ms; --reveal: {REVEAL_MS}ms">
  <div class="canvas" class:entered class:adm1={revealed.includes(1)} bind:this={container}></div>
  <div class="levels" role="group" aria-label="Administrative level">
    {#each LEVELS as n (n)}
      {@const loading = level === n && !revealed.includes(n)}
      <button
        type="button"
        class:loading
        aria-pressed={level === n}
        aria-busy={loading}
        onclick={() => {
          pauseCycle();
          show(n);
        }}>Admin {n}</button
      >
    {/each}
  </div>
</div>

<style>
  .globe {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
  }
  .canvas {
    position: absolute;
    inset: 0;
    cursor: grab;
    touch-action: pan-y;
    opacity: 0;
    transform: scale(0.35);
    transition:
      opacity 1.5s ease-out,
      transform var(--spin-in) cubic-bezier(0.16, 1, 0.3, 1);
  }
  .canvas:active {
    cursor: grabbing;
  }
  .canvas :global(.maplibregl-ctrl-attrib) {
    font-size: 11px;
    opacity: 0;
    /* Matches MapLibre's easeCubicInOut on the admin 1 line-opacity reveal. */
    transition: opacity var(--reveal) cubic-bezier(0.65, 0, 0.35, 1);
  }
  .canvas.adm1 :global(.maplibregl-ctrl-attrib) {
    opacity: 1;
  }
  .canvas.entered {
    opacity: 1;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .canvas {
      transform: none;
    }
  }
  .levels {
    position: absolute;
    left: -4%;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .levels button {
    white-space: nowrap;
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--cd-blue--brighter);
    border-radius: 8px;
    background: var(--cd-white);
    color: var(--cd-grey--800);
    cursor: pointer;
  }
  .levels button:hover {
    border-color: var(--cd-blue--bright);
  }
  .levels button[aria-pressed="true"] {
    background: var(--brand-primary--text);
    border-color: var(--brand-primary--text);
    color: var(--cd-white);
    font-weight: 700;
  }
  .levels button.loading {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .levels button.loading {
      animation: none;
      opacity: 0.7;
    }
  }
  @media (max-width: 900px) {
    .levels {
      left: 50%;
      top: auto;
      bottom: 0;
      transform: translateX(-50%);
      flex-direction: row;
    }
  }
</style>
