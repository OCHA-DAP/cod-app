<script lang="ts">
  import { downloadBlob } from "$lib/utils/download";
  import { sourceComparisonCsv } from "$lib/explorer/parquet/comparisonCsv";
  import { getDecision, pickEdits, sheetBlock } from "$lib/explorer/decisions";
  import LabelsToggle from "./LabelsToggle.svelte";
  import StatsComparisonTable from "./StatsComparisonTable.svelte";
  import PickEditor from "./PickEditor.svelte";

  interface Props {
    iso3: string;
  }

  let { iso3 }: Props = $props();
  const decision = $derived(iso3 ? getDecision(iso3) : null);
  let downloading = $state(false);
  let copied = $state(false);

  async function copyPicks() {
    await navigator.clipboard.writeText(sheetBlock());
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function downloadComparison() {
    downloading = true;
    try {
      downloadBlob(await sourceComparisonCsv(), "source_comparison.csv");
    } finally {
      downloading = false;
    }
  }

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
      <button
        class="download-link"
        onclick={downloadComparison}
        disabled={downloading}
        title="Download all countries comparison (CSV)"
      >
        CSV
      </button>
      {#if import.meta.env.DEV && pickEdits.size}
        <button
          class="download-link"
          onclick={copyPicks}
          title="Copies selected_source, rationale and accepted for every sheet row. Pull the sheet first, then paste on the first selected_source cell."
        >
          {copied ? "Copied" : `Copy picks (${pickEdits.size} edited)`}
        </button>
      {/if}
      {#if iso3}
        <p class="hint">
          <kbd>[</kbd> <kbd>]</kbd>
          <span class="tooltip">Use [ and ] to cycle through boundary sources</span>
        </p>
        <LabelsToggle />
      {/if}
    </div>
  </div>
  {#if iso3}
    {#if import.meta.env.DEV}
      <PickEditor {iso3} />
    {/if}
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
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-bottom: 10px;
  }

  /* Controls keep a fixed size; the title and note take the rest and wrap. */
  .title-group {
    display: flex;
    flex: 1 1 16rem;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 6px;
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
    margin-left: auto;
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
    white-space: nowrap;
    cursor: default;
  }

  kbd {
    padding: 0 4px;
    border: 1px solid var(--cd-grey--300);
    border-radius: 3px;
    font-family: inherit;
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
