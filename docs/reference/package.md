# package

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention.

## Behavior

- `package` MUST call `package-polygons`, `package-points`, and
  `package-lines` against the same loaded layer and the same target
  schema (or the same auto-detection, when omitted), on one shared
  connection.
- `package` MUST NOT expose a per-sub-tool step option; each sub-tool
  runs its own full pipeline.
- The browser tool MUST run on load and on every valid template change,
  debounced, with the target schema templates under Advanced options.
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
