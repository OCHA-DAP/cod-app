<script lang="ts">
  import { devVariant } from "$lib/utils/devVariant";

  let { name, options }: { name: string; options: readonly string[] } = $props();

  const current = devVariant(name, options);

  function pick(option: string) {
    const page = new URL(location.href);
    page.searchParams.set(`variant-${name}`, option);
    location.href = page.href;
  }
</script>

{#if import.meta.env.DEV}
  <div class="dev-switcher">
    <span>{name}</span>
    {#each options as option (option)}
      <button type="button" class:active={option === current} onclick={() => pick(option)}>
        {option}
      </button>
    {/each}
  </div>
{/if}

<style>
  .dev-switcher {
    position: fixed;
    right: 8px;
    bottom: 40px;
    z-index: 1000;
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 4px 6px;
    background: #222;
    color: #fff;
    border-radius: 4px;
    font: 11px/1.2 monospace;
  }
  button {
    font: inherit;
    padding: 2px 6px;
    border: 1px solid #666;
    border-radius: 3px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  button.active {
    background: #fff;
    color: #222;
  }
</style>
