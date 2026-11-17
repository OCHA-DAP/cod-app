# package

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention.

## Behavior

- With Clean on (the default), `package` MUST coverage-clean the layer on
  load when it has gaps or invalid edges, merging sliver gaps. A failed
  clean MUST stop the load, and an out-of-memory clean MUST fail with a
  message to turn Clean off.
- Each run, `package` MUST run Schema Detect, Topology Detect, Code Detect
  and Name Detect on the loaded layer and count their findings by stage,
  kind and severity. Topology gaps MUST count as warnings and other
  topology kinds as errors. Code and name checks MUST be skipped when the
  schema check reports `levels-undetected`; with Clean off the topology
  check MUST be skipped. A failed stage MUST count as an error.
- When any count is an error and blocking is on (the default), `package`
  MUST NOT package. Otherwise it MUST call `package-polygons`,
  `package-points`, and `package-lines` against the same loaded layer and
  the same target schema (or the same auto-detection, when omitted), on
  one shared connection.
- With Clean off, the three sub-tools MUST NOT raise on overlaps, and
  `package-polygons` MUST report `invalid-edge` rows in place of gap rows.
- `package` MUST NOT expose a per-sub-tool step option; each sub-tool
  runs its own full pipeline.
- The browser tool MUST run on load and on every valid template change,
  debounced, with the target schema templates, Clean, blocking and the
  minimum level under Advanced options. Each run MUST start from the
  loaded (and cleaned) layer, not a previous run's output. A blocked run
  MUST show the checks with a "Package anyway" action, which holds until a
  setting changes. The check summary and each stage's
  report MUST be downloadable.
- The browser tool MUST show either polygons or lines with point labels,
  never both. Polygons MUST be filled one level at a time, coloring each
  unit by its parent level's unit (the coarsest level in one color).
  Lines and labels MUST be styled by depth: coarser levels darker, wider
  or larger, finer lines dashed then dotted, exterior lines in the
  coarsest level's style. Points MUST render as name labels only, centered
  on the point, coarser labels winning collisions.

## Configuration

- `package` MUST process exactly one input file per run.
- `nameField`/`codeField`, when supplied, MUST be passed through
  unchanged to all three sub-calls.
- `minLevel`, when supplied, MUST be passed through to `package-polygons`
  and `package-points`.
