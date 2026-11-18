<script lang="ts">
  import { base } from "$lib/utils/paths";

  let { current, iso3 }: { current: "cod-ab" | "partners"; iso3: string } = $props();

  const TABS = [
    { id: "cod-ab", label: "COD-AB", path: "explorer/" },
    { id: "partners", label: "Partners", path: "explorer/partners/" },
  ] as const;
</script>

<nav class="tabs" aria-label="Explorer views">
  {#each TABS as tab (tab.id)}
    <a
      href={`${base}${tab.path}${iso3 ? `?iso3=${iso3}` : ""}`}
      aria-current={tab.id === current ? "page" : undefined}>{tab.label}</a
    >
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin: 12px 16px 0;
    border-bottom: 1px solid var(--cd-grey--400);
  }
  a {
    padding: 0.4rem 0.8rem;
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    color: var(--cd-grey--700);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }
  a[aria-current="page"] {
    border-bottom-color: var(--brand-primary--text);
    color: var(--brand-primary--text);
  }
</style>
