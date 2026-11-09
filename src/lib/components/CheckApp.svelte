<script lang="ts" generics="R extends { map: FlaggedLayer }">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
  import type { Snippet } from "svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import type { ExportSource } from "$lib/db/export";
  import type { FlaggedLayer } from "$lib/db/flagged";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import type { TargetSchema } from "$lib/tools/schema-map/pipeline/targetSchema";
  import { onMount, untrack } from "svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import { serialRunner } from "$lib/utils/serialRunner";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import IssueMapView from "$lib/components/IssueMapView.svelte";
  import type { FeatureInfo } from "$lib/components/MapPopup.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";

  // One-layer check tools: load and run automatically, then a findings table
  // beside the flagged units on the map; level templates sit under Advanced options.
  let {
    slug,
    title,
    blurb,
    run,
    downloads,
    findings,
    describe,
  }: {
    slug: string;
    title: string;
    blurb: string;
    run: (conn: AsyncDuckDBConnection, schema: TargetSchema | null, stem: string) => Promise<R>;
    downloads: Array<{ label: string; source: ExportSource }> | ((result: R) => Array<{ label: string; source: ExportSource }>);
    findings: Snippet<
      [{ result: R | null; emptyText: string; selectedKey: string | null; select: (key: string) => void }]
    >;
    // Hover popup content for a flagged unit's finding on the map.
    describe?: (result: R, key: string) => FeatureInfo | null;
  } = $props();

  let files = $state<File[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let loadedBounds = $state<[number, number, number, number] | null>(null);

  let nameField = $state("");
  let codeField = $state("");
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));

  let running = $state(false);
  let error = $state<string | null>(null);
  let result = $state<R | null>(null);
  let selectedKey = $state<string | null>(null);

  onMount(() => {
    initDuckDB();
  });

  async function computeLoadedBounds(
    conn: AsyncDuckDBConnection,
  ): Promise<[number, number, number, number] | null> {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM layer_01 WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    return [xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))
      ? [xmin, ymin, xmax, ymax]
      : null;
  }

  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (!loading) handleLoad();
    });
  });

  async function handleLoad(): Promise<void> {
    loadError = null;
    loading = true;
    loaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    result = null;
    error = null;
    selectedKey = null;
    try {
      await withDb(async (db, conn) => {
        await loadFile(db, conn, files);
        originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);
        loadedBounds = await computeLoadedBounds(conn);
      });
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    result = null;
    selectedKey = null;
    const schema: TargetSchema | null = bothBlank ? null : { nameField, codeField };
    try {
      result = await withDb((_db, conn) => run(conn, schema, fileStem(files[0])));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }
  const requestRun = serialRunner(handleRun);

  function select(key: string): void {
    selectedKey = selectedKey === key ? null : key;
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const bothBlank = $derived(nameField.trim() === "" && codeField.trim() === "");
  const oneBlank = $derived((nameField.trim() === "") !== (codeField.trim() === ""));
  const templateValid = $derived(
    !oneBlank && (bothBlank || (nameField.includes("{n}") && codeField.includes("{n}"))),
  );
  const canRun = $derived(loaded && templateValid && !loading);

  // Reads every setting so any change reruns; the debounce absorbs typing.
  $effect(() => {
    const _settings = [nameField, codeField];
    if (!canRun) return;
    const timer = setTimeout(() => untrack(requestRun), 400);
    return () => clearTimeout(timer);
  });
  const viewBounds = $derived((selectedKey && result?.map.bounds.get(selectedKey)) || loadedBounds);
  const emptyText = $derived(
    !loaded ? "Load a coded layer to check it." : running ? "Checking…" : "Fix the settings to run the checks.",
  );
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader {title} demo={slug}>
      {blurb} Click any finding to zoom to it.
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layer">
      <DropZone
        bind:files
        urlParam="url"
        disabled={loading || running}
        helpText="Coded polygon layer, hierarchy embedded as columns. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </InputStep>

    {#if loaded}
      <AdvancedOptions>
        <div class="group">
          <h3>Target schema</h3>
          <p class="field-hint">
            Naming templates for a level's number. Leave both blank to auto-detect the hierarchy
            structurally instead.
          </p>
          <label class="field">
            <span>Name template</span>
            <input type="text" bind:value={nameField} placeholder="auto-detect" />
          </label>
          <label class="field">
            <span>Code template</span>
            <input type="text" bind:value={codeField} placeholder="auto-detect" />
          </label>
          {#if oneBlank}
            <p class="field-error">Both templates must be set, or both left blank to auto-detect.</p>
          {:else if !bothBlank && !templateValid}
            <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
          {/if}
        </div>
      </AdvancedOptions>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result}
      <section class="step">
        <h2 class="step-heading">Download</h2>
        {#each typeof downloads === "function" ? downloads(result) : downloads as d (d.source)}
          <DownloadMenu primaryLabel={d.label} filenameStem={fileStem(files[0])} exportSource={d.source} />
        {/each}
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <MapTableSplit>
    {#snippet map()}
      <IssueMapView
        issuesGeojson={result?.map.geojson ?? null}
        originalGeojson={originalGeoJSON}
        bounds={viewBounds}
        {selectedKey}
        processing={loading || running}
        onIssueClick={(key) => (selectedKey = key)}
        describe={describe && result ? (key) => describe(result!, key) : undefined}
      />
    {/snippet}
    {#snippet table()}
      {@render findings({ result, emptyText, selectedKey, select })}
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

  .step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--brand-error);
    margin: 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
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
