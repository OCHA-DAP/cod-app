<script lang="ts">
  import CountrySidebar from "$lib/explorer/components/CountrySidebar.svelte";
  import { levelWithMostUnits } from "$lib/explorer/map/admin";
  import { selectedIso3 } from "$lib/explorer/map/store";
  import { getCountries } from "$lib/explorer/parquet/countries";
  import { isPartnersView, viewFromUrl } from "$lib/explorer/urlState";
  import { base } from "$lib/utils/paths";
  import ChangeApp from "$lib/tools/change/App.svelte";
  import type { Map as MaplibreMap } from "maplibre-gl";
  import { onMount } from "svelte";
  import "$lib/explorer/tooltip.css";
  import { codAbOnHdx, LEVELS, polygonsUrl, unitCounts, type CodMetadata, type Level } from "./metadata";
  import Details from "./Details.svelte";
  import Panel from "./Panel.svelte";
  import Viewer from "./Viewer.svelte";

  let level = $state<Level>(1);
  let names = $state(new Map<string, string>());
  let map = $state.raw<MaplibreMap | undefined>();
  let hasResult = $state(false);
  let counts = $state<Record<Level, number> | null>(null);
  let meta = $state<CodMetadata | null>(null);
  // The location whose level is resolved; until then the map keeps the previous location's units.
  let resolved = $state<string | null>(null);
  // The resolved location has no admin 1 to 4 units in the global build.
  let missing = $state(false);
  let urlLevel: number | null = null;

  onMount(() => {
    if (isPartnersView(location)) {
      location.replace(`${base}explorer/partners/${location.search}${location.hash}`);
      return;
    }
    const view = viewFromUrl(location);
    urlLevel = view.level ?? null;
    if (view.iso3) selectedIso3.set(view.iso3);
    getCountries().then((c) => (names = new Map(c.map((r) => [r.iso3, r.name]))));
  });

  // A new location opens on its level with the most units, or on a valid ?level= the first time.
  $effect(() => {
    const i = $selectedIso3;
    counts = null;
    meta = null;
    if (!i) return;
    const want = urlLevel as Level;
    urlLevel = null;
    codAbOnHdx()
      .then((m) => i === $selectedIso3 && (meta = m.get(i) ?? null))
      .catch(() => {});
    const resolve = (c: Record<Level, number> | null) => {
      if (i !== $selectedIso3) return;
      counts = c;
      missing = !c || LEVELS.every((n) => c[n] === 0);
      if (c && !missing) level = LEVELS.includes(want) && c[want] > 0 ? want : levelWithMostUnits(LEVELS, (n) => c[n]);
      resolved = i;
    };
    unitCounts(i).then(resolve, () => resolve(null));
  });

  const units = $derived(
    resolved && resolved === $selectedIso3 ? { iso3: resolved, level: missing ? null : level } : null,
  );

  $effect(() => {
    if (!units?.level) return;
    const params = new URLSearchParams(location.search);
    params.delete("country");
    params.set("iso3", units.iso3);
    params.set("level", String(units.level));
    history.replaceState(history.state, "", `?${params}`);
  });

  // Version A is the location's current boundaries at the shown level.
  const presetA = $derived.by(() => {
    if (!units?.level) return null;
    const { iso3, level: n } = units;
    return {
      key: iso3,
      label: "Current",
      code: `adm${n}_pcode`,
      name: `adm${n}_name`,
      load: async () => {
        const res = await fetch(polygonsUrl(iso3, n));
        if (!res.ok) throw new Error(`Could not load the current boundaries (${res.status})`);
        return [new File([await res.blob()], `${iso3.toLowerCase()}_adm${n}_current.parquet`)];
      },
    };
  });
</script>

<div class="app-shell">
  <CountrySidebar view="cod-ab" />
  <div class="current">
    <ChangeApp {presetA} {map} bind:hasResult>
      {#snippet header()}
        {#if $selectedIso3}
          <Panel iso3={$selectedIso3} name={names.get($selectedIso3) ?? $selectedIso3} {counts} {meta} {missing} bind:level />
        {:else}
          <p class="hint">Pick a location from the list to see its current boundaries.</p>
        {/if}
      {/snippet}
      {#snippet info()}
        {#if $selectedIso3}<Details iso3={$selectedIso3} {meta} />{/if}
      {/snippet}
      {#snippet placeholder()}
        <Viewer iso3={$selectedIso3} {units} hidden={hasResult} bind:map />
      {/snippet}
    </ChangeApp>
  </div>
</div>

<style>
  .app-shell {
    display: flex;
    width: 100%;
    height: 100%;
  }
  .current {
    flex: 1;
    min-width: 0;
    height: 100%;
  }
  .hint {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid var(--cd-grey--400);
    color: var(--cd-grey--700);
    font-size: 13px;
  }
</style>
