# schema-refactor

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `schema-refactor` shares with other tools.

## Inputs

- `schema-refactor` MUST read the input layer via the shared loader (see
  `docs/reference/shared.md`).
- `schema-refactor` MUST take a crosswalk CSV file (as written by `schema-map`,
  or a hand-edited copy of one): one row per source column with
  `source_column` and `target_column` columns.
- `schema-refactor` MUST raise an error if the crosswalk file is not a CSV
  with a `source_column` column.
- A row with a blank `source_column` (a `schema-map`-written gap-row
  placeholder) MUST be skipped, not raise.
- `schema-refactor` MUST raise an error if the crosswalk lists the same
  `source_column` more than once.
- `schema-refactor` MUST raise an error if the crosswalk's `source_column`
  set does not exactly equal the input layer's own column set, excluding
  `fid`/`geom` and any column matching `isNoiseColumn()` that the crosswalk
  doesn't list (extra columns in either direction), naming the columns present in the layer but missing
  from the crosswalk AND the columns present in the crosswalk but not in
  the layer. This catches a stale crosswalk or a crosswalk paired with the
  wrong file.
- `schema-refactor` MUST raise an error if two source columns share the same
  non-null `target_column`, or if a `target_column` collides
  (case-insensitively) with a reserved name (`fid`, `geom`, `geometry`),
  rather than letting DuckDB silently disambiguate the output column names.

## Renaming

- A source column whose `target_column` is null or empty MUST be dropped
  from the output.
- Every other source column MUST be renamed to its `target_column`.
- The geometry column MUST always pass through unchanged, regardless of
  the crosswalk, and MUST be the first output column.
- Output columns MUST follow the crosswalk's row order, after geometry.
  When a column's numbered siblings (`adm2_name1`, `adm2_name2`) don't
  follow it in numeric order, Schema Map MUST warn, without reordering.
- Output rows MUST be sorted by the deepest level's code column (NULLs
  last, then input order). With no code-template column, rows MUST keep
  input order and Schema Map MUST say so.

## Outputs

- `schema-refactor` performs no topology check at all; it only renames/drops
  columns, never touching geometry.
- `schema-refactor` MUST offer the renamed layer for download in every format
  the shared spatial export offers (see `docs/reference/shared.md`), with
  filename suffix `_mapped`.

## Configuration

- `schema-refactor` MUST process exactly one input layer and one crosswalk
  per run, either edited in Schema Map's table or loaded from a CSV.
- `schema-refactor` MUST sort rows by the same `name_field`/`code_field`
  templates `schema-map` inferred with. The templates set row order only.
