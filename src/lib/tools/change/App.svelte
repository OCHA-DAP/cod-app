<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { layerBounds } from "$lib/db/layerView";
  import { choiceParam, numberParam, syncParam, textParam } from "$lib/utils/syncParam.svelte";
  import { onMount, untrack, type Snippet } from "svelte";
  import ResultView from "./ResultView.svelte";
  import type { Map as MaplibreMap } from "maplibre-gl";
  import {
    PipelineError,
    reclassifyOnly,
    runFromLoaded,
    REL_ORDER,
    type RelClass,
    type TableRow,
  } from "./pipeline";
  import { detectColumns, type ColumnGuess } from "$lib/db/columns";
  import { detectUnitColumns } from "./pipeline/columns";
  import { buildKeyed, loadSide } from "./pipeline/load";

  const STAGE_LABELS = [
    "Load sources",
    "Build keyed layers",
    "Measure overlap",
    "Classify clusters",
    "Render result",
  ];

  // A preset Version A (the explorer's current boundaries) lays the tool out as a map over a panel;
  // it loads only once a Version B is dropped, and a new key clears Version B.
  interface PresetA {
    key: string;
    load: () => Promise<File[]>;
    label: string;
    code: string;
    name: string;
  }
  let {
    presetA,
    header,
    info,
    placeholder,
    map,
    hasResult = $bindable(false),
    allowB = true,
  }: {
    presetA?: PresetA | null;
    header?: Snippet;
    info?: Snippet;
    // The caller's map, kept mounted under the panel; the result draws onto map.
    placeholder?: Snippet;
    map?: MaplibreMap;
    hasResult?: boolean;
    // False hides the Version B input, for a preset with nothing to compare against.
    allowB?: boolean;
  } = $props();
  const hasPreset = untrack(() => presetA !== undefined);

  // Input state
  let filesA = $state<File[]>([]);
  let filesB = $state<File[]>([]);
  let loadedA = $state(false);
  let loadedB = $state(false);
  let loading = $state({ a: false, b: false });
  let loadError = $state<string | null>(null);
  let ran = $state(false);

  // Auto-detected columns + user selections
  let colsA = $state<ColumnGuess | null>(null);
  let colsB = $state<ColumnGuess | null>(null);
  let aCodeCol = $state<string | null>(null);
  let aNameCol = $state<string | null>(null);
  let bCodeCol = $state<string | null>(null);
  let bNameCol = $state<string | null>(null);

  // A pick equal to the auto-detected guess stays out of the URL; before load it holds the URL's value.
  function syncColumn(key: string, cols: () => ColumnGuess | null, guess: (c: ColumnGuess) => string | null,
    get: () => string | null, set: (v: string) => void): void {
    syncParam(key, textParam, () => {
      const c = cols();
      return c && get() === guess(c) ? "" : (get() ?? "");
    }, set);
  }
  if (!hasPreset) {
    syncColumn("code-a", () => colsA, (c) => c.code ?? null, () => aCodeCol, (v) => (aCodeCol = v));
    syncColumn("name-a", () => colsA, (c) => c.name, () => aNameCol, (v) => (aNameCol = v));
  }
  syncColumn("code-b", () => colsB, (c) => c.code ?? null, () => bCodeCol, (v) => (bCodeCol = v));
  syncColumn("name-b", () => colsB, (c) => c.name, () => bNameCol, (v) => (bNameCol = v));
  const pick = (cols: ColumnGuess, prior: string | null, guess: string | null) =>
    prior !== null && cols.all.includes(prior) ? prior : guess;

  // Thresholds
  let tauMatch = $state(0.8);
  let tauSame = $state(0.98);

  // Matching mode: geometry-first (pure spatial) or identity-first (code/name
  // anchors take priority over spatial overlap). Identity mode uses whichever
  // code/name columns the user has already selected on each side.
  let matchMode = $state<"geometry" | "identity">("geometry");
  let linkMode = $state<"either" | "both">("either");
  syncParam("match", numberParam, () => tauMatch, (v) => (tauMatch = v));
  syncParam("same", numberParam, () => tauSame, (v) => (tauSame = v));
  syncParam("by", choiceParam(["geometry", "identity"] as const), () => matchMode, (v) => (matchMode = v));
  syncParam("link", choiceParam(["either", "both"] as const), () => linkMode, (v) => (linkMode = v));
  const linkByCode = $derived(
    matchMode === "identity" && aCodeCol !== null && bCodeCol !== null,
  );
  const linkByName = $derived(matchMode === "identity" && aNameCol !== null && bNameCol !== null);

  // Pipeline run state
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-6=active, 7=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Results
  let overlayGeoJSON = $state<string | null>(null);
  let outlineAGeoJSON = $state<string | null>(null);
  let outlineBGeoJSON = $state<string | null>(null);
  let tableRows = $state<TableRow[]>([]);
  let bounds = $state<[number, number, number, number] | null>(null);

  let selectedClusterId = $state<number | null>(null);
  $effect(() => {
    hasResult = overlayGeoJSON !== null;
  });

  // Comparison mode
  let showSide = $state<"a" | "b">("b");
  let panelTab = $state<"changes" | "details">("changes");
  let replacingB = $state(false);

  onMount(() => {
    initDuckDB();
  });

  // Debounced reclassify on slider changes
  let reclassifyTimer: ReturnType<typeof setTimeout> | undefined;
  let reclassifying = $state(false);
  let reclassifyPending = false;

  // Auto-run when both sides are loaded. Re-dropping a file resets loadedA/B
  // to false then true again, which re-triggers the run.
  let runPending = false;
  $effect(() => {
    const a = loadedA;
    const b = loadedB;
    if (!a || !b) return;
    untrack(() => {
      if (running) runPending = true;
      else handleRun();
    });
  });

  // The preset that produced filesA, read when A loads so its columns match its files.
  let presetOfA: PresetA | null = null;
  let presetKey: string | null = null;
  $effect(() => {
    const preset = presetA;
    const key = preset?.key ?? null;
    untrack(() => {
      if (presetKey !== null && key !== presetKey && filesB.length > 0) clearInputs();
      presetKey = key;
    });
    if (!preset || filesB.length === 0) return;
    untrack(() => {
      preset
        .load()
        .then((files) => {
          if (presetA !== preset) return;
          presetOfA = preset;
          filesA = files;
        })
        .catch((e) => (loadError = e instanceof Error ? e.message : String(e)));
    });
  });

  // Auto-load each side when files are dropped.
  // Re-dropping after a run reloads: stale dropdowns/results would otherwise
  // linger because loadedA/loadedB stayed true from the prior run.
  $effect(() => {
    const f = filesA;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loading.a) return;
      colsA = null;
      loadedA = false;
      resetResults();
      loadSideThen("a");
    });
  });
  $effect(() => {
    const f = filesB;
    const ready = duckdbState.ready;
    replacingB = false;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loading.b) return;
      colsB = null;
      loadedB = false;
      resetResults();
      loadSideThen("b");
    });
  });

  function clearInputs(): void {
    filesA = [];
    filesB = [];
    colsA = colsB = null;
    aCodeCol = aNameCol = bCodeCol = bNameCol = null;
    loadedA = loadedB = false;
    resetResults();
  }

  function resetResults(): void {
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    bounds = null;
    selectedClusterId = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "b";
    panelTab = "changes";
    reclassifyPending = false;
    ran = false;
    if (reclassifyTimer) {
      clearTimeout(reclassifyTimer);
      reclassifyTimer = undefined;
    }
  }

  async function loadSideThen(side: "a" | "b"): Promise<void> {
    loadError = null;
    loading[side] = true;
    try {
      const table = `cw_${side}_layer_attr`;
      const current = () => (side === "a" ? filesA : filesB);
      // Files dropped or preset during a load are picked up by loading again.
      let files: File[];
      let preset: PresetA | null;
      let cols: Awaited<ReturnType<typeof detectColumns>> &
        Awaited<ReturnType<typeof detectUnitColumns>>;
      do {
        files = current();
        if (files.length === 0) return;
        preset = presetOfA;
        const loadFiles = files;
        cols = await withDb(async (db, conn) => {
          await loadSide(db, conn, side, loadFiles);
          return { ...(await detectColumns(conn, table)), ...(await detectUnitColumns(conn, table)) };
        });
      } while (current() !== files);
      if (side === "a") {
        aCodeCol = preset ? preset.code : pick(cols, aCodeCol, cols.code ?? null);
        aNameCol = preset ? preset.name : pick(cols, aNameCol, cols.name);
        colsA = cols;
        loadedA = true;
      } else {
        bCodeCol = pick(cols, bCodeCol, cols.code ?? null);
        bNameCol = pick(cols, bNameCol, cols.name);
        colsB = cols;
        loadedB = true;
      }
      if (loadedA && loadedB) {
        const loadedBounds = await withDb((_db, conn) =>
          layerBounds(conn, ["cw_a_layer_01", "cw_b_layer_01"]),
        );
        if (loadedBounds) bounds = loadedBounds;
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading[side] = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    selectedClusterId = null;
    currentStage = 1;
    errorStage = 0;
    stageLabel = "Sources loaded";
    try {
      const result = await withDb((_db, conn) => runFromLoaded(
        conn,
        {
          tauMatch,
          tauSame,
          aCodeCol: aCodeCol ? [aCodeCol] : [],
          aNameCol,
          bCodeCol: bCodeCol ? [bCodeCol] : [],
          bNameCol,
          linkByCode,
          linkByName,
          linkMode,
        },
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
      ));
      // A side reloaded during the run; its own run follows.
      if (!loadedA || !loadedB) return;
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
      bounds = result.bounds;
      currentStage = 7;
      stageLabel = "Done";
      ran = true;
      exposeDebugHook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
      if (runPending) {
        runPending = false;
        if (loadedA && loadedB) handleRun();
      }
    }
  }

  $effect(() => {
    const _a = aCodeCol;
    const _b = bCodeCol;
    const _an = aNameCol;
    const _bn = bNameCol;
    untrack(() => {
      if (!overlayGeoJSON || running) return;
      handleApplyColumns();
    });
  });

  async function handleApplyColumns(): Promise<void> {
    if (!duckdbState.ready || !overlayGeoJSON) return;
    running = true;
    try {
      const result = await withDb(async (_db, conn) => {
        await buildKeyed(conn, "a", aCodeCol ? [aCodeCol] : [], aNameCol);
        await buildKeyed(conn, "b", bCodeCol ? [bCodeCol] : [], bNameCol);
        return reclassifyOnly(conn, {
          tauMatch,
          tauSame,
          aCodeCol: aCodeCol ? [aCodeCol] : [],
          aNameCol,
          bCodeCol: bCodeCol ? [bCodeCol] : [],
          bNameCol,
          linkByCode,
          linkByName,
          linkMode,
        });
      });
      if (!loadedA || !loadedB) return;
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
      if (runPending) {
        runPending = false;
        if (loadedA && loadedB) handleRun();
      }
    }
  }

  function scheduleReclassify(): void {
    if (overlayGeoJSON == null) return;
    if (reclassifyTimer) clearTimeout(reclassifyTimer);
    if (reclassifying) {
      reclassifyPending = true;
      return;
    }
    reclassifyTimer = setTimeout(doReclassify, 100);
  }

  async function doReclassify(): Promise<void> {
    reclassifying = true;
    reclassifyPending = false;
    try {
      const result = await withDb((_db, conn) => reclassifyOnly(conn, {
        tauMatch,
        tauSame,
        aCodeCol: aCodeCol ? [aCodeCol] : [],
        aNameCol,
        bCodeCol: bCodeCol ? [bCodeCol] : [],
        bNameCol,
        linkByCode,
        linkByName,
        linkMode,
      }));
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
      exposeDebugHook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      reclassifying = false;
      if (reclassifyPending) {
        reclassifyPending = false;
        setTimeout(doReclassify, 0);
      }
    }
  }

  function exposeDebugHook(): void {
    if (typeof window === "undefined") return;
    const summary: Record<string, number> = {};
    for (const c of REL_ORDER) summary[c] = 0;
    const seen = new Set<string>();
    for (const r of tableRows) {
      const key = r.cluster_id + ":" + r.relationship_class;
      if (seen.has(key)) continue;
      seen.add(key);
      summary[r.relationship_class] = (summary[r.relationship_class] ?? 0) + 1;
    }
    // Per-cluster counts are derived from unique cluster_id; a single cluster
    // might produce multiple rows so we de-dup by (cluster_id, class).
    const clusterCounts: Record<string, number> = {};
    for (const c of REL_ORDER) clusterCounts[c] = 0;
    const clusterClass = new Map<number, RelClass>();
    for (const r of tableRows) clusterClass.set(r.cluster_id, r.relationship_class);
    for (const cls of clusterClass.values()) clusterCounts[cls]++;
    (window as unknown as { __cw_debug: unknown }).__cw_debug = {
      done: currentStage === 7,
      summary: clusterCounts,
      tableRows,
      selectedClusterId,
      overlayGeoJSON,
    };
  }

  $effect(() => {
    // Update debug hook on selection changes so tests can observe state.
    selectedClusterId;
    if (overlayGeoJSON != null) untrack(exposeDebugHook);
  });

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 7) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(a: File[], b: File[]): string {
    const stem = (files: File[]) => files[0]?.name.replace(/\.[^.]+$/, "") ?? "";
    const sa = stem(a);
    const sb = stem(b);
    if (!sa && !sb) return "changelog";
    if (!sa || !sb || sa === sb) return sa || sb;
    return `${sa}_${sb}`;
  }
</script>

{#snippet versionB(helpText: string)}
  <div data-testid="dropzone-b">
    <label class="cw-zone-label">Version B</label>
    <DropZone bind:files={filesB} urlParam="new" disabled={running || loading.b} {helpText} />
  </div>
{/snippet}

{#snippet loadStatus()}
  {#if loading.a}<p class="cw-status">Loading {presetA?.label ?? "Version A"}…</p>{/if}
  {#if loading.b}<p class="cw-status">Loading Version B…</p>{/if}
  {#if loadError}<div class="cw-error">{loadError}</div>{/if}
{/snippet}

{#snippet matching()}
  <div class="cw-match-toggle" role="group" aria-label="Matching mode">
    <button
      class="cw-match-btn"
      class:active={matchMode === "geometry"}
      disabled={running}
      onclick={() => { matchMode = "geometry"; scheduleReclassify(); }}
    >Geometry first</button>
    <button
      class="cw-match-btn"
      class:active={matchMode === "identity" && linkMode === "either"}
      disabled={running}
      onclick={() => { matchMode = "identity"; linkMode = "either"; scheduleReclassify(); }}
    >Code or name</button>
    <button
      class="cw-match-btn"
      class:active={matchMode === "identity" && linkMode === "both"}
      disabled={running}
      onclick={() => { matchMode = "identity"; linkMode = "both"; scheduleReclassify(); }}
    >Code and name</button>
  </div>
  <p class="cw-hint">
    {#if matchMode === "geometry"}
      Units matched by spatial overlap only.
    {:else if linkMode === "either"}
      Pairs units sharing a unique code <em>or</em> name even without overlap, so moved units
      are classified as <em>relocated</em>, <em>modified</em>, or <em>renamed</em> instead of
      merge/split/complex.
    {:else}
      Pairs units sharing a unique code <em>and</em> name even without overlap, so moved units
      are classified as <em>relocated</em>, <em>modified</em>, or <em>renamed</em> instead of
      merge/split/complex.
    {/if}
  </p>

  <label class="cw-slider">
    <span>Matched — {Math.round(tauSame * 100)}%</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      bind:value={tauSame}
      oninput={scheduleReclassify}
      disabled={running}
    />
    <p class="cw-hint">
      How much a 1:1 matched pair must overlap (IoU) to be classified as
      <em>unchanged</em> rather than <em>modified</em>.
    </p>
  </label>

  <label class="cw-slider">
    <span>Related — {Math.round(tauMatch * 100)}%</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      bind:value={tauMatch}
      oninput={scheduleReclassify}
      disabled={running}
    />
    <p class="cw-hint">
      How much of either polygon must overlap the other to be considered related.
      Lower = more units linked.
    </p>
  </label>
{/snippet}

{#snippet columnFields(cols: ColumnGuess, side: "a" | "b")}
  <label class="cw-field">
    <span>Code</span>
    {#if side === "a"}
      <select bind:value={aCodeCol} disabled={running}>
        <option value={null}>(none)</option>
        {#each cols.all as col (col)}<option value={col}>{col}</option>{/each}
      </select>
    {:else}
      <select bind:value={bCodeCol} disabled={running}>
        <option value={null}>(none)</option>
        {#each cols.all as col (col)}<option value={col}>{col}</option>{/each}
      </select>
    {/if}
  </label>
  <label class="cw-field">
    <span>Name</span>
    {#if side === "a"}
      <select bind:value={aNameCol} disabled={running}>
        <option value={null}>(none)</option>
        {#each cols.all as col (col)}<option value={col}>{col}</option>{/each}
      </select>
    {:else}
      <select bind:value={bNameCol} disabled={running}>
        <option value={null}>(none)</option>
        {#each cols.all as col (col)}<option value={col}>{col}</option>{/each}
      </select>
    {/if}
  </label>
{/snippet}

{#snippet runStatus()}
  {#if running || errorStage > 0}
    <ol class="cw-stages">
      {#each STAGE_LABELS as label, i}
        {@const status = stageStatus(i)}
        <li class={status}>
          {#if status === "error"}
            <span class="cw-stage-x">✕</span>
          {:else}
            <span class="cw-stage-dot"></span>
          {/if}
          <span class="cw-stage-label">
            {i + 1 === currentStage && stageLabel ? stageLabel : label}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
  {#if error}<div class="cw-error">{error}</div>{/if}
{/snippet}

{#snippet initError()}
  {#if duckdbState.initError}
    <div class="cw-error">
      <strong>Initialisation error:</strong>
      {duckdbState.initError}
    </div>
  {/if}
{/snippet}

{#snippet resultView(panel?: Snippet<[Snippet]>)}
  <ResultView
    sideLabels={[presetA?.label ?? "Version A", "Version B"]}
    overlayGeojson={overlayGeoJSON}
    outlineAGeojson={outlineAGeoJSON}
    outlineBGeojson={outlineBGeoJSON}
    {tableRows}
    {bounds}
    processing={(loadedA && loadedB) || running}
    {panel}
    mapHost={placeholder}
    hostMap={map}
    bind:showSide
    bind:selectedClusterId
  />
{/snippet}

{#if hasPreset}
  {#snippet bottom(body: Snippet)}
    {@const tabbed = info && body !== info && body !== noInfo}
    <section class="cw-panel" class:fit={filesB.length === 0}>
      {@render header?.()}
      {#if allowB || filesB.length > 0 || body !== noInfo}
        <div class="cw-panel-body">
          <div class="cw-panel-side">
            {@render initError()}
            {#if filesB.length > 0 && !replacingB}
              <div class="cw-loaded">
                <span class="cw-zone-label">Version B</span>
                <span class="cw-loaded-name" title={filesB[0].name}>{filesB[0].name}</span>
                {#if !running}
                  <span class="cw-loaded-actions">
                    <button type="button" class="cw-link" onclick={() => (replacingB = true)}>Replace</button>
                    <button type="button" class="cw-link" onclick={clearInputs}>Clear</button>
                  </span>
                {/if}
              </div>
            {/if}
            <div hidden={!allowB || (filesB.length > 0 && !replacingB)}>
              {@render versionB("Your version of these boundaries, in any supported format.")}
            </div>
            {#if replacingB}
              <button type="button" class="cw-link" onclick={() => (replacingB = false)}>Cancel</button>
            {/if}
            {@render loadStatus()}
            {@render runStatus()}
            {#if overlayGeoJSON || errorStage > 0}
              <AdvancedOptions>
                <div>
                  <h3>Matching</h3>
                  {@render matching()}
                </div>
                {#if colsB}
                  <fieldset class="cw-fieldset">
                    <legend>Version B columns</legend>
                    {@render columnFields(colsB, "b")}
                  </fieldset>
                {/if}
              </AdvancedOptions>
            {/if}
            <PrivacyNote />
          </div>
          <div class="cw-panel-main" class:tabbed>
            {#if tabbed}
              <div class="cw-panel-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={panelTab === "changes"} onclick={() => (panelTab = "changes")}>Changes</button>
                <button type="button" role="tab" aria-selected={panelTab === "details"} onclick={() => (panelTab = "details")}>Details</button>
              </div>
              <div class="cw-panel-tab">{@render (panelTab === "changes" ? body : info!)()}</div>
            {:else}
              {@render body()}
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/snippet}
  {#snippet noInfo()}{/snippet}

  {#snippet panelFor(table: Snippet)}
    {@render bottom(overlayGeoJSON || filesB.length > 0 || running ? table : (info ?? noInfo))}
  {/snippet}
  {@render resultView(panelFor)}
{:else}
  <div class="cw-layout">
    <aside class="cw-sidebar">
      <ToolHeader title="Changelog" demo="change">
        Compare two versions of a polygon layer (e.g. ADM2 across census rounds) and classify each unit as unchanged, modified, merged, split, created, or removed. Drop both versions; the tool overlays them, scores coverage per pair, and groups related polygons into clusters.
      </ToolHeader>

      {@render initError()}

      <InputStep title="Layers" collapsed={ran} detail={[filesA[0]?.name, filesB[0]?.name].filter(Boolean).join(", ")}>
        <div class="cw-dropzones">
          <div data-testid="dropzone-a">
            <label class="cw-zone-label">Version A</label>
            <DropZone
              bind:files={filesA}
              urlParam="old"
              disabled={running || loading.a}
              helpText="Older version. Polygon layer in any supported format."
            />
          </div>
          {@render versionB("Newer version. Same coverage area.")}
        </div>
        {@render loadStatus()}
      </InputStep>

      {#if overlayGeoJSON || errorStage > 0}
        <section class="cw-step">
          <h2 class="cw-step-heading">Thresholds</h2>
          {@render matching()}
        </section>

        <section class="cw-step">
          <h2 class="cw-step-heading">Pick code &amp; name columns</h2>
          <div class="cw-cols">
            {#if colsA}
              <fieldset class="cw-fieldset">
                <legend>Version A</legend>
                {@render columnFields(colsA, "a")}
              </fieldset>
            {/if}
            {#if colsB}
              <fieldset class="cw-fieldset">
                <legend>Version B</legend>
                {@render columnFields(colsB, "b")}
              </fieldset>
            {/if}
          </div>
        </section>
      {/if}

      {@render runStatus()}

      {#if overlayGeoJSON}
        <section class="cw-step">
          <h2 class="cw-step-heading">Download</h2>
          <div class="cw-downloads">
            <DownloadMenu
              primaryLabel="Changelog CSV"
              filenameStem={fileStem(filesA, filesB)}
              exportSource="crosswalk_changelog"
            />
          </div>
        </section>
      {/if}

      <PrivacyNote />
    </aside>

    {@render resultView()}
  </div>
{/if}

<style>
  .cw-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }
  .cw-panel {
    --cw-side-width: 270px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    height: 40vh;
    background: var(--cd-white);
    border-top: 1px solid var(--brand-grey--border);
    box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.08);
    font-size: 13px;
  }
  .cw-panel.fit {
    height: auto;
    max-height: 40vh;
  }
  .cw-panel-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--cw-side-width) minmax(0, 1fr);
  }
  .cw-panel-main {
    min-height: 0;
    overflow-y: auto;
  }
  .cw-panel-main.tabbed {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }
  .cw-panel-tabs {
    display: flex;
    gap: 4px;
    padding: 6px 12px 0;
    border-bottom: 1px solid var(--cd-grey--400);
  }
  .cw-panel-tabs button {
    padding: 4px 10px 6px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--cd-grey--800);
    cursor: pointer;
  }
  .cw-panel-tabs button[aria-selected="true"] {
    border-bottom-color: var(--brand-primary--text);
    color: var(--brand-primary--text);
    font-weight: 600;
  }
  .cw-panel-tab {
    min-height: 0;
    overflow-y: auto;
  }
  .cw-panel-side {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 16px;
    border-right: 1px solid var(--cd-grey--400);
  }
  .cw-panel-tab :global(.cw-table-toolbar) {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.5rem;
  }
  .cw-panel-tab :global(.cw-search) {
    width: 14rem;
    padding-block: 0.25rem;
  }
  .cw-panel-tab :global(.cw-class-filters) {
    flex: 1 1 0;
    min-width: 12rem;
  }
  .cw-panel-side :global(.drop-zone) {
    padding: 0.5rem 0.75rem;
  }
  .cw-loaded {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
  }
  .cw-loaded .cw-zone-label {
    width: 100%;
    margin: 0;
  }
  .cw-loaded-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--brand-font-mono);
    font-size: 12px;
  }
  .cw-loaded-actions {
    display: flex;
    gap: 8px;
  }
  .cw-link {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--cd-grey--800);
    text-decoration: underline;
    cursor: pointer;
  }
  .cw-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid var(--cd-grey--400);
    background: var(--cd-white);
  }
  :global(.tool-header) + .cw-step {
    border-top: none;
    padding-top: 0;
  }
  .cw-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cd-grey--400);
  }
  .cw-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
  }
  .cw-dropzones {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-zone-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--cd-grey--800);
    margin-bottom: 0.2rem;
  }
  .cw-cols {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-fieldset {
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    padding: 0.5rem 0.6rem;
  }
  .cw-fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--cd-grey--800);
    padding: 0 0.3rem;
  }
  .cw-field {
    display: grid;
    grid-template-columns: 60px 1fr;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
    font-size: 0.8rem;
  }
  .cw-field select {
    width: 100%;
    padding-block: 0.25rem;
    padding-left: 0.4rem;
    font-size: 0.8rem;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
  }
  .cw-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .cw-slider input[type="range"] {
    width: 100%;
  }
  .cw-hint {
    font-size: 0.75rem;
    color: var(--cd-grey--800);
    margin: 0;
    line-height: 1.3;
  }
  .cw-match-toggle {
    display: flex;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    overflow: hidden;
    margin-bottom: 0.35rem;
  }
  .cw-match-btn {
    flex: 1;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    border: none;
    border-left: 1px solid var(--cd-grey--500);
    background: var(--cd-white);
    color: var(--cd-grey--800);
    cursor: pointer;
  }
  .cw-match-btn:first-child {
    border-left: none;
  }
  .cw-match-btn:hover:not(:disabled) {
    background: var(--cd-grey--300);
    color: var(--cd-grey--800);
  }
  .cw-match-btn.active {
    background: var(--cd-grey--300);
    color: var(--cd-grey--900);
    font-weight: 600;
  }
  .cw-match-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cw-status {
    font-size: 0.85rem;
    color: var(--cd-grey--800);
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  .cw-error {
    padding: 0.6rem 0.8rem;
    background: var(--cd-red--300);
    border: 1px solid var(--cd-red--400);
    border-radius: var(--brand-radius--sm);
    color: var(--brand-error);
    font-size: 0.8rem;
    word-break: break-word;
  }
  .cw-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .cw-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }
  .cw-stages li.done {
    color: var(--cd-green--800);
  }
  .cw-stages li.active {
    color: var(--brand-primary--text);
    font-weight: 600;
    animation: pulse 1s ease-in-out infinite;
  }
  .cw-stages li.error {
    color: var(--brand-error);
    font-weight: 600;
  }
  .cw-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .cw-stages li.active .cw-stage-dot {
    opacity: 1;
  }
  .cw-stages li.done .cw-stage-dot {
    opacity: 1;
  }
  .cw-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .cw-downloads {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>
