<script lang="ts">
  import IssueTable from "$lib/components/IssueTable.svelte";
  import type { ValidateResult } from "./pipeline/validate";

  let {
    result,
    selectedKey,
    emptyText,
    select,
  }: {
    result: ValidateResult | null;
    selectedKey: string | null;
    emptyText: string;
    select: (key: string) => void;
  } = $props();

  const total = (severity: string) =>
    result?.issues.filter((r) => r.severity === severity).reduce((n, r) => n + (r.count ?? 1), 0) ?? 0;
  const summary = $derived(
    result === null
      ? null
      : `${total("error")} errors and ${total("warn")} warnings across ${new Set(result.issues.map((r) => r.stage)).size} checks.`,
  );
</script>

<IssueTable
  issues={result?.issues ?? null}
  {selectedKey}
  {emptyText}
  {summary}
  noneText="No checks ran."
  onIssueClick={(row) => select(row.key)}
>
  {#snippet head()}
    <th class="fit">Check</th>
    <th class="fit">Count</th>
    <th class="flex">Report</th>
  {/snippet}
  {#snippet cells(row)}
    <td class="fit">{row.stage}</td>
    <td class="fit">{row.count ?? ""}</td>
    <td class="flex">
      {#if row.reason}<span class="muted">{row.reason}</span>{:else}{row.report}{/if}
    </td>
  {/snippet}
</IssueTable>
