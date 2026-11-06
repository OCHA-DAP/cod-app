<script lang="ts">
  import { selectCountry, selectSource } from "$lib/explorer/map/admin";
  import { mapStore, selectedIso3, selectedSource } from "$lib/explorer/map/store";
  import { getCountries } from "$lib/explorer/parquet/countries";
  import { getAllOfficeTypes, type OfficeType } from "$lib/explorer/parquet/officeType";
  import { getAllPlanStatus, type PlanStatus } from "$lib/explorer/parquet/planStatus";
  import { getDecisions, type Decision } from "$lib/explorer/sheet/decisions";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import ToolHeader from "$lib/components/ToolHeader.svelte";
  import { base } from "$lib/utils/paths";
  import { onMount, tick } from "svelte";
  import { get } from "svelte/store";
  import OfficeTypeBadge from "./OfficeTypeBadge.svelte";
  import RelevanceBadge from "./RelevanceBadge.svelte";

  interface Row {
    iso3: string;
    name: string;
    plan: PlanStatus | null;
    decision: Decision | null;
    officeType: OfficeType | null;
  }

  let rows: Row[] = $state([]);
  let loading = $state(true);
  let filter = $state("");
  let sortKey: "officeType" | "relevance" | "name" = $state("officeType");
  let listEl: HTMLUListElement | undefined = $state();
  let skipNextCenter = false;

  onMount(async () => {
    const [countries, plans, decisions, officeTypes] = await Promise.all([
      getCountries(),
      getAllPlanStatus(),
      getDecisions(),
      getAllOfficeTypes(),
    ]);
    rows = countries.map((c) => ({
      iso3: c.iso3,
      name: c.name,
      plan: plans.get(c.iso3) ?? null,
      decision: decisions.get(c.iso3) ?? null,
      officeType: officeTypes.get(c.iso3) ?? null,
    }));
    loading = false;
  });

  // Scrolls the selected country's row to the middle of the list whenever the
  // selection changes — covers the initial URL view load (?country= or #country=) and
  // clicking a country directly on the map. Skipped when the selection change
  // came from clicking a row in this list itself (skipNextCenter), since the
  // row is already in view and re-centering it under the user's cursor is
  // disorienting.
  $effect(() => {
    const iso3 = $selectedIso3;
    if (!iso3 || loading) return;

    if (skipNextCenter) {
      skipNextCenter = false;
      return;
    }

    tick().then(() => {
      listEl
        ?.querySelector<HTMLElement>(`[data-iso3="${iso3}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  });

  function sourceLabel(id: string): string {
    return ADMIN_SOURCES.find((s) => s.id === id)?.label ?? id;
  }

  const OFFICE_TYPE_RANK: Record<OfficeType, number> = { CO: 0, RO: 1, HAT: 2 };

  function relevanceCompare(a: Row, b: Row): number {
    const rankA = a.plan?.rank ?? 5;
    const rankB = b.plan?.rank ?? 5;
    if (rankA !== rankB) return rankA - rankB;
    const yearA = Number(a.plan?.planYear ?? -Infinity);
    const yearB = Number(b.plan?.planYear ?? -Infinity);
    if (yearA !== yearB) return yearB - yearA;
    return a.name.localeCompare(b.name);
  }

  let filtered: Row[] = $derived(
    rows.filter((r) => {
      const q = filter.trim().toLowerCase();
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.iso3.toLowerCase().includes(q);
    }),
  );

  let sorted: Row[] = $derived(
    [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "officeType") {
        const rankA = a.officeType ? OFFICE_TYPE_RANK[a.officeType] : 3;
        const rankB = b.officeType ? OFFICE_TYPE_RANK[b.officeType] : 3;
        if (rankA !== rankB) return rankA - rankB;
        return relevanceCompare(a, b);
      }
      return relevanceCompare(a, b);
    }),
  );

  function selectRow(iso3: string) {
    skipNextCenter = true;
    selectCountry(get(mapStore), iso3);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") return;
    if (e.key !== "[" && e.key !== "]") return;

    const idx = ADMIN_SOURCES.findIndex((s) => s.id === get(selectedSource));
    const next =
      e.key === "]"
        ? (idx + 1) % ADMIN_SOURCES.length
        : (idx - 1 + ADMIN_SOURCES.length) % ADMIN_SOURCES.length;
    selectSource(get(mapStore), get(selectedIso3), ADMIN_SOURCES[next].id);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<aside class="sidebar">
  <ToolHeader title="Boundaries Explorer" back={{ href: base, label: "Home" }}>
    Compare administrative boundaries from OCHA and partner agencies, country by country, and see
    which source each country uses.
  </ToolHeader>

  <div class="toolbar">
    <input type="text" placeholder="Filter by name or ISO3…" bind:value={filter} />
    <div class="field">
      <label for="sort-select">Sort by</label>
      <select id="sort-select" bind:value={sortKey}>
        <option value="officeType">OCHA office type</option>
        <option value="relevance">Humanitarian relevance</option>
        <option value="name">Country name</option>
      </select>
    </div>
  </div>

  {#if loading}
    <p class="empty">Loading countries…</p>
  {:else}
    <div class="country-row-header">
      <span class="header-label">Country or Area</span>
      <span class="header-label">ISO3</span>
      <span class="header-label tooltip"
        >Type<span class="tooltip-text">OCHA office type</span></span
      >
      <span class="header-label tooltip"
        >Plan<span class="tooltip-text">Humanitarian plan relevance</span></span
      >
      <span class="header-label tooltip"
        >Source<span class="tooltip-text">Team's selected source</span></span
      >
    </div>
    <ul class="country-list" bind:this={listEl}>
      {#each sorted as row (row.iso3)}
        <li>
          <button
            type="button"
            class="country-row"
            class:selected={row.iso3 === $selectedIso3}
            data-iso3={row.iso3}
            onclick={() => selectRow(row.iso3)}
          >
            <span class="name">{row.name}</span>
            <span class="iso3">{row.iso3}</span>
            <OfficeTypeBadge officeType={row.officeType} />
            <RelevanceBadge
              rank={row.plan?.rank ?? 5}
              planType={row.plan?.planType ?? null}
              planYear={row.plan?.planYear ?? null}
            />
            {#if row.decision?.noSourceSuitable}
              <span class="decision-source none" title="None suitable">None</span>
            {:else if row.decision?.selectedSource}
              <span class="decision-source">{sourceLabel(row.decision.selectedSource)}</span>
            {:else}
              <span class="decision-source" aria-hidden="true"></span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .sidebar {
    width: 400px;
    flex-shrink: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: white;
    border-right: 1px solid var(--cd-grey--400);
    color: var(--cd-grey--900);
    --tool-header-margin: 16px 16px 0;
  }

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border-bottom: 1px solid var(--cd-grey--400);
  }

  .toolbar input[type="text"] {
    padding: 6px 8px;
    border: 1px solid var(--brand-grey--border);
    border-radius: 4px;
    font-size: 13px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--cd-grey--700);
  }

  select {
    padding-block: 6px;
    padding-left: 8px;
    border: 1px solid var(--brand-grey--border);
    border-radius: 4px;
    font-size: 13px;
  }

  .empty {
    color: var(--cd-grey--600);
    font-size: 13px;
    padding: 16px;
  }

  .country-row-header {
    display: grid;
    grid-template-columns: 1fr 32px 28px 28px 44px;
    align-items: center;
    gap: 14px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--cd-grey--400);
  }

  .header-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--cd-grey--600);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    position: relative;
  }

  .header-label.tooltip .tooltip-text {
    visibility: hidden;
    opacity: 0;
    position: absolute;
    bottom: 125%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--cd-grey--900);
    color: var(--cd-white);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    white-space: nowrap;
    transition: opacity 0.15s;
    z-index: 10;
  }

  .header-label.tooltip:hover .tooltip-text {
    visibility: visible;
    opacity: 1;
  }

  .country-list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
  }

  .country-row {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--cd-grey--300);
    padding: 6px 16px;
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr 32px 28px 28px 44px;
    align-items: center;
    gap: 14px;
    font-family: inherit;
  }

  .country-row:hover {
    background: var(--cd-grey--300);
  }

  .country-row.selected {
    background: var(--brand-primary--lightest);
  }

  .name {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .iso3 {
    font-size: 10px;
    color: var(--cd-grey--600);
  }

  .decision-source {
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--cd-grey--800);
    font-weight: 600;
  }

  .decision-source.none {
    color: var(--cd-red--aaa);
    font-weight: 400;
    font-style: italic;
  }
</style>
