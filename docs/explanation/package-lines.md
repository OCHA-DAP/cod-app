# Package Lines

`package-lines` produces one deduplicated line network of admin
boundaries, tagged by adjacency and the coarsest admin level each segment
belongs to. A row is shared between two units when its `b_*` columns are
populated, and exterior to all of them when they're `NULL`; there is no
separate boundary-type column. A web map can style or filter
international vs. sub-national boundaries from this one layer, instead of
drawing every level's own polygon outline on top of each other. Ported
from topo-tools' `package-lines`.

## Why a noded network

Extracting each touching pair's shared boundary (`ST_Touches`, then
`ST_Intersection` of the two boundaries) misses pairs that overlap by a
sliver or meet at a T-junction vertex just off the other's segment, as an
Edge Mosaic output with its final clean skipped does at every clip seam.
Such a border came out as two exterior lines. Noding every boundary into
one line network and labelling each edge by its nearby units recovers it
(see [`0059`](../adr/0059-package-lines-builds-a-noded-boundary-network.md)).

## Pipeline (`pipeline/boundaries.ts`'s `buildBoundaries`)

1. Dissolve the input once, at the finest detected level only (via
   `package-polygons/pipeline/dissolveCore.ts`'s `runDissolveCore`); every
   coarser boundary is already contained in the finest level's own
   adjacency.
2. `nodedLines` cuts each part of every unit's `ST_Boundary` longer than
   `SUBDIVIDE_MAX_VERTICES` at its own vertices into runs of at most that
   many, sharing an end vertex, and clips each run to its 1° tiles
   (`TILE_DEG`) plus a `TILE_MARGIN_DEG` overlap, so a line cut at a tile
   edge still meets its node, then nodes each tile with
   `ST_LineMerge(ST_Union_Agg(...))`.
3. `snapEnds` moves each endpoint onto the least other endpoint within
   `10 * SNAP_TOLERANCE` and drops zero-length lines, so two border copies
   ending a rounding error apart at a junction don't form a loop.
4. Each edge, normalised with `ST_Normalize`, is labelled by the units
   whose boundary lies within the tolerance of its midpoint
   (`ST_LineInterpolatePoint(geom, 0.5)`), each unit's distance the least
   over its runs: one unit is exterior, two are
   shared, more keep the two nearest. Candidates are paired on bbox
   columns first, keeping geometry out of the join's hash table.
5. The two copies of a shared border in one tile are snapped onto each
   other (`ST_Snap`), clipped back to the exact tile, endpoint-snapped
   again, and line-merged per unit pair with an ordered `ST_Union_Agg`.
   Every aggregate after noding is ordered, so row order never changes the
   output.
6. Classify every row: a shared row's depth is the coarsest detected level
   at which its two sides' own code columns first differ (a
   whole-table-constant root never separates two units); an exterior
   row's depth is the coarsest level when that level has one unit (its
   outline), else one coarser.
7. Label each side at the row's depth with the detected levels' identity
   families (`genericNamesByFamily`, or `genericFamilies` for an explicit
   schema) under `a_*`/`b_*`, raise if any finest-level unit is absent
   from every row (`checkEveryFidPresent`), then drop `left_fid` and
   `right_fid`, and rows below `minLevel`.

`depthColumn` is checked up front against the tool's own fixed output
column names (`left_fid`, `right_fid`, `geom`), raising before any query
runs rather than letting DuckDB silently rename a duplicate.
