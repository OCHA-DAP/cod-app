<script lang="ts">
  import { getDecision } from "$lib/explorer/decisions";
  import { getProvenanceForCountry } from "$lib/explorer/parquet/sourceProvenance";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import { hdxDatasetUrl, hdxDownloads, type HdxDownload } from "$lib/utils/hdx";
  import { codAbOnHdx, LEVELS, unitCounts, type CodMetadata, type Level } from "./metadata";

  let {
    iso3,
    name,
    level = $bindable(),
  }: { iso3: string; name: string; level: Level } = $props();

  let counts = $state<Record<Level, number> | null>(null);
  let meta = $state<CodMetadata | null>(null);
  let downloads = $state<HdxDownload[] | null>(null);
  let provider = $state<{ provider: string; sourceUpdated: string | null } | null>(null);

  const decision = $derived(getDecision(iso3));
  const pick = $derived(decision?.selectedSource ?? null);
  const pickLabel = $derived(ADMIN_SOURCES.find((s) => s.id === pick)?.label ?? pick);
  const depth = $derived(counts ? Math.max(0, ...LEVELS.filter((n) => counts![n] > 0)) : 0);

  $effect(() => {
    const i = iso3;
    counts = null;
    meta = null;
    downloads = null;
    provider = null;
    unitCounts(i)
      .then((c) => {
        if (i !== iso3) return;
        counts = c;
        const deepest = Math.max(1, ...LEVELS.filter((n) => c[n] > 0)) as Level;
        if (level > deepest) level = deepest;
      })
      .catch(() => {});
    codAbOnHdx().then((m) => {
      if (i !== iso3) return;
      meta = m.get(i) ?? null;
      if (meta)
        hdxDownloads(i)
          .catch(() => [])
          .then((d) => i === iso3 && (downloads = d));
    });
    getProvenanceForCountry(i).then((rows) => {
      if (i !== iso3) return;
      provider = rows.find((r) => r.source === getDecision(i)?.selectedSource) ?? null;
    });
  });

  const levelName = (n: number) => meta?.[`admin_${n}_name`] || `Admin ${n}`;
  const fields = $derived(
    meta
      ? ([
          ["Source", meta.source],
          ["Contributor", meta.contributor],
          ["Source date", meta.date_source],
          ["Valid on", meta.date_valid_on],
          ["Reviewed", meta.date_reviewed],
          ["Updated", meta.date_updated],
          ["Version", meta.version],
          ["Caveats", meta.caveats],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => [k, v.replace(/\s*<br\s*\/?>\s*/gi, "\n").trim()]) as [string, string][])
      : [],
  );
</script>

<section class="panel">
  <h2>{name} <span class="iso3">{iso3}</span></h2>

  {#if meta}
    <div class="hdx">
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
        >Go to dataset</a
      >
    </div>
  {:else}
    <p class="muted">No current COD-AB on HDX for this location.</p>
  {/if}

  <div class="levels" role="group" aria-label="Admin level">
    {#each LEVELS as n (n)}
      <button
        type="button"
        class:active={level === n}
        disabled={counts !== null && n > Math.max(1, depth)}
        onclick={() => (level = n)}
      >
        <span>{levelName(n)}</span>
        <span class="count">{counts ? counts[n].toLocaleString("en") : "…"}</span>
      </button>
    {/each}
  </div>

  <dl>
    <dt>Boundaries shown</dt>
    <dd>
      {#if decision?.noSourceSuitable || !pick}
        Admin 0 only (no suitable source)
      {:else}
        {pickLabel}{provider ? `, ${provider.provider}` : ""}{provider?.sourceUpdated
          ? ` (${provider.sourceUpdated})`
          : ""}
      {/if}
    </dd>
  </dl>

  {#if meta}
    <h3>{pick === "ocha" ? "COD-AB on HDX" : "OCHA's COD-AB on HDX"}</h3>
    <dl>
      {#each fields as [k, v] (k)}
        <dt>{k}</dt>
        <dd>{v}</dd>
      {/each}
    </dl>
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    font-size: 13px;
  }
  h2 {
    margin: 0;
    font-size: 1.25rem;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .iso3,
  .muted {
    color: var(--cd-grey--700);
    font-weight: 400;
  }
  .muted {
    margin: 0;
  }
  .hdx {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .download {
    position: relative;
    flex: 1;
  }
  .download summary {
    list-style: none;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    background: var(--brand-primary--text);
    color: var(--cd-white);
    font-weight: 600;
    text-align: center;
  }
  .download summary::-webkit-details-marker {
    display: none;
  }
  .download ul {
    position: absolute;
    z-index: 2;
    left: 0;
    right: 0;
    margin: 0.25rem 0 0;
    padding: 0.25rem 0;
    list-style: none;
    background: var(--cd-white);
    border: 1px solid var(--cd-grey--400);
    border-radius: 4px;
  }
  .download li a,
  .download li.muted {
    display: block;
    padding: 0.35rem 0.75rem;
  }
  .dataset {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--brand-primary--text);
    border-radius: 4px;
    text-decoration: none;
    font-weight: 600;
  }
  .levels {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.35rem;
  }
  .levels button {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--brand-grey--border);
    border-radius: 4px;
    background: var(--cd-white);
    cursor: pointer;
    font-size: 12px;
  }
  .levels button.active {
    border-color: var(--brand-primary--text);
    background: var(--brand-primary--light);
    font-weight: 600;
  }
  .levels button:disabled {
    cursor: default;
    opacity: 0.45;
  }
  .count {
    color: var(--cd-grey--700);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  dt {
    color: var(--cd-grey--700);
  }
  dd {
    margin: 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
