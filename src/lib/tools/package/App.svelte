<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { textParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { serialRunner } from "$lib/utils/serialRunner";
  import { loadFile } from "$lib/db/loader";
  import { tableToGeoJSON } from "$lib/db/geojson";
  import type { ExportSource } from "$lib/db/export";
  import { DEFAULT_DEPTH_COLUMN } from "$lib/tools/schema-fill/pipeline/index";
  import { runPackage, type PackageResult, type TargetSchema } from "./pipeline/index";
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

  let running = $state(false);
  let error = $state<string | null>(null);
  let result = $state<PackageResult | null>(null);
  let levelIndex = $state(-1);
  let mode = $state<"polygons" | "features">("polygons");

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
    error = null;
    result = null;
    levelIndex = -1;

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

    const schema: TargetSchema | null = bothBlank ? null : { nameField, codeField };
    try {
      result = await withDb((_db, conn) => runPackage(conn, schema));
      const n = result.polygons.levels.length;
      if (levelIndex < 0 || levelIndex >= n) levelIndex = n - 1;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }
  const requestRun = serialRunner(handleRun);

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
    const _settings = [nameField, codeField];
    if (!canRun) return;
    const timer = setTimeout(() => untrack(requestRun), 400);
    return () => clearTimeout(timer);
  });

  const polygonLevels = $derived(result?.polygons.levels ?? []);
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
    result
      ? levelStyles([...polygonLevels.map((l) => l.level), ...result.points.levels])
      : [],
  );
  // Exterior lines bound the coarsest level, so they share its style.
  const styles = $derived.by(() => {
    if (!result || levelList.length === 0) return levelList;
    const exterior = Math.min(...result.lines.levels) - 1;
    return levelList.some((s) => s.depth === exterior)
      ? levelList
      : [{ ...levelList[0], depth: exterior }, ...levelList];
  });
  const labelField = $derived.by(() => {
    if (!result) return null;
    const props = (JSON.parse(result.points.resultGeoJSON).features[0]?.properties ?? {}) as Record<
      string,
      unknown
    >;
    return Object.keys(props).find((k) => /(^|_)name$/i.test(k)) ?? null;
  });
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Package" demo="package">
      Run Package Polygons, Package Points, and Package Lines against the same layer in one pass, and browse all three outputs.
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
      </AdvancedOptions>
    {/if}

    {#if running}<p class="status">Packaging…</p>{/if}
    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if result}
      <section class="step">
        <h2 class="step-heading">Output</h2>
        <SegmentedControl
          bind:value={mode}
          label="Output"
          options={[
            { value: "polygons", label: "Polygons" },
            { value: "features", label: "Labels and lines" },
          ]}
        />
        {#if mode === "polygons"}
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

    <PrivacyNote />
  </aside>

  <div class="map-container">
    <PackageMap
      polygons={polygonFill}
      polygonLevel={selectedPolygonLevel?.level ?? null}
      lines={result?.lines.resultGeoJSON ?? null}
      points={result?.points.resultGeoJSON ?? null}
      {styles}
      depthColumn={DEFAULT_DEPTH_COLUMN}
      {labelField}
      {mode}
      bounds={loadedBounds}
      processing={loading || running}
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
