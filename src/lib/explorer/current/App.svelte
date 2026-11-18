<script lang="ts">
  import CountrySidebar from "$lib/explorer/components/CountrySidebar.svelte";
  import { selectedIso3 } from "$lib/explorer/map/store";
  import { getCountries } from "$lib/explorer/parquet/countries";
  import { viewFromUrl } from "$lib/explorer/urlState";
  import ChangeApp from "$lib/tools/change/App.svelte";
  import { onMount } from "svelte";
  import "$lib/explorer/tooltip.css";
  import { LEVELS, polygonsUrl, type Level } from "./metadata";
  import Panel from "./Panel.svelte";
  import Viewer from "./Viewer.svelte";

  let level = $state<Level>(1);
  let names = $state(new Map<string, string>());

  onMount(() => {
    const view = viewFromUrl(location);
    if (LEVELS.includes(view.level as Level)) level = view.level as Level;
    if (view.iso3) selectedIso3.set(view.iso3);
    getCountries().then((c) => (names = new Map(c.map((r) => [r.iso3, r.name]))));
  });

  $effect(() => {
    const iso3 = $selectedIso3;
    if (iso3) history.replaceState(history.state, "", `?iso3=${iso3}&level=${level}`);
  });

  // Version A is the location's current boundaries at the shown level.
  const presetA = $derived.by(() => {
    const iso3 = $selectedIso3;
    const n = level;
    if (!iso3) return null;
    return {
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
    <ChangeApp {presetA} downloads={false}>
      {#snippet header()}
        {#if $selectedIso3}
          <Panel iso3={$selectedIso3} name={names.get($selectedIso3) ?? $selectedIso3} bind:level />
        {:else}
          <p class="hint">Pick a location from the list to see its current boundaries.</p>
        {/if}
      {/snippet}
      {#snippet placeholder()}
        <Viewer iso3={$selectedIso3} {level} />
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
    color: var(--cd-grey--700);
    font-size: 13px;
  }
</style>
