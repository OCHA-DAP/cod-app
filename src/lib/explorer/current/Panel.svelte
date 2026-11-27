<script lang="ts">
  import SegmentedControl from "$lib/components/SegmentedControl.svelte";
  import LabelsToggle from "$lib/explorer/components/LabelsToggle.svelte";
  import { dismiss } from "$lib/utils/dismiss";
  import { hdxDatasetUrl, hdxDownloads, type HdxDownload } from "$lib/utils/hdx";
  import { LEVELS, type CodMetadata, type Level } from "./metadata";

  let {
    iso3,
    level = $bindable(),
    counts,
    meta,
    missing,
  }: {
    iso3: string;
    level: Level;
    counts: Record<Level, number> | null;
    meta: CodMetadata | null;
    missing: boolean;
  } = $props();

  let downloads = $state<HdxDownload[] | null>(null);

  $effect(() => {
    const i = iso3;
    downloads = null;
    if (!meta) return;
    hdxDownloads(i)
      .catch(() => [])
      .then((d) => i === iso3 && (downloads = d));
  });

  const levelLabel = (n: number) => {
    const local = meta?.[`admin_${n}_name`];
    return local ? `Admin ${n} · ${local}` : `Admin ${n}`;
  };
</script>

<header class="panel-header">
  <div class="location">
    {#if missing}
      <span class="muted">No admin 1 to 4 boundaries for this location.</span>
    {:else}
      <SegmentedControl
        bind:value={level}
        label="Admin level"
        options={LEVELS.filter((n) => !iso3 || (counts && counts[n] > 0)).map((n) => ({
          value: n,
          label: levelLabel(n),
          count: counts?.[n].toLocaleString("en"),
        }))}
      />
    {/if}

    <div class="hdx">
      {#if !iso3}
        <span class="muted">All locations from the last global build</span>
      {:else if meta}
        <details class="download" use:dismiss>
          <summary>Download <span aria-hidden="true">▾</span></summary>
          <ul>
            {#if downloads === null}
              <li class="muted">Loading formats…</li>
            {:else}
              {#each downloads as d (d.url)}
                <li><a href={d.url} target="_blank" rel="noopener">Download {d.label}</a></li>
              {/each}
            {/if}
            <li class:divided={downloads?.length !== 0}>
              <a href={hdxDatasetUrl("cod-ab", iso3)} target="_blank" rel="noopener">Go to HDX dataset</a>
            </li>
          </ul>
        </details>
      {:else}
        <span class="muted">Not on HDX</span>
      {/if}
    </div>
    <LabelsToggle />
  </div>
</header>

<style>
  .panel-header {
    border-bottom: 1px solid var(--cd-grey--400);
  }
  .hdx {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .location {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 10px 16px;
  }
  .muted {
    color: var(--cd-grey--700);
    font-weight: 400;
  }
  .download {
    position: relative;
  }
  .download summary {
    display: block;
    padding: 5px 10px;
    border-radius: var(--brand-radius--sm);
    font-size: 12px;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
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
    right: 0;
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
  .download li.divided {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--cd-grey--400);
  }
</style>
