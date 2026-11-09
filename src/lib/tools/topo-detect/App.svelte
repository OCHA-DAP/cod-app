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
  import MapView from "$lib/components/IssueMapView.svelte";
  import type { FeatureInfo } from "$lib/components/MapPopup.svelte";
  import { MAP_COLORS } from "$lib/utils/mapColors";
  import { fmtArea, fmtLength } from "$lib/utils/format";
  import { PipelineError, runDetect, type IssueKind, type IssueRow } from "./pipeline/index";

  const STAGE_LABELS = ["Load file", "Loading input", "Finding gaps & overlaps", "Assembling issues report"];

  let files = $state<File[]>([]);
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-4=active stage, 5=done
  let errorStage = $state(0); // stage number that failed, 0=none
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  let done = $state(false);
  let originalGeoJSON = $state<string | null>(null);
  let issuesGeoJSON = $state<string | null>(null);
  let issues = $state<IssueRow[]>([]);
  let failedKinds = $state<Set<IssueKind>>(new Set());
  let bounds = $state<[number, number, number, number] | null>(null);

  let selectedKey = $state<string | null>(null);
  let focusBbox = $state<[number, number, number, number] | null>(null);

  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const f = files;
    if (f.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (!running) handleRun();
      });
    }
  });

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    done = false;
    originalGeoJSON = null;
    issuesGeoJSON = null;
    issues = [];
    failedKinds = new Set();
    bounds = null;
    selectedKey = null;
    focusBbox = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";

    try {
      currentStage = 1;
      stageLabel = "Loading file…";
      const result = await withDb(async (db, conn) => {
        await loadFile(db, conn, files);
        return runDetect(conn, (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        });
      });

      originalGeoJSON = result.originalGeoJSON;
      issuesGeoJSON = result.issuesGeoJSON;
      issues = result.issues;
      failedKinds = result.failedKinds;
      bounds = result.bounds;
      currentStage = 5;
      stageLabel = "Done";
      done = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  function selectIssue(key: string): void {
    const row = issues.find((r) => r.key === key);
    if (!row) return;
    selectedKey = key;
    focusBbox = row.bbox.slice() as [number, number, number, number]; // fresh array → always re-zooms
  }

  const KIND_TONE: Record<IssueKind, string> = {
    overlap: MAP_COLORS.overlap,
    gap: MAP_COLORS.gap,
    "micro-polygon": MAP_COLORS.micro,
    notch: MAP_COLORS.notch,
  };

  function describe(key: string): FeatureInfo | null {
    const r = issues.find((x) => x.key === key);
    if (!r) return null;
    const fields: FeatureInfo["fields"] = [
      ["Max width", fmtLength(r.maxWidthM)],
      ["Area", fmtArea(r.areaM2)],
    ];
    if (r.thinnessRatio !== null) fields.push(["Thinness", r.thinnessRatio.toFixed(3)]);
    if (r.nearLengthM !== null) fields.push(["Near length", fmtLength(r.nearLengthM)]);
    if (r.units.length > 0) fields.push(["Units", r.units.join(", ")]);
    return { title: r.kind, tone: KIND_TONE[r.kind], fields };
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

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }
</script>

<div class="dt-layout">
  <aside class="dt-sidebar">
    <ToolHeader title="Detect" demo="topo-detect">
      Scan a polygon layer for gaps and overlaps and report them — a read-only inspection, not a fix. Click any issue to zoom to it.
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="dt-error">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layer">
      <DropZone
        bind:files
        urlParam="url"
        disabled={running}
        helpText="Polygon coverage in any supported format — adjacent admin units, basins, etc."
      />
    </InputStep>

    {#if running || errorStage > 0}
      <ol class="dt-stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}
              <span class="dt-stage-x">✕</span>
            {:else}
              <span class="dt-stage-dot"></span>
            {/if}
            <span>{i + 1 === currentStage && stageLabel ? stageLabel : label}</span>
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}
      <div class="dt-error">{error}</div>
    {/if}

    {#if done}
      <section class="dt-step">
        <h2 class="dt-step-heading">Download</h2>
        <p class="dt-hint">
          Every detected gap, overlap, micro-polygon and notch, regardless of size. Open in QGIS or ArcGIS to inspect
          them yourself.
        </p>
        <DownloadMenu
          primaryLabel="Download Issues"
          filenameStem={fileStem(files[0])}
          cachedGeoJSON={issuesGeoJSON ?? undefined}
          exportSource="detect_issues"
        />
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="dt-result">
    <div class="dt-map-pane">
      <MapView
        originalGeojson={originalGeoJSON}
        issuesGeojson={issuesGeoJSON}
        {bounds}
        {focusBbox}
        {selectedKey}
        processing={running}
        onIssueClick={onMapIssueClick}
        {describe}
      />
    </div>
    {#if done}
      <div class="dt-table-pane">
        <IssuesTable rows={issues} {selectedKey} detectionFailed={failedKinds} onSelect={selectIssue} />
      </div>
    {/if}
  </div>
</div>

<style>
  .dt-layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }

  .dt-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid var(--cd-grey--400);
    background: var(--cd-white);
  }

  :global(.tool-header) + .dt-step {
    border-top: none;
    padding-top: 0;
  }

  .dt-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cd-grey--400);
  }

  .dt-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
  }

  .dt-hint {
    font-size: 0.75rem;
    color: var(--cd-grey--800);
    margin: 0;
    line-height: 1.3;
  }

  .dt-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dt-stages li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--cd-grey--600);
  }

  .dt-stages li.done {
    color: var(--brand-success);
  }

  .dt-stages li.active {
    color: var(--brand-primary--text);
    font-weight: 500;
    animation: pulse 1s ease-in-out infinite;
  }

  .dt-stages li.error {
    color: var(--brand-error);
    font-weight: 500;
  }

  .dt-stage-x {
    width: 8px;
    font-size: 0.75rem;
    line-height: 1;
    flex-shrink: 0;
    text-align: center;
  }

  .dt-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
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

  .dt-error {
    background: var(--cd-red--300);
    border: 1px solid var(--cd-red--500);
    border-radius: var(--brand-radius--sm);
    padding: 0.6rem 0.75rem;
    font-size: 0.825rem;
    color: var(--brand-error);
    word-break: break-word;
  }

  .dt-result {
    display: grid;
    grid-template-rows: 60% 40%;
    height: var(--app-height, 100dvh);
    min-width: 0;
  }

  .dt-map-pane {
    position: relative;
    min-height: 0;
    border-bottom: 1px solid var(--cd-grey--400);
  }

  .dt-table-pane {
    min-height: 0;
  }

  @media (min-width: 1280px) {
    .dt-result {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr 360px;
    }
    .dt-map-pane {
      border-right: 1px solid var(--cd-grey--400);
      border-bottom: none;
    }
  }
</style>
