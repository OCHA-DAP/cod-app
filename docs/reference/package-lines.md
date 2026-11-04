# package-lines

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `package-lines` shares with other
tools.

## Inputs

- `package-lines` MUST read the input via the shared loader, then merge
  its micro-polygons (see `docs/reference/shared.md`), logging the count,
  and MUST raise if the input overlaps itself.
- `package-lines` MUST detect every admin level present, either
  structurally or via an explicit `nameField`/`codeField` pair, raising if
  no level is found.

## Boundary extraction

- `package-lines` MUST dissolve the input once, at the finest detected
  level only.
- `package-lines` MUST derive each pair of touching units' shared
  boundary from `ST_Boundary` and `ST_Intersection`, never a
  PostGIS-style shared-paths function (not available in this DuckDB
  spatial build; see `docs/adr/0032`), and MUST merge the result with
  `ST_LineMerge` before dumping to atomic rows.
- A shared-boundary row MUST be produced exactly once per touching pair,
  never twice. A pair whose polygons only touch at a point MUST produce
  zero shared rows.
- `package-lines` MUST dump every multi-part shared or exterior geometry
  into atomic `LineString` rows.
- Every output row MUST carry each side's own finest-level identity under
  single-letter-prefixed generic columns, `a_*` for one side and `b_*`
  for the other, one pair of columns per identity kind the finest level's
  own naming family detects, never a raw `fid`. There is no
  `boundary_type` column: a row is exterior exactly when every `b_*`
  column is `NULL`, never shared.
- `package-lines` MUST classify every shared row by the coarsest detected
  level at which its two sides' code columns first differ, and every
  exterior row one level coarser than the coarsest detected level
  (`min(levels) - 1`), into a depth column.
- `package-lines` MUST raise if any finest-level unit is absent from
  every output row.
- `package-lines` MUST raise if the requested depth column collides with
  one of its own fixed output column names (`left_fid`, `right_fid`,
  `geom`), checked before any query runs.

## Outputs

- `package-lines` performs no topology hard gate; it is a derived
  cartographic layer, not a coverage layer.
- `package-lines` MUST combine shared and exterior rows from every level
  into one output, deduplicated so no boundary segment repeats.

## Configuration

- `package-lines` MUST process exactly one input file per run.
- `nameField`/`codeField` MUST be given together, or both omitted; when
  both are omitted, `package-lines` MUST fall back to full structural
  auto-detection of every level.
