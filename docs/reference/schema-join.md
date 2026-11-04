# schema-join

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-join` shares with other tools.

## Inputs

- `schema-join` MUST load one input layer and one join layer via the shared
  loader (see `docs/reference/shared.md`), from DropZones keyed `input` and
  `join`, and MUST raise if either layer overlaps itself (see
  `docs/reference/shared.md`, Coverage-topology checks).
- `schema-join` MAY take a `nameField`/`codeField` pair (each containing a
  `{n}` placeholder), enabled with "Use naming templates". When given, the
  join layer's hierarchy columns MUST be every column in a `{n}`-numbered
  family under either template's prefix, for every level `detectLevels` finds
  on the join layer, raising under the same missing-level rules as
  `schema-fill`.
- When templates are off, `schema-join` MUST detect the join layer's
  hierarchy columns structurally (every level's identity columns from
  `schema-map`'s `detectLevelColumns`), raising if no level is detected.
- Only the join layer's hierarchy columns are copied; any other join-layer
  column MUST be ignored.

## Assignment

- `schema-join` MUST assign each input polygon to the single join polygon it
  shares the most area with (`assignBestOverlap`, per-input-polygon
  plurality, ties broken by lowest join fid), measured in EPSG:8857.
- An input polygon overlapping no join polygon MUST stay in the output, with
  every copied join column NULL.

## Joining

For each join-layer hierarchy column:

- absent from the input layer: `schema-join` MUST add it, filled from each
  input polygon's assigned join polygon;
- present on the input layer and equal (`IS NOT DISTINCT FROM`) on every
  assigned input polygon: `schema-join` MUST leave the input column as is;
- present on the input layer and different on any assigned input polygon:
  `schema-join` MUST leave the input column untouched and add the join
  layer's values under the next free numbered sibling name (`adm2_name1`,
  then `adm2_name2` if `adm2_name1` is taken on either layer).

A column whose input and join types differ MUST be compared as text.
`schema-join` MUST NOT fail on a conflicting value, and MUST NOT overwrite
any input value.

## Outputs

- `schema-join` MUST NOT modify geometry.
- The joined layer (`schema_join`, suffix `_join`) MUST keep every input
  polygon. Columns MUST follow `canonicalOrder` under the templates, or
  `adm{n}_name`/`adm{n}_code` when templates are off; rows MUST be sorted by
  the deepest level's own code column, NULLs last, then input order.
- The issues report (`schema_join_issues`, suffix `_issues`) MUST have
  columns `key`, `kind`, `unit_a`, `join_fid`, `reason`, `area_m2`, sorted by
  `unit_a` then `kind`, with one row per:
  - `no-overlap`: an input polygon overlapping no join polygon, with
    `reason`
    `input polygon overlaps no join polygon; join columns left NULL`;
  - `low-overlap`: an input polygon whose assigned join polygon covers less
    than the minimum overlap of its area, with `area_m2` set to the input
    polygon's area outside that join polygon and `reason`
    `best join polygon covers <share> of input polygon` (share to two
    decimals);
  - `value-mismatch`: an input polygon and column where the input value and
    its join polygon's value are both non-NULL and differ, with `reason`
    `<column>: input '<value>' vs join '<value>'`.
- `unit_a` MUST hold the input polygon's 1-based row number in the joined
  layer, not its source fid.
- The issues download MUST be offered only when there is at least one issue.

## Configuration

- Settings (minimum overlap, naming templates) MUST be collapsed by default,
  and MUST open when a setting is invalid.
- Minimum overlap MUST default to `0.5`; a value outside `(0, 1]` MUST block
  the join with an inline error.
- Changing the minimum overlap or the templates MUST re-run the join without
  reloading or reassigning.
- The result summary MUST appear in the table pane, above the joined-columns
  and issues tables.
- The joined-columns table MUST list every attribute column of the joined
  layer in output order, marking each as from the input layer (and whether it
  matches the join layer) or added from the join layer (naming the join-layer
  column and the number of differing polygons for a sibling), plus the
  selected polygon's values when one is selected.
