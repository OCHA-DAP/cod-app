<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import {
    numberParam,
    textParam,
    syncParam,
    type ParamCodec,
  } from "$lib/utils/syncParam.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import ProgressLine from "$lib/components/ProgressLine.svelte";
  import SegmentedControl from "$lib/components/SegmentedControl.svelte";
  import ResultView from "$lib/tools/change/ResultView.svelte";
  import { REL_ORDER } from "$lib/tools/change/pipeline";
  import { onMount, untrack } from "svelte";
  import { loadSide } from "./pipeline/load";
  import {
    parseMinWidth,
    runCodeUpdate,
    type ChangeRow,
    type LevelView,
    type TargetSchema,
  } from "./pipeline/index";

  let filesA = $state<File[]>([]);
  let filesB = $state<File[]>([]);
  let loadingSide = $state<"a" | "b" | null>(null);
  let loadedA = $state(false);
  let loadedB = $state(false);
  let loadError = $state<string | null>(null);
  let showSide = $state<"a" | "b">("b");
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let rootCode = $state("");
  let delimMode = $state<"auto" | "none" | "char">("auto");
  let delimChar = $state("");
  let minWidth = $state("");
  let nameFieldA = $state("");
  let codeFieldA = $state("");
  let nameFieldB = $state("");
  let codeFieldB = $state("");

  let tauMatch = $state(0.8);
  let tauSame = $state(0.98);
  syncParam("root", textParam, () => rootCode, (v) => (rootCode = v));
  // Absent is auto-detect, "none" is no delimiter, anything else the character itself.
  const delimParam: ParamCodec<string | null> = {
    parse: (raw) => (raw === "" ? undefined : raw === "none" ? "" : raw),
    format: (value) => (value === null ? "" : value === "" ? "none" : value),
  };
  const delimiter = $derived(delimMode === "auto" ? null : delimMode === "none" ? "" : delimChar);
  syncParam("delim", delimParam, () => delimiter, (v) => {
    delimMode = v === null ? "auto" : v === "" ? "none" : "char";
    if (v) delimChar = v;
  });
  syncParam("width", textParam, () => minWidth, (v) => (minWidth = v));
  syncParam("name-a", textParam, () => nameFieldA, (v) => (nameFieldA = v));
  syncParam("code-a", textParam, () => codeFieldA, (v) => (codeFieldA = v));
  syncParam("name-b", textParam, () => nameFieldB, (v) => (nameFieldB = v));
  syncParam("code-b", textParam, () => codeFieldB, (v) => (codeFieldB = v));
  syncParam("match", numberParam, () => tauMatch, (v) => (tauMatch = v));
  syncParam("same", numberParam, () => tauSame, (v) => (tauSame = v));

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let levelCount = $state(0);
  let changelog = $state<ChangeRow[]>([]);
  let levelViews = $state<LevelView[]>([]);
  let selectedLevel = $state<number | null>(null);
  let selectedClusterId = $state<number | null>(null);

  let runPending = false;

  onMount(() => {
    initDuckDB();
  });

  async function computeLoadedBounds(): Promise<[number, number, number, number] | null> {
    const conn = duckdbState.conn!;
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM (SELECT geom FROM cu_a_layer_01 UNION ALL SELECT geom FROM cu_b_layer_01)
      WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v)) ? [xmin, ymin, xmax, ymax] : null;
  }

  function resetRun(): void {
    ran = false;
    error = null;
    resultGeoJSON = null;
    resultBounds = null;
    levelCount = 0;
    changelog = [];
    levelViews = [];
    selectedLevel = null;
    selectedClusterId = null;
    showSide = "b";
  }

  $effect(() => {
    const f = filesA;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "a") return;
      loadedA = false;
      resetRun();
      loadSideThen("a");
    });
  });

  $effect(() => {
    const f = filesB;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "b") return;
      loadedB = false;
      resetRun();
      loadSideThen("b");
    });
  });

  async function loadSideThen(side: "a" | "b"): Promise<void> {
    loadError = null;
    loadingSide = side;
    try {
      const files = side === "a" ? filesA : filesB;
      await loadSide(duckdbState.db!, duckdbState.conn!, side, files);
      if (side === "a") loadedA = true;
      else loadedB = true;
      if (loadedA && loadedB) loadedBounds = await computeLoadedBounds();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingSide = null;
    }
  }

  function schemaFrom(nameField: string, codeField: string): TargetSchema | null {
    return nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
  }

  function requestRun(): void {
    if (running) runPending = true;
    else handleRun();
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;

    try {
      const result = await runCodeUpdate(duckdbState.conn!, {
        schemaA: schemaFrom(nameFieldA, codeFieldA),
        schemaB: schemaFrom(nameFieldB, codeFieldB),
        rootCode: rootCode.trim() === "" ? null : rootCode.trim(),
        delimiter,
        minWidth: minWidth.trim() === "" ? null : minWidth,
        codeColumnA: null,
        codeColumnB: null,
        nameColumnA: null,
        nameColumnB: null,
        tauMatch,
        tauSame,
        linkByCode: false,
        linkByName: false,
        linkMode: "either",
      });
      resultGeoJSON = result.resultGeoJSON;
      resultBounds = result.bounds;
      levelCount = result.levelCount;
      changelog = result.changelog;
      levelViews = result.levelViews;
      if (!levelViews.some((v) => v.level === selectedLevel)) selectedLevel = levelViews.at(-1)?.level ?? null;
      ran = true;
    } catch (e) {
      resetRun();
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
      if (runPending) {
        runPending = false;
        handleRun();
      }
    }
  }

  function fileStem(a: File[], b: File[]): string {
    const stem = (files: File[]) => files[0]?.name.replace(/\.[^.]+$/, "") ?? "";
    const sa = stem(a);
    const sb = stem(b);
    if (!sa && !sb) return "code_update";
    if (!sa || !sb || sa === sb) return sa || sb;
    return `${sa}_${sb}`;
  }

  const bothBlankA = $derived(nameFieldA.trim() === "" && codeFieldA.trim() === "");
  const oneBlankA = $derived((nameFieldA.trim() === "") !== (codeFieldA.trim() === ""));
  const bothBlankB = $derived(nameFieldB.trim() === "" && codeFieldB.trim() === "");
  const oneBlankB = $derived((nameFieldB.trim() === "") !== (codeFieldB.trim() === ""));
  const templatesValid = $derived(
    !oneBlankA &&
      !oneBlankB &&
      (bothBlankA || (nameFieldA.includes("{n}") && codeFieldA.includes("{n}"))) &&
      (bothBlankB || (nameFieldB.includes("{n}") && codeFieldB.includes("{n}"))),
  );
  const minWidthError = $derived.by(() => {
    if (minWidth.trim() === "") return null;
    try {
      parseMinWidth(minWidth);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  const formatOverrideValid = $derived(
    (delimMode !== "char" || [...delimChar].length === 1) && minWidthError === null,
  );
  const canRun = $derived(loadedA && loadedB && templatesValid && formatOverrideValid && !loadingSide);

  // Reads every setting so any change reruns; the debounce absorbs slider drags and typing.
  $effect(() => {
    const _settings = [rootCode, delimiter, minWidth, nameFieldA, codeFieldA, nameFieldB, codeFieldB, tauMatch, tauSame];
    if (!canRun) return;
    const timer = setTimeout(() => untrack(requestRun), 400);
    return () => clearTimeout(timer);
  });

  // Geometry-only classification never yields these two.
  const classes = REL_ORDER.filter((c) => c !== "renamed" && c !== "relocated");

  const levelView = $derived(levelViews.find((v) => v.level === selectedLevel) ?? null);

  // NEW code shows the assigned code, flagged only where the class doesn't predict it.
  const tableRows = $derived.by(() => {
    const byFid = new Map<number, ChangeRow>();
    for (const row of changelog) {
      if (row.level === selectedLevel && row.bFid != null && row.newCode != null) byFid.set(row.bFid, row);
    }
    const keepers = new Set(["unchanged", "renamed", "modified"]);
    const assigned = (row: ChangeRow | undefined): string | null => {
      if (!row?.newCode) return null;
      if (row.codeOutcome === "overflow") return `${row.newCode} (overflow)`;
      if (row.codeOutcome === "new" && keepers.has(row.relationshipClass)) return `${row.newCode} (new)`;
      return row.newCode;
    };
    return (levelView?.tableRows ?? []).map((r) => ({
      ...r,
      b_code: r.b_fid != null ? assigned(byFid.get(r.b_fid)) : null,
    }));
  });

  const outcomeSummary = $derived.by(() => {
    const counts: Record<string, number> = { retained: 0, new: 0, retired: 0, overflow: 0 };
    for (const row of changelog) counts[row.codeOutcome] = (counts[row.codeOutcome] ?? 0) + 1;
    return counts;
  });
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Code Update" demo="code-update">
      Reconcile an already-coded OLD layer against an uncoded NEW candidate. Unchanged and renamed units keep their code; modified, relocated, split, merged, and newly created units get a fresh one under their re-derived parent.
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layers" collapsed={ran} detail={[filesA[0]?.name, filesB[0]?.name].filter(Boolean).join(", ")}>
      <div class="dropzones">
        <div>
          <label class="zone-label">OLD (already coded)</label>
          <DropZone
            bind:files={filesA}
            urlParam="old"
            disabled={running || loadingSide === "a"}
            helpText="Polygon layer with an existing hierarchical code."
          />
        </div>
        <div>
          <label class="zone-label">NEW (uncoded candidate)</label>
          <DropZone
            bind:files={filesB}
            urlParam="new"
            disabled={running || loadingSide === "b"}
            helpText="Polygon layer to reconcile against OLD, same coverage area."
          />
        </div>
      </div>
      {#if loadingSide === "a"}<p class="status">Loading OLD...</p>{/if}
      {#if loadingSide === "b"}<p class="status">Loading NEW...</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </InputStep>

    {#if loadedA && loadedB}
      <section class="step">
        <h2 class="step-heading">Thresholds</h2>
        <label class="slider">
          <span>Matched: {Math.round(tauSame * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" bind:value={tauSame} />
          <p class="field-hint">
            How much a 1:1 matched pair must overlap (IoU) to classify as <em>unchanged</em> rather
            than <em>modified</em>.
          </p>
        </label>
        <label class="slider">
          <span>Related: {Math.round(tauMatch * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" bind:value={tauMatch} />
          <p class="field-hint">How much of either polygon must overlap the other to be considered related.</p>
        </label>
      </section>

      <AdvancedOptions>
        <div class="group">
          <h3>Code format</h3>
          <p class="field-hint">Anything left blank or on auto is detected from OLD's own codes.</p>
          <label class="field">
            <span>Root code</span>
            <input type="text" bind:value={rootCode} placeholder="auto-detect" />
          </label>
          <label class="field">
            <span>Delimiter</span>
            <select bind:value={delimMode}>
              <option value="auto">Auto-detect</option>
              <option value="none">None</option>
              <option value="char">Character</option>
            </select>
          </label>
          {#if delimMode === "char"}
            <label class="field">
              <span>Delimiter character</span>
              <input type="text" maxlength="1" bind:value={delimChar} />
            </label>
          {/if}
          <label class="field">
            <span>Min width</span>
            <input type="text" bind:value={minWidth} placeholder="auto-detect (or 3, 2,2,4, auto)" />
          </label>
          {#if minWidthError}<p class="field-error">{minWidthError}</p>{/if}
          {#if delimMode === "char" && [...delimChar].length !== 1}
            <p class="field-error">Enter one delimiter character.</p>
          {/if}
        </div>

        <div class="group">
          <h3>Target schema</h3>
          <p class="field-hint">
            Naming templates for a resolved level's number. Leave both blank per side to auto-detect
            the hierarchy structurally instead.
          </p>
          <fieldset class="fieldset">
            <legend>OLD</legend>
            <label class="field">
              <span>Name template</span>
              <input type="text" bind:value={nameFieldA} placeholder="auto-detect" />
            </label>
            <label class="field">
              <span>Code template</span>
              <input type="text" bind:value={codeFieldA} placeholder="auto-detect" />
            </label>
          </fieldset>
          <fieldset class="fieldset">
            <legend>NEW</legend>
            <label class="field">
              <span>Name template</span>
              <input type="text" bind:value={nameFieldB} placeholder="auto-detect" />
            </label>
            <label class="field">
              <span>Code template</span>
              <input type="text" bind:value={codeFieldB} placeholder="auto-detect" />
            </label>
          </fieldset>
          {#if !templatesValid}
            <p class="field-error">Both templates must be set per side, or both left blank, and contain "{"{n}"}".</p>
          {/if}
        </div>
      </AdvancedOptions>
    {/if}

    {#if running}
      <ProgressLine label="Reconciling..." />
    {/if}
    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if loadedA && loadedB}
      {#if levelViews.length > 1}
        <section class="step">
          <h2 class="step-heading">Level</h2>
          <SegmentedControl
            bind:value={() => (selectedLevel === null ? null : String(selectedLevel)), (v) => (selectedLevel = Number(v))}
            options={levelViews.map((v) => ({ value: String(v.level), label: `Level ${v.level}` }))}
            label="Level"
          />
        </section>
      {/if}

      {#if ran}
        <section class="step">
          <h2 class="step-heading">Download</h2>
          <p class="summary-line">
            {levelCount} level{levelCount === 1 ? "" : "s"} reconciled. {outcomeSummary.retained} retained,
            {outcomeSummary.new} new, {outcomeSummary.retired} retired, {outcomeSummary.overflow} overflow.
          </p>
          <DownloadMenu
            primaryLabel="Download GeoJSON"
            filenameStem={fileStem(filesA, filesB)}
            cachedGeoJSON={resultGeoJSON}
            exportSource="code_update"
          />
          <DownloadMenu
            primaryLabel="Download Changelog CSV"
            filenameStem={fileStem(filesA, filesB)}
            exportSource="code_update_changelog"
          />
        </section>
      {/if}
    {/if}

    <PrivacyNote />
  </aside>

  <ResultView
    overlayGeojson={levelView?.overlayGeoJSON ?? null}
    outlineAGeojson={levelView?.outlineAGeoJSON ?? null}
    outlineBGeojson={levelView?.outlineBGeoJSON ?? null}
    {tableRows}
    bounds={levelView?.bounds ?? loadedBounds}
    processing={loadingSide !== null || running}
    sideLabels={["OLD", "NEW"]}
    {classes}
    bind:showSide
    bind:selectedClusterId
  />
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 360px 1fr;
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid var(--cd-grey--400);
    background: var(--cd-white);
  }

  :global(.tool-header) + .step {
    border-top: none;
    padding-top: 0;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cd-grey--400);
  }

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .dropzones {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .zone-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--cd-grey--800);
    margin-bottom: 0.2rem;
  }

  .status {
    font-size: 0.85rem;
    color: var(--cd-grey--800);
    margin: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .field-hint {
    font-size: 0.75rem;
    color: var(--cd-grey--800);
    margin: 0;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }

  .field input,
  .field select {
    padding-block: 0.4rem;
    padding-left: 0.55rem;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .fieldset {
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--cd-grey--800);
    padding: 0 0.3rem;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--brand-error);
    margin: 0;
  }

  .slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }

  .slider input[type="range"] {
    width: 100%;
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

  .error-panel {
    background: var(--cd-red--300);
    border: 1px solid var(--cd-red--500);
    border-radius: var(--brand-radius--sm);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--brand-error);
    word-break: break-word;
  }

  .summary-line {
    font-size: 0.8rem;
    color: var(--cd-grey--800);
    line-height: 1.4;
    margin: 0;
  }

</style>
