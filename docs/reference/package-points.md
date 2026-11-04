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
  detected levels' own naming style, one level below the finest detected
  levels, MUST be treated as its own coarsest (root) level, dissolved to
  a single row.

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
  level's own numeric depth. `package-points` MUST raise if the requested
  depth column already exists on the input's attribute table.
- Every level's own identity columns, including an injected root's, MUST
  land under one name shared across every level: the source file's own
  naming convention, or an explicit schema's fixed `code`/`name`. No
  level-numbered column MUST ever appear in the output.
- A column that cannot generalize to every level combined into the output
  (a finer level's own identity column, or an attribute that would only
  ever be `NULL` on a coarser level's rows) MUST be excluded from the
  combined output entirely, never carried through as an always-`NULL`
  column. The root level (if injected) is exempt from this exclusion, since
  it has nothing coarser to compare against.

## Outputs

- `package-points` performs no topology hard gate; it is a derived
  cartographic layer, not a coverage layer.
- `package-points` MUST combine every level's points into one output.

## Configuration

- `package-points` MUST process exactly one input file per run.
- `nameField`/`codeField` MUST be given together, or both omitted; when
  both are omitted, `package-points` MUST fall back to full structural
  auto-detection of every level.
