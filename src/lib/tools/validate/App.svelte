<script lang="ts">
  import CheckApp from "$lib/components/CheckApp.svelte";
  import { findingInfo } from "$lib/components/MapPopup.svelte";
  import { runValidate, type ValidateResult } from "$lib/tools/package/pipeline/validate";
  import SummaryTable from "$lib/tools/package/SummaryTable.svelte";
  import type { ExportSource } from "$lib/db/export";
  import type { Stage } from "$lib/tools/package/pipeline/validate";

  const REPORTS: Record<Stage, { label: string; source: ExportSource }> = {
    schema: { label: "Download Schema Issues", source: "schema_detect_issues" },
    topo: { label: "Download Topology Issues", source: "validate_topo_issues" },
    code: { label: "Download Code Issues", source: "code_detect_issues" },
    name: { label: "Download Name Issues", source: "name_detect_issues" },
  };

  function describe(result: ValidateResult, key: string) {
    const i = result.issues.find((x) => x.key === key);
    if (!i) return null;
    return findingInfo(i, [
      ["Check", i.stage],
      ["Count", i.count?.toString() ?? ""],
    ]);
  }
</script>

<CheckApp
  slug="validate"
  title="Validate"
  blurb="Run Schema Detect, Topology Detect, Code Detect and Name Detect on one layer and count each one's findings by kind, without changing anything. Code and name checks are skipped when the hierarchy levels can't be detected."
  run={runValidate}
  {describe}
  downloads={(result) => [
    { label: "Download Summary CSV", source: "validate_summary" },
    ...result.ran.map((stage) => REPORTS[stage]),
  ]}
>
  {#snippet findings({ result, emptyText, selectedKey, select })}
    <SummaryTable {result} {selectedKey} {emptyText} {select} />
  {/snippet}
</CheckApp>
