# Package

`package` runs `package-polygons`, `package-points`, and `package-lines`
against one loaded layer in a single call, for the common case of wanting
the full cartographic bundle at once, mirroring this app's `edge-mosaic`
composite pattern. Ported from topo-tools'
`package`.

## Pipeline

On load, `pipeline/index.ts`'s `preparePackageInput` coverage-cleans
`layer_01` in place when it has gaps or invalid edges (`gatedCoverageClean`,
including the sliver-gap merge), so the clean runs once per file, not on
every template change, and copies the result to `pkg_input`. The sub-tools
merge micro-polygons into `layer_01` in place, so the app calls
`restorePackageInput` before each run. Each run, `runPackage` first calls
`pipeline/validate.ts`'s `runValidate`, which runs Schema Detect, Topology
Detect, Code Detect and Name Detect and counts each one's findings by kind
into `vd_summary`. An error row (a failed stage counts as one) stops the run
before packaging unless blocking is off. It then calls
`runPackagePolygons`, `runPackagePoints` and `runPackageLines` against that
same connection. No table names collide between the three sub-pipelines
(`pp_*`/`pkpt_*`/`pl_*` prefixes), so they run unmodified, back to back.
With Clean off, the topology check is skipped and each sub-tool takes
`checkTopology: false`, so none raises on overlaps, and Package Polygons
reports invalid edges instead of gaps (see
[`0058`](../adr/0058-package-cleans-and-validates.md)).

## UI

`App.svelte` draws the package on one map (`PackageMap.svelte`), either
polygons one level at a time or lines with point labels, and offers the
whole package (every polygon level, points and lines) as one zip. A third
view, Checks, shows the validation summary (`SummaryTable.svelte`) under a
map of the flagged units. When the checks block packaging, Checks is the
only view, with a "Package anyway" button. Clean, blocking and a minimum
level sit under Advanced options, as the `clean`, `block` and `min` URL
parameters.
