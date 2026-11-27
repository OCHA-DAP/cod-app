<script lang="ts">
  import { get } from "svelte/store";
  import { selectSourceLevel } from "$lib/explorer/map/admin";
  import { mapStore, selectedAdmin, selectedSource } from "$lib/explorer/map/store";
  import { getAllSourceStats } from "$lib/explorer/parquet/sourceStats";
  import { shownSources } from "$lib/explorer/hiddenSources";

  const LEVELS = [1, 2, 3, 4];
  type Total = { units: number; locations: number };
  let totals: Map<string, Total> | null = $state(null);

  getAllSourceStats().then((stats) => {
    const map = new Map<string, Total>();
    for (const s of stats) {
      const units = Number(s.featureCount);
      if (units <= 0) continue;
      const key = `${s.source}-${s.level}`;
      const t = map.get(key) ?? { units: 0, locations: 0 };
      t.units += units;
      t.locations += 1;
      map.set(key, t);
    }
    totals = map;
  });
</script>

{#if totals}
  <div class="table-scroll">
    <table style:--cols={$shownSources.length}>
      <thead>
        <tr>
          <th class="level-col">Level</th>
          {#each $shownSources as src (src.id)}
            <th class:active-col={src.id === $selectedSource}>{src.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each LEVELS as level (level)}
          <tr>
            <td class="level-col">Adm {level}</td>
            {#each $shownSources as src (src.id)}
              {@const t = totals.get(`${src.id}-${level}`)}
              {@const active = src.id === $selectedSource && level === $selectedAdmin}
              <td>
                {#if t}
                  <button
                    class="cell-btn"
                    class:active
                    aria-pressed={active}
                    onclick={() => selectSourceLevel(get(mapStore), "", src.id, level)}
                  >
                    <span>{t.units.toLocaleString()} units</span>
                    <span class="muted">{t.locations} locations</span>
                  </button>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="muted">Loading…</p>
{/if}

<style>
  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: calc(56px + var(--cols) * 110px);
    table-layout: fixed;
    border-collapse: collapse;
  }

  th,
  td {
    text-align: left;
    padding: 2px;
    font-size: 12px;
    border-bottom: 1px solid var(--cd-grey--300);
  }

  th {
    padding: 4px 6px;
    color: var(--cd-grey--700);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 11px;
  }

  th.active-col {
    color: var(--brand-primary--text);
  }

  .level-col {
    width: 56px;
    padding: 4px 6px;
  }

  .cell-btn {
    display: grid;
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--cd-grey--500);
    border-radius: 3px;
    background: var(--cd-white);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .cell-btn:hover {
    border-color: var(--brand-primary--text);
  }

  .cell-btn.active {
    border-color: var(--brand-primary--text);
    background: var(--brand-primary--text);
    color: var(--cd-white);
  }

  .muted {
    color: var(--cd-grey--600);
    font-size: 11px;
  }

  .cell-btn.active .muted {
    color: var(--cd-white);
  }
</style>
