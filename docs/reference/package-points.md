# package-points

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `package-points` shares with other
tools.

## Inputs

- `package-points` MUST read the input via the shared loader, then merge
  its micro-polygons (see `docs/reference/shared.md`), logging the count,
  and MUST raise if the input overlaps itself.
- `package-points` MUST detect every admin level present, either
  structurally or via an explicit `nameField`/`codeField` pair, raising if
  no level is found.
- With auto-detection, a whole-table-constant column family sharing the
  detected levels' own naming style (e.g. `adm0_*` beside a detected
  `adm1_*`/`adm2_*`, or a word-anchored `country_*` beside `state_*`/
  `county_*`) MUST be treated as its own coarsest (root) level, dissolved
  to a single row. Its level number MUST be its own anchor digit when that
  is coarser than every detected level, else one above the coarsest.

## Point extraction

- `package-points` MUST dissolve the input once per detected level,
  grouping by that level's own code column, then reduce each dissolved
  unit to a single point via `ST_MaximumInscribedCircle(geom).center`,
  never the centroid.
- `package-points` MUST raise if a level's dissolved row count does not
  equal that level's distinct group-by tuple count in the input, or if
  any output point is not covered by its own source polygon
  (`ST_Covers`).
- Every level's points MUST be tagged with a depth column holding that
  level's own numeric depth. An input column of the same name (e.g.
  Schema Fill's real-depth stamp) MUST be dropped and replaced.
- Every level's own identity columns, including a whole-table-constant
  root's, MUST land under one name shared across every level: the source
  file's own naming convention (e.g. `pcode`, `name`, derived by stripping
  each level's own naming anchor), or, for an explicit schema, each
  family's suffix after the level number (`pcode`, `name`, `name1`),
  falling back to `code`/`name` for a field with none (`GID_{n}`). No
  level-numbered column MUST ever appear in the output.
- `package-points` MUST raise if two identity families reduce to one
  output name, or a family reduces to an empty name or to `fid`, `geom`,
  `geometry` or the depth column, compared case-insensitively.

## Outputs

- `package-points` performs no topology hard gate; it is a derived
  cartographic layer, not a coverage layer.
- `package-points` MUST combine every level's points into one output.
  Every output row MUST carry only geometry, its own level's generic
  identity columns and the depth column. Any other input column MUST NOT
  appear in the output: metadata stays on the polygons, joined back by the
  identity columns and the depth column.

## Configuration

- `package-points` MUST process exactly one input file per run.
- `nameField`/`codeField` MUST be given together, or both omitted; when
  both are omitted, `package-points` MUST fall back to full structural
  auto-detection of every level.
- `minLevel`, if given, MUST leave out every level whose depth is below
  it, and MUST raise if no level is at or above it.
