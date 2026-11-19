<script lang="ts">
  import { getDecision } from "$lib/explorer/decisions";
  import { getProvenanceForCountry } from "$lib/explorer/parquet/sourceProvenance";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import type { CodMetadata } from "./metadata";

  let { iso3, meta }: { iso3: string; meta: CodMetadata | null } = $props();

  let provider = $state<{ provider: string; sourceUpdated: string | null } | null>(null);

  const decision = $derived(getDecision(iso3));
  const pick = $derived(decision?.selectedSource ?? null);
  const pickLabel = $derived(ADMIN_SOURCES.find((s) => s.id === pick)?.label ?? pick);

  $effect(() => {
    const i = iso3;
    provider = null;
    getProvenanceForCountry(i)
      .then((rows) => {
        if (i !== iso3) return;
        provider = rows.find((r) => r.source === getDecision(i)?.selectedSource) ?? null;
      })
      .catch(() => {});
  });

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

<div class="details">
  <dl>
    <div class="wide">
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
    </div>
  </dl>
  {#if meta}
    <h3>{pick === "ocha" ? "COD-AB on HDX" : "OCHA's COD-AB on HDX"}</h3>
    <dl>
      {#each fields as [k, v] (k)}
        <div class:wide={k === "Caveats"} class:double={k === "Source"}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      {/each}
    </dl>
  {:else}
    <p class="muted">No current COD-AB on HDX for this location.</p>
  {/if}
</div>

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
  }
  h3 {
    margin: 4px 0 0;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--cd-grey--700);
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--cd-grey--700);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px 16px;
    margin: 0;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .double {
    grid-column: span 2;
  }
  dt {
    font-size: 11px;
    color: var(--cd-grey--700);
  }
  dd {
    margin: 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
