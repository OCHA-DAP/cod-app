<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { onMount, untrack } from "svelte";
  import IssuesTable from "./IssuesTable.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";
  import MapView from "./MapView.svelte";
  import {
    PipelineError,
    recleanOnly,
    resolveGapFillWidths,
    runFromLoaded,
    type ExportCheck,
    type GapMode,
    type IssueKind,
    type IssueRow,
  } from "./pipeline";
  import { niceNum } from "./pipeline/units";
  import { syncParam } from "$lib/utils/syncParam.svelte";

  const STAGE_LABELS = ["Load file", "Analyze coverage", "Find gaps & overlaps", "Fix topology"];

  // Input
  let files = $state<File[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  // Gap-fill mode: minimal (default, noise-scale gaps only), thin
  // (sliver-shaped gaps only), all (every detected gap), or manual (exact
  // width via the slider below).
  let mode = $state<GapMode>("minimal");

  // Manual-mode slider (meters). Only read when mode === "manual".
  let gapWidthM = $state(0);

  // `gap` URL param: "thin", "all", or a Manual width in meters; absent means Minimal.
  syncParam(
    "gap",
    {
      parse: (raw) => (raw === "thin" || raw === "all" || (raw.trim() !== "" && Number(raw) >= 0) ? raw : undefined),
      format: (value) => value,
    },
    () => (mode === "manual" ? String(Number(gapWidthM.toPrecision(6))) : mode),
    (value) => {
      if (value === "thin" || value === "all") mode = value;
      else {
        mode = "manual";
        gapWidthM = Number(value);
      }
    },
  );

  function fmtGap(m: number): string {
    if (m === 0) return "none";
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    if (m >= 1) return `${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 2 : 1)} m`;
    if (m >= 0.01) return `${(m * 100).toFixed(1)} cm`;
    return `${(m * 1000).toFixed(1)} mm`;
  }

  // sliderCeilingM: 2× the widest detected gap (Manual slider's ceiling, and
  // All mode's display estimate — its actual fill width is a fixed sentinel,
  // see pipeline/index.ts). minimalFillM: SNAP_TOLERANCE, only when
  // a noise-scale gap exists (Minimal mode, the default). Any can be 0,
  // meaning "fill nothing."
  const { sliderCeilingM, minimalFillM } = $derived(resolveGapFillWidths(issues));

  const gapMaxM = $derived(sliderCeilingM || 100);
  const gapStepM = $derived(niceNum(gapMaxM / 100));

  // The width displayed to the user and (for every mode but All) actually fed
  // to ST_CoverageClean — All instead uses a fixed sentinel, see doReclean.
  const effectiveGapWidthM = $derived(
    mode === "manual"
      ? gapWidthM
      : mode === "all"
        ? sliderCeilingM
        : mode === "thin"
          ? thinFillM
          : minimalFillM,
  );

  function setMode(next: GapMode): void {
    // Seed the slider from whatever's currently applied so switching into
    // Manual never itself changes what gets filled — only future drags do.
    if (next === "manual" && mode !== "manual") {
      gapWidthM = effectiveGapWidthM;
    }
    mode = next;
    scheduleReclean();
  }

  // Clamp the manual slider if the max drops below it.
  $effect(() => {
    const max = gapMaxM;
    untrack(() => {
      if (mode === "manual" && gapWidthM > max) {
        gapWidthM = max;
        scheduleReclean();
      }
    });
  });

  // Run state
  let running = $state(false);
  let currentStage = $state(0); // 0 idle, 1..4 active, 5 done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Results
  // True once detection finished, even if the first clean was rejected.
  let analyzed = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let cleanedGeoJSON = $state<string | null>(null);
  let modifiedGeoJSON = $state<string | null>(null);
  let issuesGeoJSON = $state<string | null>(null);
  let issues = $state<IssueRow[]>([]);
  let thinFillM = $state(0);
  let fixedKeys = $state<Set<string>>(new Set());
  let detectionFailed = $state<Set<IssueKind>>(new Set());
  let exportCheck = $state<ExportCheck | null>(null);
  let bounds = $state<[number, number, number, number] | null>(null);
  let totalCount = $state(0);
  let collapsedCount = $state(0);

  // View + selection
  let showSide = $state<"a" | "b">("b");
  let selectedKey = $state<string | null>(null);
  let focusBbox = $state<[number, number, number, number] | null>(null);

  // Debounce for slider-driven re-clean.
  let recleanTimer: ReturnType<typeof setTimeout> | undefined;
  let recleaning = $state(false);
  let recleanPending = false;

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loading) return;
      loaded = false;
      resetResults();
      loadThenFlag();
    });
  });

  $effect(() => {
    const ok = loaded;
    if (!ok) return;
    untrack(() => {
      if (!running) handleRun();
    });
  });

  function resetResults(): void {
    analyzed = false;
    originalGeoJSON = null;
    cleanedGeoJSON = null;
    modifiedGeoJSON = null;
    issuesGeoJSON = null;
    issues = [];
    thinFillM = 0;
    fixedKeys = new Set();
    detectionFailed = new Set();
    exportCheck = null;
    bounds = null;
    totalCount = 0;
    collapsedCount = 0;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "b";
    selectedKey = null;
    focusBbox = null;
    recleanPending = false;
    if (recleanTimer) {
      clearTimeout(recleanTimer);
      recleanTimer = undefined;
    }
  }

  async function loadThenFlag(): Promise<void> {
    loadError = null;
    loading = true;
    currentStage = 1;
    stageLabel = "Loading file…";
    try {
      const bboxResult = await withDb(async (db, conn) => {
        await loadFile(db, conn, files);
        loaded = true;
        return conn.query(`
          SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
                 MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
          FROM layer_01 WHERE geom IS NOT NULL
        `);
      });
      const bboxRow = bboxResult.toArray()[0] as Record<string, number>;
      const { xmin, ymin, xmax, ymax } = bboxRow;
      if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
        bounds = [xmin, ymin, xmax, ymax];
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      currentStage = 0;
    } finally {
      loading = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    errorStage = 0;
    try {
      const result = await withDb((_db, conn) =>
        runFromLoaded(conn, { mode, gapWidthM }, (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        }),
      );
      analyzed = true;
      originalGeoJSON = result.originalGeoJSON;
      cleanedGeoJSON = result.cleanedGeoJSON;
      modifiedGeoJSON = result.modifiedGeoJSON;
      issuesGeoJSON = result.issuesGeoJSON;
      issues = result.issues;
      thinFillM = result.thinFillM;
      fixedKeys = result.fixedKeys;
      detectionFailed = result.detectionFailed;
      exportCheck = result.exportCheck;
      bounds = result.bounds;
      totalCount = result.totalCount;
      collapsedCount = result.collapsedCount;
      currentStage = 5;
      stageLabel = "Done";
      showSide = "b";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
      const analysis = e instanceof PipelineError ? e.analysis : undefined;
      if (analysis) {
        analyzed = true;
        originalGeoJSON = analysis.originalGeoJSON;
        issuesGeoJSON = analysis.issuesGeoJSON;
        issues = analysis.issues;
        thinFillM = analysis.thinFillM;
        detectionFailed = analysis.detectionFailed;
        bounds = analysis.bounds;
        totalCount = analysis.totalCount;
        showSide = "a";
      }
    } finally {
      running = false;
    }
  }

  function scheduleReclean(): void {
    if (!analyzed) return;
    if (recleanTimer) clearTimeout(recleanTimer);
    if (recleaning) {
      recleanPending = true;
      return;
    }
    recleanTimer = setTimeout(doReclean, 200);
  }

  async function doReclean(): Promise<void> {
    recleaning = true;
    recleanPending = false;
    const firstClean = cleanedGeoJSON == null;
    try {
      const result = await withDb((_db, conn) => recleanOnly(conn, { mode, gapWidthM }));
      cleanedGeoJSON = result.cleanedGeoJSON;
      modifiedGeoJSON = result.modifiedGeoJSON;
      collapsedCount = result.collapsedCount;
      fixedKeys = result.fixedKeys;
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
      detectionFailed = result.detectionFailed;
      exportCheck = result.exportCheck;
      error = null;
      errorStage = 0;
      currentStage = 5;
      if (firstClean) showSide = "b";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      recleaning = false;
      if (recleanPending) {
        recleanPending = false;
        setTimeout(doReclean, 0);
      }
    }
  }

  // Selecting an issue (from table or map) highlights it, switches to Version A
  // so the highlight is visible over the original coverage, and zooms to it.
  function selectIssue(key: string): void {
    const row = issues.find((r) => r.key === key);
    if (!row) return;
    selectedKey = key;
    showSide = "a";
    focusBbox = row.bbox.slice() as [number, number, number, number]; // fresh array → always re-zooms
  }

  function onMapIssueClick(key: string | null): void {
    if (key == null) {
      selectedKey = null;
      return;
    }
    selectIssue(key);
  }

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 5) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(f: File[]): string {
    return f[0]?.name.replace(/\.[^.]+$/, "") ?? "coverage";
  }
