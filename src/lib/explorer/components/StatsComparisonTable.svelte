<script lang="ts">
  import { selectSource, selectSourceLevel } from "$lib/explorer/map/admin";
  import { mapStore, selectedAdmin, selectedSource } from "$lib/explorer/map/store";
  import { getIso3166ForCountry, type Iso3166 } from "$lib/explorer/parquet/iso3166";
  import {
    getMapboxBoundariesForCountry,
    type MapboxBoundaries,
  } from "$lib/explorer/parquet/mapboxBoundaries";
  import { getMatchForCountry, type SourceMatch } from "$lib/explorer/parquet/sourceMatch";
  import { getSourceMetadataForCountry, type SourceMetadata } from "$lib/explorer/parquet/sourceMetadata";
  import { getStatsForCountry, type SourceStat } from "$lib/explorer/parquet/sourceStats";
  import { getDecision } from "$lib/explorer/decisions";
  import { formatDate } from "$lib/utils/date";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import { get } from "svelte/store";

  interface Props {
    iso3: string;
  }

  let { iso3 }: Props = $props();
  let stats: SourceStat[] = $state([]);
  let loading = $state(true);
  const decision = $derived(getDecision(iso3));
  let metadata: SourceMetadata[] = $state([]);
  let iso3166: Iso3166 | null = $state(null);
  let mapboxBoundaries: MapboxBoundaries | null = $state(null);
  let matches: SourceMatch[] = $state([]);

  function onSourceClick(sourceId: string) {
    selectSource(get(mapStore), iso3, sourceId);
  }

  function onCellClick(sourceId: string, level: number) {
    selectSourceLevel(get(mapStore), iso3, sourceId, level);
  }

  const LEVELS = [1, 2, 3, 4];

  // Internal and edge counts can differ by orders of magnitude for the same
  // country (an archipelago's edge count dwarfs its internal count), so each
  // value picks its own unit rather than sharing one across the table.
  function formatCount(n: number | bigint): string {
    const v = Number(n);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
    if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
    return `${Math.round(v)}`;
  }

  // The table sits in a panel with overflow-y: auto, which clips a CSS-only
  // above/below tooltip on whichever row happens to be closest to that edge
  // (the top row when opening upward, the bottom row when opening downward).
  // Positioning with `fixed` + coordinates computed on hover escapes that
  // clipping (fixed elements aren't confined by an ancestor's overflow unless
  // that ancestor has a transform, which none here do) and lets every row and
  // column pick whichever side actually has room in the viewport.
  const TOOLTIP_WIDTH = 220;
  const TOOLTIP_EST_HEIGHT = 90;
  const GAP = 4;

  let tooltipPos: { x: number; y: number; openBelow: boolean } | null = $state(null);

  function showTooltip(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const openBelow =
      rect.bottom + GAP + TOOLTIP_EST_HEIGHT <= window.innerHeight ||
      rect.top - GAP - TOOLTIP_EST_HEIGHT < 0;
    const x = Math.min(Math.max(rect.left, GAP), window.innerWidth - TOOLTIP_WIDTH - GAP);
    const y = openBelow ? rect.bottom + GAP : rect.top - GAP;
    tooltipPos = { x, y, openBelow };
  }

  function hideTooltip() {
    tooltipPos = null;
  }

  $effect(() => {
    const current = iso3;
    loading = true;
    let cancelled = false;
    getStatsForCountry(current).then((s) => {
      if (cancelled) return;
      stats = s;
      loading = false;
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const current = iso3;
    let cancelled = false;
    getSourceMetadataForCountry(current).then((m) => {
      if (cancelled) return;
      metadata = m;
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const current = iso3;
    let cancelled = false;
    getIso3166ForCountry(current).then((i) => {
      if (cancelled) return;
      iso3166 = i;
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const current = iso3;
    let cancelled = false;
    getMapboxBoundariesForCountry(current).then((m) => {
      if (cancelled) return;
      mapboxBoundaries = m;
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const current = iso3;
    let cancelled = false;
    getMatchForCountry(current).then((m) => {
      if (cancelled) return;
      matches = m;
    });

    return () => {
      cancelled = true;
    };
  });

  interface SourceCol {
    id: string;
    label: string;
    levels: Record<number, SourceStat | undefined>;
    matches: Record<number, SourceMatch | undefined>;
    metadata: SourceMetadata | undefined;
  }

  // A stored match row is only trusted while its preferredSource still matches the
  // sheet's live pick, since the sheet may have changed since download:match last ran.
  let cols: SourceCol[] = $derived(
    ADMIN_SOURCES.map((source) => ({
      id: source.id,
      label: source.label,
      levels: Object.fromEntries(
        source.levels.map((level) => [
          level,
          stats.find((s) => s.source === source.id && s.level === level),
        ]),
      ),
      matches: Object.fromEntries(
        source.levels.map((level) => [
          level,
          matches.find(
            (m) =>
              m.source === source.id &&
              m.level === level &&
              m.preferredSource === decision?.selectedSource,
          ),
        ]),
      ),
      metadata: metadata.find((m) => m.source === source.id),
    })),
  );
</script>

{#if loading}
  <p class="muted">Loading stats…</p>
{:else}
  <div class="table-scroll">
    <table style:--cols={cols.length}>
      <colgroup>
        <col class="level-col" />
        <col class="mapbox-col" />
        {#each cols as col (col.id)}
          <col />
        {/each}
      </colgroup>
      <thead>
        <tr>
          <th class="plain-cell">Level</th>
          <th class="mapbox-col"></th>
          {#each cols as col (col.id)}
            <th
              class:active-col={col.id === $selectedSource}
              class:team-pick={col.id === decision?.selectedSource}
              class:accepted={col.id === decision?.selectedSource && decision?.accepted}
            >
              <button class="source-btn" onclick={() => onSourceClick(col.id)}>
                {col.label}
                {#if col.id === decision?.selectedSource}
                  <span
                    class="team-badge"
                    class:accepted={decision?.accepted}
                    title={decision?.accepted
                      ? "Team's accepted source"
                      : "Team's selected source (not yet accepted)"}>✓</span
                  >
                {/if}
                {#if col.metadata?.validFrom}
                  <span class="source-updated">{formatDate(col.metadata.validFrom)}</span>
                {/if}
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="plain-cell">Source</td>
          <td class="mapbox-col">
            {#if mapboxBoundaries?.iso2}
              <a
                class="mapbox-link"
                href="https://demos.mapbox.com/boundaries-explorer/?country={mapboxBoundaries.iso2}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Mapbox
                <span class="iso-ref-tip"
                  >Mapbox Boundaries admin unit counts — opens the Mapbox Boundaries Explorer for this
                  country</span
                >
              </a>
            {:else}
              <span class="muted">Mapbox</span>
            {/if}
          </td>
          {#each cols as col (col.id)}
            <td class="provider-cell" class:active-col={col.id === $selectedSource}>
              {#if col.metadata?.producer}
                {col.metadata.producer}
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
          {/each}
        </tr>
        {#each LEVELS as level (level)}
          <tr>
            <td class="plain-cell">
              Adm {level}
              {#if level === 1 && iso3166?.subdivisionCount != null}
                <a
                  class="iso-ref"
                  href="https://www.iso.org/obp/ui/#iso:code:3166:{iso3166.iso2}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ISO: {iso3166.subdivisionCount}
                  <span class="iso-ref-tip"
                    >ISO 3166-2 subdivision count for this country — opens iso.org/obp</span
                  >
                </a>
              {/if}
            </td>
            <td class="mapbox-col">
              {#if mapboxBoundaries?.iso2 && mapboxBoundaries.counts[level] != null}
                <a
                  class="mapbox-cell-link"
                  href="https://demos.mapbox.com/boundaries-explorer/?country={mapboxBoundaries.iso2}&layer=adm{level}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {mapboxBoundaries.counts[level].toLocaleString()}
                </a>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            {#each cols as col (col.id)}
              <td
                class:active-col={col.id === $selectedSource}
                class:active-cell={col.id === $selectedSource && level === $selectedAdmin}
                class:team-pick={col.id === decision?.selectedSource}
              >
                {#if col.levels[level]}
                  <button
                    class="cell-btn"
                    aria-pressed={col.id === $selectedSource && level === $selectedAdmin}
                    onclick={() => onCellClick(col.id, level)}
                  >
                    <span class="unit-count"
                      >{col.levels[level]?.featureCount.toLocaleString()} units</span
                    >
                    <span
                      class="muted vertex-hint"
                      role="note"
                      onmouseenter={showTooltip}
                      onmouseleave={hideTooltip}
                      >{formatCount(col.levels[level]?.internalVertices ?? 0)} in / {formatCount(
                        col.levels[level]?.edgeVertices ?? 0,
                      )} out</span
                    >
                    <span class="match-rate"
                      >{#if col.id !== decision?.selectedSource && col.matches[level] && col.levels[level]?.featureCount}{@const total =
                          Number(col.levels[level]?.featureCount ?? 1)}{Math.round(
                          (col.matches[level].matchedCount / total) * 100,
                        )}% match ({col.matches[level].matchedCount}/{total}){/if}</span
                    >
                  </button>
                {:else}
                  <span class="muted empty-cell">—</span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if tooltipPos}
  <div
    class="tooltip"
    style:left="{tooltipPos.x}px"
    style:top="{tooltipPos.y}px"
    style:transform={tooltipPos.openBelow ? "none" : "translateY(-100%)"}
  >
    <strong>in</strong>: vertices on boundaries shared between units at this level (inner
    precision). <strong>out</strong>: vertices on the country's outer boundary — coastline /
    international border.
  </div>
{/if}

<style>
  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: calc(108px + var(--cols) * 120px);
    table-layout: fixed;
    border-collapse: collapse;
  }

  /* Level and Mapbox stay in view while the source columns scroll. */
  th:nth-child(-n + 2),
  td:nth-child(-n + 2) {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--cd-white);
  }

  th:nth-child(2),
  td:nth-child(2) {
    left: 56px;
  }

  .level-col {
    width: 56px;
  }

  .mapbox-col {
    width: 52px;
    padding: 4px 6px;
    font-size: 11px;
  }

  .mapbox-link,
  .mapbox-cell-link {
    position: relative;
    display: block;
    color: var(--cd-grey--600);
    text-decoration: none;
    white-space: nowrap;
  }

  .mapbox-link:hover,
  .mapbox-cell-link:hover {
    text-decoration: underline;
  }

  .mapbox-link:hover .iso-ref-tip {
    display: block;
  }

  th,
  td {
    text-align: left;
    padding: 0;
    font-size: 12px;
    letter-spacing: 0.01em;
    border-bottom: 1px solid var(--cd-grey--300);
    vertical-align: top;
  }

  th {
    color: var(--cd-grey--700);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 11px;
  }

  .plain-cell {
    padding: 4px 6px;
  }

  .provider-cell {
    padding: 4px 6px;
    color: var(--cd-grey--700);
    font-size: 11px;
    white-space: normal;
  }

  .muted {
    color: var(--cd-grey--600);
  }

  .vertex-hint {
    cursor: default;
    color: var(--cd-grey--700);
    font-size: 10px;
    text-align: right;
  }

  .match-rate {
    color: var(--cd-grey--700);
    font-size: 10px;
    text-align: right;
  }

  .tooltip {
    position: fixed;
    z-index: 100;
    width: 220px;
    white-space: normal;
    background: var(--cd-grey--900);
    color: var(--cd-white);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    pointer-events: none;
  }

  .source-btn,
  .cell-btn {
    display: block;
    width: 100%;
    height: 100%;
    text-align: left;
    padding: 4px 6px;
    margin: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: 3px;
  }

  .source-btn {
    font-weight: 600;
  }

  .cell-btn {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 6px;
  }

  .source-updated {
    margin-left: 4px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    color: var(--cd-grey--600);
    font-size: 10px;
  }

  .iso-ref {
    position: relative;
    display: block;
    color: var(--cd-grey--600);
    font-size: 10px;
    text-decoration: none;
  }

  .iso-ref:hover {
    text-decoration: underline;
  }

  .iso-ref-tip {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 10;
    width: 160px;
    white-space: normal;
    background: var(--cd-grey--900);
    color: var(--cd-white);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    pointer-events: none;
  }

  .iso-ref:hover .iso-ref-tip {
    display: block;
  }

  .source-btn:hover {
    background: color-mix(in srgb, var(--brand-primary) 7%, var(--cd-white));
  }

  th.active-col,
  td.provider-cell.active-col {
    background: color-mix(in srgb, var(--brand-primary) 4%, var(--cd-white));
  }


  th.team-pick {
    box-shadow: inset 0 3px 0 var(--cd-grey--500);
  }

  th.team-pick.accepted {
    box-shadow: inset 0 3px 0 var(--brand-success);
  }

  td.team-pick {
    box-shadow: inset 3px 0 0 var(--cd-grey--400);
  }

  .team-badge {
    margin-left: 3px;
    color: var(--cd-grey--600);
  }

  .team-badge.accepted {
    color: var(--brand-success);
  }

  /* The chip is drawn on the cell, which always spans its row, so every chip in a row matches. */
  td:has(.cell-btn) {
    position: relative;
  }
  td:has(.cell-btn)::before {
    content: "";
    position: absolute;
    inset: 2px;
    border: 1px solid var(--cd-grey--500);
    border-radius: 3px;
    background: var(--cd-white);
    pointer-events: none;
  }
  td:has(.cell-btn:hover)::before {
    border-color: var(--brand-primary--text);
  }
  td.active-cell::before {
    border-color: var(--brand-primary--text);
    background: var(--brand-primary--text);
  }
  .cell-btn {
    position: relative;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    padding: 6px 9px;
  }
  .cell-btn .match-rate {
    grid-column: 1 / -1;
  }
  .cell-btn .vertex-hint {
    justify-self: end;
  }
  td.active-cell .cell-btn,
  td.active-cell .cell-btn :global(*) {
    color: var(--cd-white);
  }
  .empty-cell {
    display: block;
    padding: 6px 9px;
  }
</style>
