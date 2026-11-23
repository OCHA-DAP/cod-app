<script lang="ts">
  import { base } from "$lib/utils/paths";

  let { current, iso3 }: { current: "cod-ab" | "partners"; iso3: string } = $props();

  const TABS = [
    { id: "cod-ab", label: "Current boundaries", path: "explorer/", blurb: "Each location's COD-AB from 2027 on, to download or compare with your own version" },
    { id: "partners", label: "Compare sources", path: "explorer/compare/", blurb: "Partner boundaries as they stood in 2026, side by side, and where they conflict" },
  ] as const;
  const href = (path: string) => `${base}${path}${iso3 ? `?iso3=${iso3}` : ""}`;
</script>

<nav class="cards" aria-label="Explorer views">
  {#each TABS as tab (tab.id)}
    <a href={href(tab.path)} aria-current={tab.id === current ? "page" : undefined}>
      <strong>{tab.label}</strong>
      <span>{tab.blurb}</span>
    </a>
  {/each}
</nav>

<style>
  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 16px 0;
  }
  .cards a {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    color: var(--cd-grey--800);
    text-decoration: none;
  }
  .cards a:hover:not([aria-current]) {
    border-color: var(--brand-primary--text);
  }
  .cards a[aria-current="page"] {
    border-color: var(--brand-primary--text);
    box-shadow: inset 0 0 0 1px var(--brand-primary--text);
    background: var(--brand-primary--lightest);
  }
  .cards strong {
    color: var(--brand-primary--text);
    font-size: 13px;
  }
  .cards span {
    font-size: 11px;
    line-height: 1.35;
    color: var(--cd-grey--700);
  }
</style>