</script>

<div class="tc-layout">
  <aside class="tc-sidebar">
    <ToolHeader title="Topology Cleaner" demo="topo-clean">
      Drop a polygon layer to detect and fix overlaps and gaps. Click any issue to zoom to it. By default only noise-scale gaps get filled — switch modes or use the slider to control how much gets filled.
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="tc-error"><strong>Initialisation error:</strong> {duckdbState.initError}</div>
    {/if}

    <InputStep title="Layer">
      <DropZone
        bind:files
        urlParam="url"
        disabled={running || loading}
        helpText="Polygon coverage in any supported format — adjacent admin units, basins, etc."
      />
      {#if loading}<p class="tc-status">Loading…</p>{/if}
      {#if loadError}<div class="tc-error">{loadError}</div>{/if}
    </InputStep>

    {#if analyzed}
      <section class="tc-step">
        <h2 class="tc-step-heading">Gap width</h2>
        <div class="tc-mode-btns" role="group" aria-label="Gap-fill mode">
          <button
            class="tc-mode-btn"
            class:active={mode === "minimal"}
            disabled={running}
            onclick={() => setMode("minimal")}>Minimal</button
          >
          <button
            class="tc-mode-btn"
            class:active={mode === "thin"}
            disabled={running}
            onclick={() => setMode("thin")}>Thin</button
          >
          <button
            class="tc-mode-btn"
            class:active={mode === "all"}
            disabled={running}
            onclick={() => setMode("all")}>All</button
          >
          <button
            class="tc-mode-btn"
            class:active={mode === "manual"}
            disabled={running}
            onclick={() => setMode("manual")}>Manual</button
          >
        </div>
        {#if mode === "manual"}
          <label class="tc-slider">
            <span>Fill gaps up to — {fmtGap(gapWidthM)}</span>
            <input
              type="range"
              min="0"
              max={gapMaxM}
              step={gapStepM}
              bind:value={gapWidthM}
              oninput={scheduleReclean}
              disabled={running}
            />
            <p class="tc-hint">Fill enclosed gaps up to this width. Raise to close larger gaps.</p>
          </label>
        {:else}
          <p class="tc-hint">
            {#if effectiveGapWidthM > 0}
              Filling gaps up to {fmtGap(effectiveGapWidthM)}.
            {:else}
              No gaps will be filled.
            {/if}
            {#if mode === "minimal"}
              Only gaps at the scale of floating-point noise are filled — real enclosed features
              (a pond, a missing unit) are left alone.
            {:else if mode === "thin"}
              Fills every gap up to the width of the widest sliver-shaped gap. A long, narrow lake
              can count as a sliver, so real water may be filled too; use Manual to set the width
              yourself.
            {:else}
              Every detected gap is filled.
            {/if}
          </p>
        {/if}
      </section>
    {/if}

    {#if loading || running || recleaning || errorStage > 0}
      <ol class="tc-stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}<span class="tc-stage-x">✕</span>{:else}<span
                class="tc-stage-dot"
              ></span>{/if}
            <span>{i + 1 === currentStage && stageLabel ? stageLabel : label}</span>
          </li>
        {/each}
        {#if recleaning}
          <li class="active" role="status" aria-live="polite">
            <span class="tc-spinner" aria-hidden="true"></span>
            <span
              >{effectiveGapWidthM > 0
                ? `Filling gaps up to ${fmtGap(effectiveGapWidthM)}…`
                : "Fixing overlaps…"}</span
            >
          </li>
        {/if}
      </ol>
    {/if}

    {#if error}<div class="tc-error">{error}</div>{/if}

    {#if cleanedGeoJSON && collapsedCount > 0}
      <p class="tc-warn">{collapsedCount} of {totalCount} polygons were dropped — the input has crossing-boundary defects that could not be resolved even with automatic snapping.</p>
    {/if}

    {#if cleanedGeoJSON}
      <section class="tc-step">
        <h2 class="tc-step-heading">Download</h2>
        {#if exportCheck}
          {#if exportCheck.checkFailed}
            <p class="tc-export-check tc-export-check--fail">
              ⚠ Couldn't fully verify the export — GEOS failed to check it, even after retrying.
              Inspect the download in GIS software before relying on it.
            </p>
          {:else if exportCheck.invalidCount === 0 && exportCheck.residualGaps === 0 && exportCheck.residualOverlaps === 0}
            <p class="tc-export-check tc-export-check--ok">
              ✓ Export verified: {exportCheck.rowCount} valid polygons, no gaps or overlaps remain.
            </p>
          {:else}
            <p class="tc-export-check tc-export-check--warn">
              ⚠ Export check found
              {#if exportCheck.invalidCount > 0}{exportCheck.invalidCount} invalid {exportCheck.invalidCount === 1 ? "geometry" : "geometries"}{/if}
              {#if exportCheck.invalidCount > 0 && (exportCheck.residualGaps > 0 || exportCheck.residualOverlaps > 0)}, {/if}
              {#if exportCheck.residualGaps > 0}{exportCheck.residualGaps} residual {exportCheck.residualGaps === 1 ? "gap" : "gaps"}{/if}
              {#if exportCheck.residualGaps > 0 && exportCheck.residualOverlaps > 0}, {/if}
              {#if exportCheck.residualOverlaps > 0}{exportCheck.residualOverlaps} residual {exportCheck.residualOverlaps === 1 ? "overlap" : "overlaps"}{/if}
              in the exported output.
            </p>
          {/if}
        {/if}
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files)}
          cachedGeoJSON={cleanedGeoJSON}
          exportSource="clean_topology"
        />
      </section>
    {/if}

    {#if cleanedGeoJSON && issues.length > 0}
      <section class="tc-step">
        <h2 class="tc-step-heading">Download issues</h2>
        <p class="tc-hint">
          Just the detected gaps, overlaps, notches and merged micro-polygons. Open in QGIS or ArcGIS to
          inspect or fix them yourself.
        </p>
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(files)}
          cachedGeoJSON={issuesGeoJSON}
          exportSource="topology_issues"
          variant="secondary"
        />
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="tc-result">
    <div class="tc-map-pane">
      {#if cleanedGeoJSON}
        <SideToggle bind:side={showSide} labels={["Original", "Fixed"]} />
      {/if}
      <MapView
        originalGeojson={originalGeoJSON}
        cleanedGeojson={cleanedGeoJSON}
        modifiedGeojson={modifiedGeoJSON}
        issuesGeojson={issuesGeoJSON}
        {bounds}
        {focusBbox}
        {selectedKey}
        {showSide}
        processing={loading || running}
        onIssueClick={onMapIssueClick}
      />
    </div>
    {#if analyzed}
      <div class="tc-table-pane">
        <IssuesTable
          rows={issues}
          {selectedKey}
          {fixedKeys}
          {detectionFailed}
          onSelect={selectIssue}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .tc-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }
  .tc-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid var(--cd-grey--400);
    background: var(--cd-white);
  }
  :global(.tool-header) + .tc-step {
    border-top: none;
    padding-top: 0;
  }
  .tc-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cd-grey--400);
  }
  .tc-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
  }
  .tc-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .tc-slider input[type="range"] {
    width: 100%;
  }
  .tc-hint {
    font-size: 0.75rem;
    color: var(--cd-grey--800);
    margin: 0;
    line-height: 1.3;
  }
  .tc-num-input {
    width: 100%;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    color: var(--cd-grey--800);
    background: var(--cd-white);
  }
  .tc-num-input:disabled {
    background: var(--cd-grey--300);
    color: var(--cd-grey--600);
  }
  .tc-status {
    font-size: 0.85rem;
    color: var(--cd-grey--800);
    margin: 0;
  }
  .tc-error {
    padding: 0.6rem 0.8rem;
    background: var(--cd-red--300);
    border: 1px solid var(--cd-red--400);
    border-radius: var(--brand-radius--sm);
    color: var(--brand-error);
    font-size: 0.8rem;
    word-break: break-word;
  }
  .tc-warn {
    margin: 0;
    font-size: 0.8rem;
    color: var(--brand-warning);
    font-weight: 600;
  }
  .tc-export-check {
    margin: 0 0 0.6rem;
    padding: 0.5rem 0.65rem;
    font-size: 0.78rem;
    border-radius: var(--brand-radius--sm);
  }
  .tc-export-check--ok {
    color: var(--brand-success);
    background: var(--cd-green--300);
    border: 1px solid var(--cd-green--400);
  }
  .tc-export-check--warn {
    color: var(--cd-orange--800);
    background: var(--cd-orange--300);
    border: 1px solid var(--cd-orange--400);
  }
  .tc-export-check--fail {
    color: var(--brand-error);
    background: var(--cd-red--300);
    border: 1px solid var(--cd-red--400);
  }
  .tc-stages {
    list-style: none;
    padding: 0.75rem 0 0;
    margin: 0;
    border-top: 1px solid var(--cd-grey--400);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .tc-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }
  .tc-stages li.done {
    color: var(--cd-green--800);
  }
  .tc-stages li.active {
    color: var(--brand-primary--text);
    font-weight: 600;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .tc-stages li.error {
    color: var(--brand-error);
    font-weight: 600;
  }
  .tc-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .tc-stages li.active .tc-stage-dot,
  .tc-stages li.done .tc-stage-dot {
    opacity: 1;
  }
  .tc-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .tc-result {
    display: grid;
    grid-template-rows: 60% 40%;
    height: var(--app-height, 100dvh);
    min-width: 0;
  }
  .tc-map-pane {
    position: relative;
    min-height: 0;
    border-bottom: 1px solid var(--cd-grey--400);
  }
  .tc-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .tc-result {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr 360px;
    }
    .tc-map-pane {
      border-right: 1px solid var(--cd-grey--400);
      border-bottom: none;
    }
  }
  .tc-spinner {
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--cd-blue--brighter);
    border-top-color: var(--brand-primary--text);
    border-radius: 50%;
    animation: tc-spin 0.4s linear infinite;
  }
  @keyframes tc-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tc-mode-btns {
    display: flex;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    overflow: hidden;
    background: var(--cd-white);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-mode-btn {
    appearance: none;
    -webkit-appearance: none;
    flex: 1 1 0;
    padding: 0.3rem 0.6rem;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: var(--cd-white);
    color: var(--cd-grey--800);
    cursor: pointer;
    border-left: 1px solid var(--cd-grey--400);
    text-align: center;
  }
  .tc-mode-btn:first-child {
    border-left: none;
  }
  .tc-mode-btn:hover:not(:disabled) {
    background: var(--cd-grey--300);
    color: var(--cd-grey--800);
  }
  .tc-mode-btn.active {
    background: var(--brand-primary--text);
    color: var(--cd-white);
  }
  .tc-mode-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
