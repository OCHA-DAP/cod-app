<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { boolParam, numberParam, textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { serialRunner } from "$lib/utils/serialRunner";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import { layerBounds } from "$lib/db/layerView";
  import type { ExportSource } from "$lib/db/export";
  import { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";
  import {
    preparePackageInput,
    restorePackageInput,
    runPackage,
    type PackageResult,
    type TargetSchema,
  } from "./pipeline/index";
  import type { Stage } from "./pipeline/validate";
  import SummaryTable from "./SummaryTable.svelte";
  import IssueMapView from "$lib/components/IssueMapView.svelte";
  import MapTableSplit from "$lib/components/MapTableSplit.svelte";
  import { findingInfo } from "$lib/components/MapPopup.svelte";
  import { onMount, untrack } from "svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import SegmentedControl from "$lib/components/SegmentedControl.svelte";
  import PackageMap from "./PackageMap.svelte";
  import { levelStyles } from "./levelStyle";
  import { colorByGroup } from "$lib/utils/groupColor";

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
  let clean = $state(true);
  let block = $state(true);
  // Set by "Package anyway"; any settings change clears it.
  let packageAnyway = false;
  let minLevel = $state(NaN);
  syncParam("clean", boolParam, () => clean, (v) => (clean = v));
  syncParam("block", boolParam, () => block, (v) => (block = v));
  syncParam("min", numberParam, () => minLevel, (v) => (minLevel = v));
  let loadedClean = $state<boolean | null>(null);

  let running = $state(false);
  let error = $state<string | null>(null);
  let result = $state<PackageResult | null>(null);
  let levelIndex = $state(-1);
  let mode = $state<"findings" | "polygons" | "features">("polygons");
  let selectedKey = $state<string | null>(null);
  const outputs = $derived(result?.outputs ?? null);

  const REPORTS: Record<Stage, { label: string; source: ExportSource }> = {
    schema: { label: "Download Schema Issues", source: "schema_detect_issues" },
    topo: { label: "Download Topology Issues", source: "validate_topo_issues" },
    code: { label: "Download Code Issues", source: "code_detect_issues" },
    name: { label: "Download Name Issues", source: "name_detect_issues" },
  };

  onMount(() => {
    initDuckDB();
  });

  // Clean runs on load, so switching it reloads the file.
  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    const _clean = clean;
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
    error = null;
    result = null;
    levelIndex = -1;

    try {
      await withDb(async (db, conn) => {
        await loadFile(db, conn, files);
        await preparePackageInput(conn, clean);
        originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);
        loadedBounds = await layerBounds(conn);
      });
      loaded = true;
      loadedClean = clean;
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
    const options = {
      minLevel: Number.isFinite(minLevel) ? minLevel : null,
      clean: loadedClean ?? clean,
      block: block && !packageAnyway,
      stem: fileStem(files[0]),
    };
    try {
      result = await withDb(async (_db, conn) => {
        await restorePackageInput(conn);
        return runPackage(conn, schema, options);
      });
      if (result.outputs) {
        const n = result.outputs.polygons.levels.length;
        if (levelIndex < 0 || levelIndex >= n) levelIndex = n - 1;
        if (mode === "findings" && !result.validation.issues.some((i) => i.count)) mode = "polygons";
      } else {
        mode = "findings";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }
  const requestRun = serialRunner(() => handleRun());

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  function levelExportSource(level: number): ExportSource | null {
    if (level < 0 || level > 7) return null;
    return `package_polygons_level_${level}` as ExportSource;
  }

  const bothBlank = $derived(nameField.trim() === "" && codeField.trim() === "");
  const oneBlank = $derived((nameField.trim() === "") !== (codeField.trim() === ""));
  const templateValid = $derived(
    !oneBlank && (bothBlank || (nameField.includes("{n}") && codeField.includes("{n}"))),
  );
  const canRun = $derived(loaded && templateValid && !loading);

  // Reads every setting so any change reruns; the debounce absorbs typing.
  $effect(() => {
    const _settings = [nameField, codeField, minLevel, block, loadedClean];
    packageAnyway = false;
    if (!canRun) return;
    const timer = setTimeout(() => untrack(requestRun), 400);
    return () => clearTimeout(timer);
  });

  const polygonLevels = $derived(outputs?.polygons.levels ?? []);
  const packageSources = $derived<ExportSource[]>([
    ...polygonLevels.flatMap((l) => levelExportSource(l.level) ?? []),
    "package_points",
    "package_lines",
  ]);
  const selectedPolygonLevel = $derived(polygonLevels[levelIndex]);
  // Each unit is filled by its parent level's group; the coarsest level has one fill.
  const polygonFill = $derived.by(() => {
    if (selectedPolygonLevel) {
      const parentKey = polygonLevels[levelIndex - 1]?.groupBy ?? [];
      return colorByGroup(selectedPolygonLevel.resultGeoJSON, parentKey);
    }
    return originalGeoJSON ? colorByGroup(originalGeoJSON, []) : null;
  });
  const levelList = $derived(
    outputs
      ? levelStyles([...polygonLevels.map((l) => l.level), ...outputs.points.levels])
      : [],
  );
  // Exterior lines bound the coarsest level, so they share its style.
  const styles = $derived.by(() => {
    if (!outputs || levelList.length === 0) return levelList;
    const exterior = Math.min(...outputs.lines.levels) - 1;
    return levelList.some((s) => s.depth === exterior)
      ? levelList
      : [{ ...levelList[0], depth: exterior }, ...levelList];
  });
  const labelField = $derived.by(() => {
    if (!outputs) return null;
    const props = (JSON.parse(outputs.points.resultGeoJSON).features[0]?.properties ?? {}) as Record<
      string,
      unknown
    >;
    return Object.keys(props).find((k) => /(^|_)name$/i.test(k)) ?? null;
  });

  const viewBounds = $derived(
    (selectedKey && result?.validation.map.bounds.get(selectedKey)) || loadedBounds,
  );
  function describe(key: string) {
    const i = result?.validation.issues.find((x) => x.key === key);
    if (!i) return null;
    return findingInfo(i, [
      ["Check", i.stage],
      ["Count", i.count?.toString() ?? ""],
    ]);
  }
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Package" demo="package">
      Clean the layer's topology, check its schema, codes and names, then run Package Polygons, Package Points and Package Lines in one pass and browse all three outputs. Errors stop packaging unless you choose to package anyway.
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
      <AdvancedOptions>
        <div class="group">
          <h3>Target schema</h3>
          <p class="field-hint">
            Naming templates for a resolved level's number. Leave both blank to auto-detect the
            hierarchy structurally instead.
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
        <div class="group">
          <label class="field">
            <span>Minimum level</span>
            <input
              type="number"
              min="0"
              step="1"
              bind:value={() => (Number.isFinite(minLevel) ? minLevel : null), (v) => (minLevel = v ?? NaN)}
              placeholder="all levels"
            />
          </label>
          <p class="field-hint">Leave out every level coarser than this one.</p>
          <label class="check-field">
            <input type="checkbox" bind:checked={clean} disabled={loading || running} />
            <span>Clean the topology on load (turn off for layers too large to clean)</span>
          </label>
          <label class="check-field">
            <input type="checkbox" bind:checked={block} disabled={running} />
            <span>Stop packaging when a check finds an error</span>
          </label>
        </div>
      </AdvancedOptions>
    {/if}

    {#if running}<p class="status">Packaging…</p>{/if}
    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result && !outputs}
      <section class="step">
        <h2 class="step-heading">Checks</h2>
        <p class="field-hint">The checks found errors, so nothing was packaged. Fix them, or package anyway.</p>
        <button class="run-btn" disabled={running} onclick={() => {
            packageAnyway = true;
            requestRun();
          }}>
          Package anyway
        </button>
      </section>
    {/if}

    {#if outputs}
      <section class="step">
        <h2 class="step-heading">Output</h2>
        <SegmentedControl
          bind:value={mode}
          label="Output"
          options={[
            { value: "polygons", label: "Polygons" },
            { value: "features", label: "Labels and lines" },
            { value: "findings", label: "Checks" },
          ]}
        />
        {#if mode === "findings"}
          <!-- The checks table sits under the map. -->
        {:else if mode === "polygons"}
          <SegmentedControl
            bind:value={() => String(levelIndex), (v) => (levelIndex = Number(v))}
            label="Polygon level"
            options={polygonLevels.map((lvl, i) => ({ value: String(i), label: `Level ${lvl.level}` }))}
          />
        {:else}
          <ul class="legend">
            {#each levelList as s, i (s.depth)}
              <li>
                <svg width="56" height="16" aria-hidden="true">
                  <line
                    x1="2"
                    y1="8"
                    x2="26"
                    y2="8"
                    stroke={s.color}
                    stroke-width={s.width}
                    stroke-linecap="round"
                    stroke-dasharray={s.dash ? s.dash.map((d) => d * s.width).join(" ") : undefined}
                  />
                  <text
                    x="32"
                    y="12"
                    fill={s.color}
                    font-size={s.textSize}
                    font-weight={s.bold ? 700 : 400}>Aa</text
                  >
                </svg>
                <span class:bold={s.bold}>Level {s.depth}{i === 0 ? " (outline)" : ""}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="step">
        <h2 class="step-heading">Download</h2>
        <DownloadMenu
          primaryLabel="Download package"
          filenameStem={fileStem(files[0])}
          zipName="{fileStem(files[0])}_package"
          exportSource={packageSources}
        />
      </section>
    {/if}

    {#if result}
      <section class="step">
        <h2 class="step-heading">Check reports</h2>
        {#each [{ label: "Download Summary CSV", source: "validate_summary" as ExportSource }, ...result.validation.ran.map((stage) => REPORTS[stage])] as d (d.source)}
          <DownloadMenu primaryLabel={d.label} filenameStem={fileStem(files[0])} exportSource={d.source} />
        {/each}
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  {#if result && mode === "findings"}
    <MapTableSplit>
      {#snippet map()}
        <IssueMapView
          issuesGeojson={result?.validation.map.geojson ?? null}
          originalGeojson={originalGeoJSON}
          bounds={viewBounds}
          {selectedKey}
          processing={loading || running}
          onIssueClick={(key) => (selectedKey = key)}
          {describe}
        />
      {/snippet}
      {#snippet table()}
        <SummaryTable
          result={result?.validation ?? null}
          {selectedKey}
          emptyText=""
          select={(key) => (selectedKey = selectedKey === key ? null : key)}
        />
      {/snippet}
    </MapTableSplit>
  {:else}
  <div class="map-container">
    <PackageMap
      polygons={polygonFill}
      polygonLevel={selectedPolygonLevel?.level ?? null}
      lines={outputs?.lines.resultGeoJSON ?? null}
      points={outputs?.points.resultGeoJSON ?? null}
      {styles}
      depthColumn={DEFAULT_DEPTH_COLUMN}
      {labelField}
      mode={mode === "features" ? "features" : "polygons"}
      bounds={loadedBounds}
      processing={loading || running}
    />
  </div>
  {/if}
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

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .legend .bold {
    font-weight: 600;
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

  .check-field {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .map-container {
    height: 100%;
    overflow: hidden;
  }
</style>
