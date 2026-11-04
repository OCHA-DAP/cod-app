<script lang="ts">
  import { downloadBlob } from "$lib/utils/download";
  import { sourceComparisonCsv } from "$lib/explorer/parquet/comparisonCsv";
  import { getDecisionForIso3, type Decision } from "$lib/explorer/sheet/decisions";
  import LabelsToggle from "./LabelsToggle.svelte";
  import StatsComparisonTable from "./StatsComparisonTable.svelte";

  interface Props {
    iso3: string;
  }

  let { iso3 }: Props = $props();
  let decision: Decision | null = $state(null);
  let downloading = $state(false);

  async function downloadComparison() {
    downloading = true;
    try {
      downloadBlob(await sourceComparisonCsv(), "source_comparison.csv");
    } finally {
      downloading = false;
    }
  }

  $effect(() => {
    const current = iso3;
    if (!current) {
      decision = null;
      return;
    }

    let cancelled = false;
    getDecisionForIso3(current).then((d) => {
      if (cancelled) return;
      decision = d;
    });

    return () => {
      cancelled = true;
    };
  });
</script>

<div class="stats-panel">
  <div class="stats-header">
    <div class="title-group">
      <h2>Compare sources</h2>
      {#if iso3 && decision?.rationale}
        <span class="rationale">— {decision.rationale}</span>
      {/if}
    </div>
    <div class="header-controls">
      <button class="download-link" onclick={downloadComparison} disabled={downloading}>
        Download all countries comparison (CSV)
      </button>
      {#if iso3}
        <p class="hint">
          [ ] to cycle sources
          <span class="tooltip">Use [ and ] to cycle through boundary sources</span>
        </p>
        <LabelsToggle />
      {/if}
    </div>
  </div>
  {#if iso3}
    <StatsComparisonTable {iso3} />
  {:else}
    <p class="muted">Select a country to compare sources.</p>
  {/if}
</div>

<style>
  .stats-panel {
    flex-shrink: 0;
    max-height: 40vh;
    overflow-y: auto;
    background: white;
    border-top: 1px solid var(--brand-grey--border);
    box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.08);
    padding: 16px;
    font-size: 13px;
  }

  .stats-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }

  .title-group {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--cd-grey--900);
    flex-shrink: 0;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .download-link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 11px;
    color: var(--cd-grey--800);
    text-decoration: underline;
    white-space: nowrap;
    cursor: pointer;
  }

  .hint {
    position: relative;
    margin: 0;
    font-size: 10px;
    color: var(--cd-grey--600);
    font-family: var(--brand-font-mono);
    cursor: default;
  }

  .tooltip {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    background: var(--cd-grey--900);
    color: var(--cd-white);
    font-size: 11px;
    white-space: nowrap;
    padding: 4px 8px;
    border-radius: 4px;
    pointer-events: none;
    z-index: 1;
  }

  .hint:hover .tooltip {
    display: block;
  }

  .muted {
    color: var(--cd-grey--600);
    font-size: 12px;
  }

  .rationale {
    font-size: 12px;
    color: var(--cd-grey--700);
    min-width: 0;
  }
</style>
