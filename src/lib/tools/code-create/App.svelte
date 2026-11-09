<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { choiceParam, textParam, syncParam, type ParamCodec } from "$lib/utils/syncParam.svelte";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import {
    parseMinWidth,
    runCodeCreate,
    SOURCE_CODES,
    type CodeIssueRow,
    type SourceCodes,
    type TargetSchema,
  } from "./pipeline/index";
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

  let rootCode = $state("");
  let delimMode = $state<"char" | "none">("char");
  let delimChar = $state("-");
  let minWidth = $state("3");
  let sourceCodes = $state<SourceCodes>("replace");
  let nameField = $state("");
  let codeField = $state("");
  // "none" in the URL is no delimiter; anything else is the character itself.
  const delimParam: ParamCodec<string> = {
    parse: (raw) => (raw === "none" ? "" : raw),
    format: (value) => (value === "" ? "none" : value),
  };
  const delimiter = $derived(delimMode === "none" ? "" : delimChar);
  syncParam("root", textParam, () => rootCode, (v) => (rootCode = v));
  syncParam("delim", delimParam, () => delimiter, (v) => {
    delimMode = v === "" ? "none" : "char";
    if (v !== "") delimChar = v;
  });
  syncParam("width", textParam, () => minWidth, (v) => (minWidth = v));
  syncParam("source", choiceParam(SOURCE_CODES), () => sourceCodes, (v) => (sourceCodes = v));
  syncParam("name", textParam, () => nameField, (v) => (nameField = v));
  syncParam("code", textParam, () => codeField, (v) => (codeField = v));

  let running = $state(false);
  let error = $state<string | null>(null);
  let ran = $state(false);
  let resultGeoJSON = $state<string | null>(null);
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let levelCount = $state(0);
  let issues = $state<CodeIssueRow[]>([]);

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
    levelCount = 0;
    issues = [];
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
    resetRun();

    const schema: TargetSchema | null =
      nameField.trim() === "" && codeField.trim() === "" ? null : { nameField, codeField };
    try {
      const result = await withDb((_db, conn) =>
        runCodeCreate(
          conn,
          rootCode,
          delimiter,
          minWidth,
          sourceCodes,
          schema,
        ),
      );
      resultGeoJSON = result.resultGeoJSON;
      resultBounds = result.bounds;
      levelCount = result.levelCount;
      issues = result.issues;
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
  const minWidthError = $derived.by(() => {
    try {
      parseMinWidth(minWidth);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  const configValid = $derived(
    rootCode.trim() !== "" &&
      (delimMode === "none" || [...delimChar].length === 1) &&
      minWidthError === null,
  );
  const canRun = $derived(loaded && templateValid && configValid && !loading);
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Code Create">
      Give every unit of a flat polygon layer a new hierarchical code, numbered within its parent and zero-padded to a configurable width, or build it from each level's own source codes.
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
        <h2 class="step-heading">Code format</h2>
        <label class="field">
          <span>Root code</span>
          <input type="text" bind:value={rootCode} placeholder="e.g. AAA" disabled={running} />
        </label>
        <label class="field">
          <span>Delimiter</span>
          <select bind:value={delimMode} disabled={running}>
            <option value="char">Character</option>
            <option value="none">None</option>
          </select>
        </label>
        {#if delimMode === "char"}
          <label class="field">
            <span>Delimiter character</span>
            <input type="text" maxlength="1" bind:value={delimChar} disabled={running} />
          </label>
        {/if}
        <label class="field">
          <span>Min width</span>
          <input type="text" bind:value={minWidth} placeholder="3, 2,2,4, or auto" disabled={running} />
        </label>
        <p class="field-hint">
          Digits each level's number is padded to: one width for all levels, one per level from
          coarsest, or auto for as many as each level needs.
        </p>
        {#if minWidthError}<p class="field-error">{minWidthError}</p>{/if}
        <label class="field">
          <span>Source codes</span>
          <select bind:value={sourceCodes} disabled={running}>
            <option value="replace">Replace with a new number</option>
            <option value="embed">Embed in the new code</option>
            <option value="copy">Copy to a new column, then replace</option>
          </select>
        </label>
      </section>

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
        <button class="run-btn" onclick={handleRun} disabled={!canRun || running}>
          {running ? "Assigning…" : "Run"}
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
          {levelCount} level{levelCount === 1 ? "" : "s"} coded.
          {issues.length} overflow issue{issues.length === 1 ? "" : "s"}.
        </p>
        {#if issues.length > 0}
          <div class="issues-scroll">
            <table class="issues-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Parent</th>
                  <th class="num">Children</th>
                </tr>
              </thead>
              <tbody>
                {#each issues as row (row.parentCode + "/" + row.level)}
                  <tr title={row.reason}>
                    <td>{row.level}</td>
                    <td>{row.parentCode}</td>
                    <td class="num">{row.childCount}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="code_create"
        />
        {#if issues.length > 0}
          <DownloadMenu
            primaryLabel="Download Issues CSV"
            filenameStem={fileStem(files[0])}
            exportSource="code_create_issues"
          />
        {/if}
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="map-container">
    <MapView
      geojson={resultGeoJSON}
      originalGeojson={originalGeoJSON}
      showSide={resultGeoJSON ? "b" : undefined}
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

  .field input,
  .field select {
    padding-block: 0.4rem;
    padding-left: 0.55rem;
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

  .issues-scroll {
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
  }

  .issues-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }

  .issues-table thead th {
    position: sticky;
    top: 0;
    background: var(--cd-grey--300);
    text-align: left;
    font-weight: 600;
    color: var(--cd-grey--800);
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--cd-grey--400);
  }

  .issues-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--cd-grey--300);
    color: var(--cd-grey--800);
  }

  .issues-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
