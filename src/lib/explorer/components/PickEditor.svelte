<script lang="ts">
  import {
    editDecision,
    getDecision,
    pickEdits,
    resetDecision,
    sheetDecision,
    type PickEdit,
  } from "$lib/explorer/decisions";

  interface Props {
    iso3: string;
  }

  let { iso3 }: Props = $props();

  const current = $derived(getDecision(iso3));

  function setRationale(value: string) {
    editDecision(iso3, {
      selectedSource: current?.selectedSource ?? null,
      noSourceSuitable: current?.noSourceSuitable ?? false,
      accepted: current?.accepted ?? false,
      rationale: value.replace(/\s+/g, " ").trim(),
    });
  }

  function describe(d: PickEdit | null): string {
    if (!d) return "no row";
    const id = d.noSourceSuitable ? "none" : (d.selectedSource ?? "blank");
    return `${id}, ${d.accepted ? "accepted" : "not accepted"}`;
  }
</script>

<div class="pick-editor">
  <span class="tag">Dev</span>
  <input
    class="rationale"
    type="text"
    placeholder="Rationale"
    value={current?.rationale ?? ""}
    onchange={(e) => setRationale(e.currentTarget.value)}
  />
  {#if pickEdits.has(iso3)}
    <button
      class="link"
      onclick={() => resetDecision(iso3)}
      title="Sheet: {describe(sheetDecision(iso3))}"
    >
      Reset
    </button>
  {/if}
  {#if pickEdits.size}
    <span class="edits">
      {pickEdits.size} edited:
      {#each [...pickEdits.keys()].sort() as code (code)}
        <span title="Sheet: {describe(sheetDecision(code))}">{code}</span>
      {/each}
    </span>
  {/if}
</div>

<style>
  .pick-editor {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin-bottom: 10px;
    padding: 6px 8px;
    border: 1px dashed var(--cd-grey--400);
    border-radius: 4px;
    font-size: 12px;
    color: var(--cd-grey--800);
  }

  .tag {
    font-family: var(--brand-font-mono);
    font-size: 10px;
    color: var(--cd-grey--600);
  }

  input,
  button {
    font: inherit;
  }

  .rationale {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    text-decoration: underline;
    cursor: pointer;
  }

  .edits {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--cd-grey--600);
  }
</style>
