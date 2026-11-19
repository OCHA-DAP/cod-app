<script lang="ts">
  import LabelsToggle from "$lib/explorer/components/LabelsToggle.svelte";
  import { hdxDatasetUrl, hdxDownloads, type HdxDownload } from "$lib/utils/hdx";
  import { LEVELS, type CodMetadata, type Level } from "./metadata";

  let {
    iso3,
    name,
    level = $bindable(),
    counts,
    meta,
    missing,
  }: {
    iso3: string;
    name: string;
    level: Level;
    counts: Record<Level, number> | null;
    meta: CodMetadata | null;
    missing: boolean;
  } = $props();

  let downloads = $state<HdxDownload[] | null>(null);
  const depth = $derived(counts ? Math.max(0, ...LEVELS.filter((n) => counts![n] > 0)) : 0);

  $effect(() => {
    const i = iso3;
    downloads = null;
    if (!meta) return;
    hdxDownloads(i)
      .catch(() => [])
      .then((d) => i === iso3 && (downloads = d));
  });

  const levelName = (n: number) => meta?.[`admin_${n}_name`] || `Admin ${n}`;
</script>

<header class="panel-header">
  <div class="hdx">
    {#if meta}
      <details class="download">
        <summary>Download from HDX</summary>
        <ul>
          {#if downloads === null}
            <li class="muted">Loading formats…</li>
          {:else}
            {#each downloads as d (d.url)}
              <li><a href={d.url} target="_blank" rel="noopener">{d.label}</a></li>
            {:else}
              <li>
                <a href={hdxDatasetUrl("cod-ab", iso3)} target="_blank" rel="noopener"
                  >All formats on HDX</a
                >
              </li>
            {/each}
          {/if}
        </ul>
      </details>
      <a class="dataset" href={hdxDatasetUrl("cod-ab", iso3)} target="_blank" rel="noopener"
        >Go to HDX dataset</a
      >
    {:else}
      <span class="muted">Not on HDX</span>
    {/if}
  </div>

  <div class="location">
    <h2>{name} <span class="iso3">{iso3}</span></h2>

    {#if missing}
      <span class="muted">No admin 1 to 4 boundaries for this location.</span>
    {:else}
      <div class="levels" role="group" aria-label="Admin level">
        {#each LEVELS as n (n)}
          <button
            type="button"
            class:active={level === n}
            disabled={counts !== null && n > Math.max(1, depth)}
            onclick={() => (level = n)}
          >
            {levelName(n)}
            <span class="count">{counts ? counts[n].toLocaleString("en") : "…"}</span>
          </button>
        {/each}
      </div>
    {/if}

    <span class="labels"><LabelsToggle /></span>
  </div>
</header>

<style>
  .panel-header {
    display: grid;
    grid-template-columns: var(--cw-side-width, 270px) minmax(0, 1fr);
    border-bottom: 1px solid var(--cd-grey--400);
  }
  .hdx {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    border-right: 1px solid var(--cd-grey--400);
  }
  .hdx > * {
    flex: 1 1 auto;
  }
  .location {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 10px 16px;
  }
  .labels {
    margin-left: auto;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--cd-grey--900);
    white-space: nowrap;
  }
  .iso3,
  .muted {
    color: var(--cd-grey--700);
    font-weight: 400;
  }
  .levels {
    display: flex;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius--sm);
    overflow: hidden;
  }
  .levels button {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 10px;
    border: 0;
    border-left: 1px solid var(--cd-grey--500);
    background: var(--cd-white);
    color: var(--cd-grey--800);
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .levels button:first-child {
    border-left: 0;
  }
  .levels button.active {
    background: var(--brand-primary--light);
    color: var(--cd-grey--900);
    font-weight: 600;
  }
  .levels button:disabled {
    cursor: default;
    opacity: 0.45;
  }
  .count {
    color: var(--cd-grey--700);
    font-weight: 400;
  }
  .download {
    position: relative;
  }
  .download summary,
  .dataset {
    display: block;
    padding: 5px 6px;
    border-radius: var(--brand-radius--sm);
    font-size: 12px;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
  }
  .download summary {
    list-style: none;
    cursor: pointer;
    background: var(--brand-primary--text);
    color: var(--cd-white);
  }
  .download summary::-webkit-details-marker {
    display: none;
  }
  .download ul {
    position: absolute;
    z-index: 5;
    left: 0;
    min-width: 100%;
    margin: 4px 0 0;
    padding: 4px 0;
    list-style: none;
    background: var(--cd-white);
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  }
  .download li a,
  .download li.muted {
    display: block;
    padding: 5px 12px;
    white-space: nowrap;
  }
  .dataset {
    border: 1px solid var(--brand-primary--text);
    text-decoration: none;
  }
</style>
