# package-lines

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `package-lines` shares with other
tools.

## Inputs

- `package-lines` MUST read the input via the shared loader, then merge
  its micro-polygons (see `docs/reference/shared.md`), logging the count,
  and MUST raise if the input overlaps itself, unless called with
  `checkTopology: false` (Package with Clean off).
- `package-lines` MUST detect every admin level present, either
  structurally or via an explicit `nameField`/`codeField` pair, raising if
  no level is found.
- With auto-detection, a whole-table-constant column family sharing the
  detected levels' own naming style (e.g. `adm0_*` beside a detected
  `adm1_*`/`adm2_*`) MUST be treated as its own coarsest level.

## Boundary extraction

- `package-lines` MUST dissolve the input once, at the finest detected
  level only.
- `package-lines` MUST build shared and exterior boundaries from one noded
  line network of every unit's boundary, noded per `TILE_DEG` grid tile,
  labelling each edge by the units whose boundary lies within
  `10 * SNAP_TOLERANCE` of its midpoint: one unit makes it exterior, two
  make it shared, and more than two keep the two nearest. Units that
  overlap by a sliver or meet at a T-junction vertex off the other's
  segment MUST still produce one shared row.
- A shared-boundary row MUST be produced exactly once per pair of units
  sharing an edge, never twice. A pair whose polygons only touch at a
  point MUST produce zero shared rows.
- `package-lines` MUST produce the same output on every run of the same
  input, in any input row order.
- `package-lines` MUST dump every multi-part shared or exterior geometry
  into atomic `LineString` rows.
- Every output row MUST carry each side's identity at the row's own depth
  (the coarsest detected level for an outer edge) under
  single-letter-prefixed generic columns, `a_*` for one side and `b_*`
  for the other, one pair of columns per identity kind the detected
  levels' naming families detect (for an explicit schema, each family's
  suffix after the level number, e.g. `pcode`, `name`, `name1`, falling
  back to `code`/`name`), never a raw `fid`. There is no `boundary_type`
  column: a row is exterior exactly when every `b_*` column is `NULL`.
- `package-lines` MUST classify every shared row by the coarsest detected
  level at which its two sides' code columns first differ, into a depth
  column. An exterior row MUST take the coarsest detected level's depth
  when that level has a single unit (its outline), and one level coarser
  (`min(levels) - 1`) otherwise.
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
- `minLevel`, if given, MUST leave out every row whose depth is below it,
  and MUST raise if no level is at or above it.
