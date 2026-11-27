<script lang="ts">
  import {
    DEFAULT_HIDDEN,
    hiddenSources,
    resetSources,
    toggleSource,
  } from "$lib/explorer/hiddenSources";
  import { ADMIN_SOURCES } from "$lib/explorer/sources";
  import { dismiss } from "$lib/utils/dismiss";

  const shown = $derived(ADMIN_SOURCES.length - $hiddenSources.length);
  // The panel scrolls and would clip the menu, so it is placed fixed, above the button when there's no room below.
  let pos = $state<{ right: number; top?: number; bottom?: number } | null>(null);
  function place(e: Event) {
    const details = e.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    const r = details.querySelector("summary")!.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    pos = window.innerHeight - r.bottom > 320 ? { right, top: r.bottom + 4 } : { right, bottom: window.innerHeight - r.top + 4 };
  }
  const isDefault = $derived(
    $hiddenSources.length === DEFAULT_HIDDEN.length &&
      DEFAULT_HIDDEN.every((id) => $hiddenSources.includes(id)),
  );
</script>

<details class="filter" ontoggle={place} use:dismiss>
  <summary
    >Sources {shown}/{ADMIN_SOURCES.length}
    <span aria-hidden="true">▾</span></summary
  >
  <ul
    style:right={pos ? `${pos.right}px` : undefined}
    style:top={pos?.top != null ? `${pos.top}px` : undefined}
    style:bottom={pos?.bottom != null ? `${pos.bottom}px` : undefined}
  >
    {#each ADMIN_SOURCES as src (src.id)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={!$hiddenSources.includes(src.id)}
            onchange={() => toggleSource(src.id)}
          />
          {src.label}
        </label>
      </li>
    {/each}
    <li class="reset">
      <button disabled={isDefault} onclick={resetSources}>Reset to default</button>
    </li>
  </ul>
</details>

<style>
  .filter {
    position: relative;
    font-size: 11px;
  }
  summary {
    padding: 3px 8px;
    border: 1px solid var(--brand-grey--border);
    border-radius: 4px;
    font-size: 12px;
    color: var(--cd-grey--800);
    white-space: nowrap;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover,
  [open] summary {
    border-color: var(--brand-primary--text);
  }
  ul {
    position: fixed;
    z-index: 20;
    margin: 0;
    padding: 6px 0;
    list-style: none;
    background: var(--cd-white);
    border: 1px solid var(--cd-grey--400);
    border-radius: 4px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
    white-space: nowrap;
  }
  label {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 3px 12px;
    cursor: pointer;
  }
  .reset {
    margin-top: 4px;
    padding: 4px 12px 0;
    border-top: 1px solid var(--cd-grey--300);
  }
  .reset button {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--brand-primary--text);
    text-decoration: underline;
    cursor: pointer;
  }
  .reset button:disabled {
    color: var(--cd-grey--500);
    text-decoration: none;
    cursor: default;
  }
</style>
