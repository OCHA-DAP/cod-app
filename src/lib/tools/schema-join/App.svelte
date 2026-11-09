<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { boolParam, numberParam, textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { attributesAt, type Bounds } from "$lib/db/layerView";
  import {
    DEFAULT_TARGET_SCHEMA,
    MIN_OVERLAP_DEFAULT,
    joinedRow,
    loadAndAssign,
    runSchemaJoin,
    type JoinIssueRow,
    type SchemaJoinResult,
  } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";
  import MapView from "$lib/components/MapView.svelte";
  import JoinTable from "./JoinTable.svelte";

  let inputFiles = $state<File[]>([]);
  let joinFiles = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let inputGeoJSON = $state<string | null>(null);
  let joinGeoJSON = $state<string | null>(null);
  let viewBounds = $state<Bounds | null>(null);
  let inputCount = $state(0);

  let useTemplates = $state(false);
  let nameField = $state(DEFAULT_TARGET_SCHEMA.nameField);
  let codeField = $state(DEFAULT_TARGET_SCHEMA.codeField);
  let minOverlap = $state(MIN_OVERLAP_DEFAULT);
  syncParam("templates", boolParam, () => useTemplates, (v) => (useTemplates = v));
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));
  syncParam("overlap", numberParam, () => minOverlap, (v) => (minOverlap = v));

  let running = $state(false);
  let error = $state<string | null>(null);
  let result = $state.raw<SchemaJoinResult | null>(null);
  let selectedValues = $state<Record<string, string | null> | null>(null);
  let selectedKey = $state<string | null>(null);

  let clearMap: (() => void) | undefined;

  onMount(() => {
    initDuckDB();
  });

  // DuckDB work runs one task at a time, in order.
  let queue: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task);
  }

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  $effect(() => {
    const c = inputFiles;
    const p = joinFiles;
    if (c.length === 0 || p.length === 0 || !duckdbState.ready) return;
    untrack(() => enqueue(handleLoad));
  });

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    inputGeoJSON = null;
    joinGeoJSON = null;
    viewBounds = null;
    result = null;
    error = null;
    selectedValues = null;
    selectedKey = null;
    try {
      const layers = await withDb((db, conn) => loadAndAssign(db, conn, inputFiles, joinFiles));
      inputGeoJSON = layers.inputGeoJSON;
      joinGeoJSON = layers.joinGeoJSON;
      viewBounds = layers.bounds;
      inputCount = layers.inputCount;
      loaded = true;
    } catch (e) {
      loadError = message(e);
    } finally {
      loading = false;
    }
  }

  async function join(): Promise<void> {
    running = true;
    selectedValues = null;
    selectedKey = null;
    try {
      result = await withDb((_db, conn) =>
        runSchemaJoin(conn, useTemplates ? { nameField, codeField } : null, minOverlap),
      );
      error = null;
    } catch (e) {
      result = null;
      error = message(e);
    } finally {
      running = false;
    }
  }

  $effect(() => {
    void [useTemplates, nameField, codeField, minOverlap];
    if (!loaded || !settingsValid) return;
    const timer = setTimeout(() => untrack(() => enqueue(join)), 400);
    return () => clearTimeout(timer);
  });

  async function inspectAt(lngLat: [number, number] | null): Promise<void> {
    selectedKey = null;
    selectedValues =
      lngLat && result
        ? await withDb((_db, conn) => attributesAt(conn, lngLat, "input_layer_01", "sj_result_attr"))
        : null;
  }

  async function showIssue(issue: JoinIssueRow): Promise<void> {
    selectedKey = issue.key;
    viewBounds = issue.bbox;
    selectedValues = await withDb((_db, conn) => joinedRow(conn, issue.unitA));
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const templateValid = $derived(nameField.includes("{n}") && codeField.includes("{n}"));
  const overlapValid = $derived(minOverlap > 0 && minOverlap <= 1);
  const settingsValid = $derived(overlapValid && (!useTemplates || templateValid));
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Schema Join" demo="schema-join">
      Copy a join layer's admin hierarchy columns onto each polygon of the input layer, from the join polygon it overlaps most. Geometry is left as is. Where a polygon already has a column with different values, the join layer's values are added as a numbered sibling column.
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layers" collapsed={result !== null} detail={[inputFiles[0]?.name, joinFiles[0]?.name].filter(Boolean).join(", ")}>
      <h3>Input layer</h3>
      <DropZone
        bind:files={inputFiles}
        urlParam="input"
        disabled={loading}
        helpText="The layer to add columns to, e.g. admin 2."
      />
      <h3>Join layer</h3>
      <DropZone
        bind:files={joinFiles}
        urlParam="join"
        disabled={loading}
        helpText="The coarser layer whose hierarchy columns to copy, e.g. admin 1."
      />
      {#if loading}<p class="status">Loading and matching…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </InputStep>

    {#if loaded}
      <AdvancedOptions>
        <div class="group">
          <label class="field">
            <span>Minimum overlap</span>
            <input type="number" min="0.01" max="1" step="0.05" bind:value={minOverlap} />
          </label>
          <p class="field-hint">
            Flag a polygon when its best join polygon covers less than this share of its area.
          </p>
          {#if !overlapValid}
            <p class="field-error">Minimum overlap must be above 0 and at most 1.</p>
          {/if}
          <label class="toggle">
            <input type="checkbox" bind:checked={useTemplates} />
            <span>Use naming templates</span>
          </label>
          <p class="field-hint">
            Pick the join layer's hierarchy columns by name instead of detecting them from the values.
          </p>
          {#if useTemplates}
            <label class="field">
              <span>Name template</span>
              <input type="text" class="mono" bind:value={nameField} />
            </label>
            <label class="field">
              <span>Code template</span>
              <input type="text" class="mono" bind:value={codeField} />
            </label>
            {#if !templateValid}
              <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
            {/if}
          {/if}
        </div>
      </AdvancedOptions>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download Joined Layer"
          filenameStem={fileStem(inputFiles[0])}
          exportSource="schema_join"
        />
        {#if result.issues.length > 0}
          <DownloadMenu
            primaryLabel="Download Issues"
            filenameStem={fileStem(inputFiles[0])}
            exportSource="schema_join_issues"
            variant="secondary"
          />
        {/if}
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <MapTableSplit>
    {#snippet map()}
      <MapView
        originalGeojson={inputGeoJSON}
        overlayOutlineGeojson={joinGeoJSON}
        bounds={viewBounds}
        processing={loading || running}
        onFeatureClick={inspectAt}
        registerClear={(fn: () => void) => {
          clearMap = fn;
        }}
      />
    {/snippet}
    {#snippet table()}
      <JoinTable
        {result}
        {inputCount}
        values={selectedValues}
        {selectedKey}
        emptyText={!loaded
          ? "Load an input and a join layer to join them."
          : running
            ? "Joining…"
            : "Fix the settings to run the join."}
        onIssueClick={showIssue}
      />
    {/snippet}
  </MapTableSplit>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 340px 1fr;
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

  .field input {
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    font-size: 0.85rem;
  }

  .field input.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--cd-grey--900);
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--brand-error);
    margin: 0;
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

</style>
