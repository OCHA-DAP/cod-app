<script lang="ts">
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import { duckdbState, initDuckDB, withDb } from "$lib/db/duckdb.svelte";
  import { boolParam, choiceParam, syncParam } from "$lib/utils/syncParam.svelte";
  import { onMount, untrack } from "svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import PrivacyNote from "$lib/components/PrivacyNote.svelte";
  import InputStep from "$lib/components/InputStep.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import CleanupNote from "$lib/components/CleanupNote.svelte";
  import AdvancedOptions from "$lib/components/AdvancedOptions.svelte";
  import CodeJoinPicker from "$lib/components/CodeJoinPicker.svelte";
  import MapView from "./MapView.svelte";
  import SideToggle from "$lib/components/SideToggle.svelte";
  import SegmentedControl from "$lib/components/SegmentedControl.svelte";
  import { runEdgeMatch, type EdgeMatchPhase } from "./pipeline/index";
  import type { MatchMode } from "./pipeline/assign";
  import type { GroupResult } from "./pipeline/groups";
  import ProgressLine from "$lib/components/ProgressLine.svelte";
  import type { ColumnGuess } from "$lib/db/columns";

  // Edge Extender stages each group runs through.
  const STAGE_COUNT = 5;

  type GroupRow = GroupResult | { overlayFid: number; label: string; inputCount: number; status: "pending" | "running" };

  let inputFiles = $state<File[]>([]);
  let overlayFiles = $state<File[]>([]);
  let running = $state(false);
  let phaseLabel = $state("");
  let error = $state<string | null>(null);

  let groupRows = $state<GroupRow[]>([]);
  let activeStage = $state(0);

  let resultGeoJSON = $state<string | null>(null);
  let overlayOutlineGeoJSON = $state<string | null>(null);
  let inputGeoJSON = $state<string | null>(null);
  let streamGeoJSON = $state<string | null>(null);
  let activeOverlayFid = $state<number | null>(null);
  let replacedGroupIds = $state<number[]>([]);
  let showSide = $state<"a" | "b">("b");
  let resultBounds = $state<[number, number, number, number] | null>(null);
  let unassignedCount = $state<number | null>(null);
  let droppedCount = $state<number | null>(null);
  let passthroughCount = $state<number | null>(null);
  let codeMismatchCount = $state<number | null>(null);
  let codeFallbackCount = $state<number | null>(null);
  let microCount = $state<number | null>(null);
  let invalidEdgeCount = $state<number | null>(null);
  let gapCount = $state<number | null>(null);
  let clipEmptyCount = $state<number | null>(null);
  let detachedMergedCount = $state<number | null>(null);
  let detachedKeptCount = $state<number | null>(null);
  let assignedOverlayLabel = $state<string | null>(null);
  let passthrough = $state(false);
  let skipClean = $state(false);
  let matchMode = $state<MatchMode>("auto");
  // What the last run used; under "auto" this is the automatic pick.
  let resolvedMode = $state<"one" | "many" | null>(null);
  const perFeature = $derived(resolvedMode === "many");
  const hasWarnings = $derived(
    (unassignedCount ?? 0) + (droppedCount ?? 0) + (codeMismatchCount ?? 0) + (clipEmptyCount ?? 0) > 0,
  );
  const hasNotes = $derived(
    (codeFallbackCount ?? 0) + (microCount ?? 0) + (invalidEdgeCount ?? 0) + (gapCount ?? 0) + (detachedMergedCount ?? 0) + (detachedKeptCount ?? 0) > 0,
  );

  // Optional code-join override (docs/adr/0045): defaults to "(none)" so the
  // first auto-run never changes behavior, even when a plausible code column
  // exists. Repicking after a run reruns the whole pipeline, since a
  // reassigned input feature can move to a different group entirely.
  let inputColumns = $state<ColumnGuess | null>(null);
  let overlayColumns = $state<ColumnGuess | null>(null);
  let inputMatchColumn = $state<string | null>(null);
  let overlayMatchColumn = $state<string | null>(null);

  syncParam(
    "match",
    choiceParam(["auto", "one", "many"] as const),
    () => matchMode,
    (v) => (matchMode = v),
  );
  syncParam("passthrough", boolParam, () => passthrough, (v) => (passthrough = v));
  syncParam("skipClean", boolParam, () => skipClean, (v) => (skipClean = v));
  onMount(() => {
    initDuckDB();
  });

  $effect(() => {
    const f = inputFiles;
    const c = overlayFiles;
    if (f.length > 0 && c.length > 0 && duckdbState.ready) {
      untrack(() => {
        if (running) return;
        inputColumns = null;
        overlayColumns = null;
        inputMatchColumn = null;
        overlayMatchColumn = null;
        handleRun();
      });
    }
  });

  // Repicking the code-join column after the first run reruns the whole
  // pipeline: a reassigned input feature can move to a different group entirely, so
  // there is no cheaper partial-recompute path here (unlike Changelog's).
  $effect(() => {
    const _c = inputMatchColumn;
    const _p = overlayMatchColumn;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      if ((inputMatchColumn == null) !== (overlayMatchColumn == null)) return;
      handleRun();
    });
  });

  $effect(() => {
    const _p = passthrough;
    const _c = skipClean;
    const _m = matchMode;
    untrack(() => {
      if (!resultGeoJSON || running) return;
      handleRun();
    });
  });

  function fileStem(file: File): string {
    return file.name.replace(/\.[^.]+$/, "");
  }

  // Finished groups' features, flushed to the map at most every 500 ms.
  let streamFeatures: unknown[] = [];
  let streamGroupIds: number[] = [];
  let streamTimer: ReturnType<typeof setTimeout> | undefined;

  // Swaps a group's input for its result in the same flush, so neither shows alone.
  function flushStream(): void {
    streamTimer = undefined;
    streamGeoJSON = JSON.stringify({ type: "FeatureCollection", features: streamFeatures });
    replacedGroupIds = [...streamGroupIds];
  }

  function resetStream(): void {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    streamFeatures = [];
    streamGroupIds = [];
    streamGeoJSON = null;
    replacedGroupIds = [];
  }

  function onProgress(event: EdgeMatchPhase): void {
    switch (event.phase) {
      case "loading":
        phaseLabel = "Loading files…";
        break;
      case "assigning":
        phaseLabel = "Computing overlap assignment…";
        break;
      case "groups-listed":
        phaseLabel = "";
        groupRows = event.groups.map((g) => ({ ...g, status: "pending" as const }));
        overlayOutlineGeoJSON = event.overlayOutlineGeojson;
        inputGeoJSON = event.inputGeojson;
        resultBounds = event.bounds;
        break;
      case "group-stage":
        activeStage = event.stage;
        activeOverlayFid = event.group.overlayFid;
        groupRows[event.groupIndex] = { ...event.group, status: "running" };
        break;
      case "group-done":
        groupRows[event.groupIndex] = event.result;
        if (event.result.geojson) {
          streamFeatures.push(...JSON.parse(event.result.geojson).features);
          streamGroupIds.push(event.result.overlayFid);
          streamTimer ??= setTimeout(flushStream, 500);
        }
        break;
      case "clipping":
        phaseLabel = "Clipping to overlay polygons…";
        break;
      case "cleaning":
        phaseLabel = "Closing seams between overlay polygons…";
        break;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    resultGeoJSON = null;
    overlayOutlineGeoJSON = null;
    inputGeoJSON = null;
    activeOverlayFid = null;
    resetStream();
    resultBounds = null;
    unassignedCount = null;
    droppedCount = null;
    passthroughCount = null;
    codeMismatchCount = null;
    codeFallbackCount = null;
    microCount = null;
    invalidEdgeCount = null;
    gapCount = null;
    clipEmptyCount = null;
    detachedMergedCount = null;
    detachedKeptCount = null;
    assignedOverlayLabel = null;
    groupRows = [];
    activeStage = 0;
    phaseLabel = "";

    try {
      const result = await withDb((db, conn) => runEdgeMatch(
        db,
        conn,
        inputFiles,
        overlayFiles,
        onProgress,
        { overlayMatchColumn: overlayMatchColumn ?? undefined, inputMatchColumn: inputMatchColumn ?? undefined },
        passthrough,
        matchMode,
        !skipClean,
      ));
      resultGeoJSON = result.geojson;
      showSide = "b";
      overlayOutlineGeoJSON = result.overlayOutlineGeojson;
      resultBounds = result.bounds;
      unassignedCount = result.unassignedCount;
      droppedCount = result.droppedCount;
      passthroughCount = result.passthroughCount;
      codeMismatchCount = result.codeMismatchCount;
      codeFallbackCount = result.codeFallbackCount;
      microCount = result.microCount;
      invalidEdgeCount = result.invalidEdgeCount;
      gapCount = result.gapCount;
      clipEmptyCount = result.clipEmptyCount;
      detachedMergedCount = result.detachedMergedCount;
      detachedKeptCount = result.detachedKeptCount;
      assignedOverlayLabel = result.assignedOverlayLabel;
      resolvedMode = result.mode;
      inputColumns = result.inputColumns;
      overlayColumns = result.overlayColumns;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      resetStream();
      activeOverlayFid = null;
      running = false;
        activeStage = 0;
    }
  }

  const failedGroups = $derived(
    groupRows.filter((g): g is GroupResult & { error: string } => g.status === "error" && "error" in g),
  );
  const cleanupCount = $derived((microCount ?? 0) + (detachedMergedCount ?? 0) + (detachedKeptCount ?? 0));
  const finishedCount = $derived(groupRows.filter((g) => g.status === "done" || g.status === "error").length);
  const statusLabel = $derived.by(() => {
    if (groupRows.length === 0 || phaseLabel) return phaseLabel;
    if (groupRows.length > 1) {
      return `Matching ${Math.min(finishedCount + 1, groupRows.length)} of ${groupRows.length}`;
    }
    const step = finishedCount === 1 ? STAGE_COUNT : Math.max(activeStage, 1);
    return `Step ${step} of ${STAGE_COUNT}`;
  });
</script>

<div class="layout">
  <aside class="sidebar">
    <ToolHeader title="Edge Matcher" demo="edge-match" hint="The overlay layer should be a clean coverage. Run Topology Cleaner first if unsure.">
      Fit an input polygon layer into an overlay boundary layer, extending edges so the result meets the boundary exactly. The layers can be adjacent levels (admin 4 into 3) or far apart (admin 4 straight into 0).
    </ToolHeader>

    {#if duckdbState.initError}
      <div class="error-panel">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <InputStep title="Layers" collapsed={resultGeoJSON !== null} detail={[inputFiles[0]?.name, overlayFiles[0]?.name].filter(Boolean).join(", ")}>
      <h3>Input layer</h3>
      <DropZone
        bind:files={inputFiles}
        urlParam="input"
        disabled={running}
        helpText="The layer to match and extend, any polygon set at any admin level. GeoJSON · GeoParquet · GeoPackage · Shapefile (ZIP)."
      />
      <h3>Overlay layer</h3>
      <DropZone
        bind:files={overlayFiles}
        urlParam="overlay"
        disabled={running}
        helpText="The boundary to match and clip against, one level up or many."
      />
    </InputStep>

    <section class="step">
      <h2 class="step-heading">Input layer matches how many overlay polygons?</h2>
      <SegmentedControl
        bind:value={
          () => (matchMode === "auto" ? resolvedMode : matchMode),
          (v) => {
            if (!(matchMode === "auto" && v === resolvedMode)) matchMode = v ?? "auto";
          }
        }
        options={[
          { value: "one", label: matchMode === "auto" && resolvedMode === "one" ? "One (auto)" : "One" },
          { value: "many", label: matchMode === "auto" && resolvedMode === "many" ? "Many (auto)" : "Many" },
        ]}
        label="Input layer matches how many overlay polygons?"
        disabled={running}
      />
      {#if matchMode !== "auto"}
        <button class="link-btn auto-reset" disabled={running} onclick={() => (matchMode = "auto")}>Pick automatically</button>
      {/if}
    </section>

    <AdvancedOptions>
      {#if inputColumns && overlayColumns}
        <CodeJoinPicker
          inputColumns={inputColumns.all}
          overlayColumns={overlayColumns.all}
          bind:inputValue={inputMatchColumn}
          bind:overlayValue={overlayMatchColumn}
          hint="Match by a shared code column where the codes agree, falling back to overlap where they don't."
          disabled={running}
        />
      {/if}
      <label class="check-field">
        <input type="checkbox" bind:checked={passthrough} disabled={running} />
        <span>Keep input polygons completely outside the overlay</span>
      </label>
      <label class="check-field">
        <input type="checkbox" bind:checked={skipClean} disabled={running} />
        <span>Skip the final clean, for very large layers (seams are listed as issues)</span>
      </label>
    </AdvancedOptions>

    {#if running && statusLabel}
      <section class="step">
        <ProgressLine label={statusLabel} />
      </section>
    {/if}

    {#if error}
      <div class="error-panel">{error}</div>
    {/if}

    {#if resultGeoJSON && !perFeature && assignedOverlayLabel}
      <p class="fit-mode">Matched to {assignedOverlayLabel}.</p>
    {/if}

    {#if hasWarnings}
      <div class="warn-panel">
        {#if clipEmptyCount !== null && clipEmptyCount > 0}
          <p>
            {clipEmptyCount} input polygon{clipEmptyCount === 1 ? " falls" : "s fall"} outside
            {perFeature ? "their overlay polygon" : "it"} and {clipEmptyCount === 1 ? "was" : "were"} clipped
            away.
            {#if !perFeature}
              <button class="link-btn" disabled={running} onclick={() => (matchMode = "many")}>
                Switch to Many
              </button>
            {/if}
          </p>
        {/if}
        {#if unassignedCount !== null && unassignedCount > 0}
          <p>
            {unassignedCount} input polygon{unassignedCount === 1 ? " is" : "s are"} completely outside the
            overlay{passthrough
              ? `; ${passthroughCount ?? 0} ${(passthroughCount ?? 0) === 1 ? "was" : "were"} kept`
              : ` and ${unassignedCount === 1 ? "was" : "were"} left out`}.
          </p>
        {/if}
        {#if droppedCount !== null && droppedCount > 0}
          <p>
            {droppedCount} input polygon{droppedCount === 1 ? " was" : "s were"} left out because
            {droppedCount === 1 ? "its" : "their"} group failed.
          </p>
          {#each failedGroups as g}
            <p class="group-error">{g.label}: {g.error}</p>
          {/each}
        {/if}
        {#if codeMismatchCount !== null && codeMismatchCount > 0}
          <p>
            {codeMismatchCount} input polygon{codeMismatchCount === 1 ? " was" : "s were"} matched by
            code to a different overlay polygon than overlap alone would pick.
          </p>
        {/if}
      </div>
    {/if}

    {#if hasWarnings || hasNotes}
      <div class="issues-notes">
        {#if codeFallbackCount !== null && codeFallbackCount > 0}
          <p>
            {codeFallbackCount} input polygon{codeFallbackCount === 1 ? "" : "s"} had no matching
            code and {codeFallbackCount === 1 ? "was" : "were"} matched by overlap.
          </p>
        {/if}
        {#if cleanupCount > 0}
          <p><CleanupNote count={cleanupCount} /></p>
        {/if}
        {#if invalidEdgeCount !== null && invalidEdgeCount > 0}
          <p>
            {invalidEdgeCount} pair{invalidEdgeCount === 1 ? "" : "s"} of polygons
            {invalidEdgeCount === 1 ? "has" : "have"} edges that overlap or don't match.
          </p>
        {/if}
        {#if gapCount !== null && gapCount > 0}
          <p>
            {gapCount} gap{gapCount === 1 ? "" : "s"} in the result. Some may be real gaps in the data rather
            than defects.
          </p>
        {/if}
        <DownloadMenu
          primaryLabel="Download issues"
          filenameStem={fileStem(inputFiles[0])}
          exportSource="match_issues"
        />
      </div>
    {/if}

    {#if resultGeoJSON}
      <section class="step">
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(inputFiles[0])}
          cachedGeoJSON={resultGeoJSON}
          exportSource="match"
        />
      </section>
    {/if}

    <PrivacyNote />
  </aside>

  <div class="map-container">
    {#if resultGeoJSON}
      <SideToggle bind:side={showSide} labels={["Original", "Matched"]} disabled={running} />
    {/if}
    <MapView
      resultGeojson={resultGeoJSON}
      inputGeojson={inputGeoJSON}
      streamGeojson={streamGeoJSON}
      overlayOutlineGeojson={overlayOutlineGeoJSON}
      {activeOverlayFid}
      {showSide}
      bounds={resultBounds}
      processing={running}
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
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cd-grey--400);
  }

  .fit-mode {
    font-size: 0.8rem;
    color: var(--cd-grey--800);
    margin: 0;
    line-height: 1.5;
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--brand-primary--text);
    text-decoration: underline;
    cursor: pointer;
  }

  .auto-reset {
    align-self: flex-start;
    font-size: 0.75rem;
  }

  .link-btn:disabled {
    color: var(--cd-grey--600);
    cursor: default;
  }

  .step-heading {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--cd-grey--900);
    margin: 0;
  }

  .check-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }

  .group-error {
    font-size: 0.75rem;
    word-break: break-word;
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

  .warn-panel {
    background: var(--cd-orange--300);
    border: 1px solid var(--cd-orange--400);
    border-radius: var(--brand-radius--sm);
    padding: 0.6rem 0.75rem;
    font-size: 0.8rem;
    color: var(--cd-orange--800);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .warn-panel p {
    margin: 0;
  }

  .issues-notes {
    font-size: 0.8rem;
    color: var(--cd-grey--800);
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .issues-notes p {
    margin: 0;
  }

  .map-container {
    position: relative;
    height: 100%;
    overflow: hidden;
  }
</style>
