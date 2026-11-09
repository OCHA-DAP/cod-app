<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import { runPackagePoints, type TargetSchema } from "./pipeline/index";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import MapView from "$lib/components/MapView.svelte";

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
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let levels = $state<number[]>([]);
  let rootInjected = $state(false);

  let clearMap: (() => void) | undefined;

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

  function resetRun(): void {
    ran = false;
    error = null;
    resultGeoJSON = null;
    resultBounds = null;
    levels = [];
    rootInjected = false;
  }

  async function handleLoad(): Promise<void> {
    clearMap?.();
    loadError = null;
    loading = true;
    loaded = false;
    originalGeoJSON = null;
    loadedBounds = null;
    resetRun();

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
    resultGeoJSON = null;
    resultBounds = null;
    levels = [];
    rootInjected = false;

    const schema: TargetSchema | null =
      nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
    try {
      const result = await withDb((_db, conn) => runPackagePoints(conn, schema));
      resultGeoJSON = result.resultGeoJSON;
      resultBounds = result.bounds;
      levels = result.levels;
      rootInjected = result.rootInjected;
      ran = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  const bothBlank = $derived(nameField.trim() === "" && codeField.trim() === "");
  const oneBlank = $derived((nameField.trim() === "") !== (codeField.trim() === ""));
  const templateValid = $derived(
    !oneBlank && (bothBlank || (nameField.includes("{n}") && codeField.includes("{n}"))),
  );
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Package Points">
      Produce one representative point per admin unit, at every level a polygon layer's hierarchy contains, in a single combined output.
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
        helpText="Polygon layer. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      {#if loading}<p class="status">Loading file…</p>{/if}
      {#if loadError}<div class="error-panel">{loadError}</div>{/if}
    </InputStep>

    {#if loaded}
      <section class="step">
        <h2 class="step-heading">Target schema</h2>
        <p class="field-hint">
          Naming templates for a resolved level's number. Leave both blank to auto-detect the
          hierarchy structurally instead.
        </p>
        <label class="field">
          <span>Name template</span>
          <input type="text" bind:value={nameField} placeholder="auto-detect" disabled={running} />
        </label>
        <label class="field">
          <span>Code template</span>
          <input type="text" bind:value={codeField} placeholder="auto-detect" disabled={running} />
        </label>
        {#if oneBlank}
          <p class="field-error">Both templates must be set, or both left blank to auto-detect.</p>
        {:else if !bothBlank && !templateValid}
          <p class="field-error">Both templates must contain a "{"{n}"}" placeholder.</p>
        {/if}
        <button class="run-btn" onclick={handleRun} disabled={running || !templateValid}>
          {running ? "Packaging…" : "Run"}
        </button>
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if ran}
      <section class="step">
        <h2 class="step-heading">Result</h2>
        <p class="summary-line">
          Level{levels.length === 1 ? "" : "s"} {levels.join(", ")}{rootInjected
            ? " (level 0 auto-detected as a whole-table root)"
            : ""}.
        </p>
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="package_points"
        />
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON}
      bounds={resultBounds ?? loadedBounds}
      processing={loading || running}
      registerClear={(fn: () => void) => {
        clearMap = fn;
      }}
    />
  </div>
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

  .run-btn {
    background: var(--brand-primary--text);
    color: var(--cd-white);
    border: none;
    border-radius: var(--brand-radius--sm);
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .run-btn:hover:not(:disabled) {
    background: var(--brand-primary--dark);
  }

  .run-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
