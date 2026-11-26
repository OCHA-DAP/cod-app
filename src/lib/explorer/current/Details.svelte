<script lang="ts">
  import { getDecision } from "$lib/explorer/decisions";
  import { getSourceMetadataForCountry, type SourceMetadata } from "$lib/explorer/parquet/sourceMetadata";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import { formatDate } from "$lib/utils/date";
  import type { CodMetadata } from "./metadata";

  let { iso3, meta }: { iso3: string; meta: CodMetadata | null } = $props();

  let provider = $state<SourceMetadata | null>(null);

  const decision = $derived(getDecision(iso3));
  const pick = $derived(decision?.selectedSource ?? null);
  const pickLabel = $derived(ADMIN_SOURCES.find((s) => s.id === pick)?.label ?? pick);

  $effect(() => {
    const i = iso3;
    provider = null;
    getSourceMetadataForCountry(i)
      .then((rows) => {
        if (i !== iso3) return;
        provider = rows.find((r) => r.source === getDecision(i)?.selectedSource) ?? null;
      })
      .catch(() => {});
  });

  const clean = (v: string | undefined) =>
    (v ?? "").replace(/\s*<br\s*\/?>\s*/gi, "\n").trim();
  const rows = (pairs: [string, string | undefined][]) =>
    pairs.map(([k, v]): [string, string] => [k, clean(v)]).filter(([, v]) => v);
  const people = $derived(meta ? rows([["Source", meta.source], ["Contributor", meta.contributor]]) : []);
  const caveats = $derived(clean(meta?.caveats));
  const paragraphs = (t: string) => t.split(/\n\s*\n/);
  const methodology = $derived(clean(meta?.methodology_dataset));
  // update_frequency is in years (HDX lists 1 as 365 days).
  const frequency = (y: string | undefined) => (!y ? "" : y === "1" ? "Every year" : `Every ${y} years`);
  const dates = $derived(
    meta
      ? rows([
          ["Source date", meta.date_source],
          ["Updated", meta.date_updated],
          ["Valid on", meta.date_valid_on],
          ["Reviewed", meta.date_reviewed],
        ])
          .map(([k, v]): [string, string] => [k, formatDate(v)])
          .concat(rows([["Version", meta.version], ["Updates", frequency(meta.update_frequency)]]))
      : [],
  );
</script>

<div class="details-wrap">
<div class="details">
  <section class="tile">
    <h3>Boundaries</h3>
    <dl>
      {#if pick !== "ocha"}
        <div>
          <dt>Shown on the map</dt>
          <dd>
            {#if decision?.noSourceSuitable || !pick}
              Admin 0 only (no suitable source)
            {:else}
              {pickLabel}{#if provider}<span class="muted"
                  >, {provider.producer}{provider.validFrom ? `, ${formatDate(provider.validFrom)}` : ""}</span
                >{/if}
            {/if}
          </dd>
        </div>
      {/if}
      {#each people as [k, v] (k)}
        <div><dt>{pick === "ocha" || k !== "Source" ? k : "OCHA's COD-AB source"}</dt><dd>{v}</dd></div>
      {/each}
    </dl>
  </section>
  <section class="tile">
    <h3>Dates and version</h3>
    {#if dates.length}
      <dl class="rows">
        {#each dates as [k, v] (k)}<div><dt>{k}</dt><dd>{v}</dd></div>{/each}
      </dl>
    {:else}
      <p class="muted">None on HDX</p>
    {/if}
  </section>
  <section class="tile caveats">
    <div class="scroll">
      {#if methodology}
        <h3>Methodology</h3>
        {#each paragraphs(methodology) as t, i (i)}<p class="pre">{t}</p>{/each}
      {/if}
      {#if caveats}
        <h3 class:next={methodology}>Caveats</h3>
        {#each paragraphs(caveats) as t, i (i)}<p class="pre">{t}</p>{/each}
      {/if}
      {#if !methodology && !caveats}
        <h3>Methodology and caveats</h3>
        <p class="muted">None on HDX</p>
      {/if}
    </div>
  </section>
</div>
</div>

<style>
  .details-wrap {
    container-type: inline-size;
    height: 100%;
  }
  .details {
    box-sizing: border-box;
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 170px minmax(0, 1.6fr);
    gap: 8px;
    height: 100%;
    padding: 12px 16px;
  }
  @container (max-width: 560px) {
    .details {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 10px;
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    overflow-wrap: anywhere;
  }
  /* Caveats scroll within the row the other tiles size, so long ones don't grow the panel. */
  .caveats {
    position: relative;
    min-height: 120px;
    padding: 0;
  }
  .scroll {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    padding: 8px 10px;
  }
  h3.next {
    margin-top: 8px;
  }
  h3 {
    margin: 0;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    color: var(--cd-grey--700);
  }
  p,
  dl,
  dd {
    margin: 0;
  }
  .pre {
    white-space: pre-line;
  }
  .muted {
    color: var(--cd-grey--700);
  }
  dl {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  dt {
    font-size: 11px;
    color: var(--cd-grey--700);
  }
  .rows {
    display: grid;
    grid-template-columns: auto auto;
    justify-content: start;
    gap: 2px 12px;
  }
  .rows div {
    display: contents;
  }
  .rows dt {
    align-self: baseline;
  }
</style>
