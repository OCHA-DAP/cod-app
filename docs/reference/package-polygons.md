# package-polygons

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `package-polygons` shares with other
tools.

## Inputs

- `package-polygons` MUST read the input via the shared loader (see
  `docs/reference/shared.md`), then merge its micro-polygons, and MUST
  raise if the input overlaps itself (see `docs/reference/shared.md`,
  Coverage-topology checks).
- `package-polygons` MUST detect every admin level present, either
  structurally (`schema-map`'s cardinality/containment matcher, no naming
  convention assumed, the default when a target schema is omitted) or via
  an explicit `nameField`/`codeField` pair, each containing a `{n}`
  placeholder, given together or not at all. `package-polygons` MUST
  raise if no level is found.

## Dissolving

- `package-polygons` MUST dissolve the input once per detected level
  coarser than the finest, grouping by that level's own code column. The
  finest level MUST NOT be dissolved; its output is the loaded input
  itself.
- On the auto-detect path, a level's `groupBy` MUST be restricted to the
  subset of its structurally-detected columns that also pass the
  naming-anchor identity check; a raw, unfiltered structural role hit MUST
  NOT be used as a `GROUP BY` column on its own.
- Every column belonging to a finer level MUST be excluded from a
  coarser level's own dissolve: via the explicit `codeField`, or via each
  finer level's own structurally-detected identity columns when
  auto-detecting.

## Outputs

- `package-polygons` MUST produce one output per detected level.
- `package-polygons` MUST also build an issues report per level, using
  the shared gap-only schema in `docs/reference/shared.md`. The finest
  level's own output is never dissolved, so its issues are only the
  input's `micro-polygon` rows.
- The finest level's own output MUST be the loaded input itself, not a
  separately exported file: `App.svelte` MUST NOT offer a download for it.

## Configuration

- `package-polygons` MUST process exactly one input file per run.
- `nameField`/`codeField` MUST be given together, or both omitted; when
  both are omitted, `package-polygons` MUST fall back to full structural
  auto-detection of every level.
