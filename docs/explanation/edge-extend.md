# Edge Extender

Extends every polygon in a layer outward to close gaps with its neighbors,
using a Voronoi diagram of points sampled along each polygon's boundary.
Fully automatic — no user-configurable parameters; point spacing is derived
from the input.

## Pipeline

1. **Clean input** (`pipeline/clean.ts`) — if `ST_CoverageInvalidEdges_Agg`
   flags any overlap/gap in the loaded input, run `ST_CoverageClean` on it
   in place first. Voronoi generation downstream assumes a clean starting
   coverage. No-op on already-clean input (see
   [`0013`](../adr/0013-clean-skips-coverageclean-when-no-defects.md)'s
   sibling gate in Topology Cleaner for why this only fires conditionally).
2. **Boundary lines** (`pipeline/lines.ts`) — extract each polygon's
   boundary, then subtract the union of its bbox-prefiltered neighbors so
   only the _non-shared_ stretch of each boundary remains (shared/touching
   edges don't need extending).
3. **Points** (`pipeline/points.ts`), decomposes the remaining boundary
   into real vertex-to-vertex segments and interpolates points along them
   at a per-file distance (see "Point spacing" below). Segments longer than
   `distance × 100` are capped independently to avoid feeding
   `ST_VoronoiDiagram` a pathologically large exactly-collinear point
   cluster (e.g. long straight desert admin lines). The per-fid
   shared-boundary zone used to exclude junction points is itself built
   from a bbox-prefiltered union of nearby buffered boundary pieces, not a
   single whole-file `ST_Union_Agg`, so it stays cheap at real-catalog
   scale, the same fix already applied to step 2's neighbor union.
4. **Voronoi** (`pipeline/voronoi.ts`), builds a Voronoi diagram over every
   sampled point, then assigns each cell back to its source polygon's fid
   by point-in-polygon join. A peripheral cell whose bbox exceeds valid
   WGS84 range is clipped to world bounds; see
   [ADR 0030](../adr/0030-voronoi-conditional-per-cell-world-bounds-clip.md).
   A cell holding several distinct points is a degenerate GEOS cell that
   would overlap its neighbours, so `checkCells` fails the run (topo-tools'
   ADR 0146). Points on each line start at a stable offset because evenly
   spaced points lined up across lines cause those cells, and points on
   ±180 or ±90 are dropped because those edges are map cuts.
5. **Merge** (`pipeline/merge.ts`), for each fid, takes its Voronoi cell
   minus nearby other fids' originals and unions it with the part of its
   own original outside the cell, so its coastline is never noded only to
   be dissolved away (topo-tools' ADR 0147). The merged result is checked against the loaded input by
   the shared no-erosion guard (`$lib/db/coverage.ts::checkNoErosion`, see
   `docs/reference/shared.md`), a hard failure rather than a warn-only
   check, before (unless the caller is Edge Matcher's per-group loop) a
   single gated `ST_CoverageClean` pass closes any residual seams in the
   assembled output.

## Point spacing

Point spacing is not user-supplied. `distance.ts`'s
`computeEffectiveDistance` derives it per file as
`min(DEFAULT_DISTANCE, naturalRes)`, where `naturalRes` is the median real
segment length — boundaries with genuinely finer detail than the default
start there instead of losing it to a coarser default. Falls back to
`DEFAULT_DISTANCE` when the input has no real segments.

`pipeline/index.ts`'s outer retry loop doubles the distance after a failed
attempt (too many points, or a Voronoi/points-stage error), up to 10
attempts, and skips a distance estimated over the point limit without
building it. Assignment and cell-check failures end the run, since a wider
spacing would hide them.

## WASM-only GEOS noding failures

Running this pipeline in the browser (DuckDB WASM) can surface a class of
GEOS robustness failure — `TopologyException: found non-noded intersection`
— that does not reproduce natively. The failures come from a Voronoi cell
drifting by single-digit millimeters to a few meters from the boundary it's
supposed to exactly coincide with, and GEOS's noding step throwing on the
resulting near-but-not-quite-coincident seam. See
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence)
for the general pattern. `merge.ts` snaps each cell to the union of the
original parts it intersects (`ST_Snap`, tolerance from `SNAP_TOLERANCE`)
before differencing, which resolves most near-coincident seams, and a
difference that still throws propagates as a pipeline error. The union
that follows can also throw in WASM where native GEOS succeeds. It then
runs fid by fid and retries only the failing fids on a 1e-11° grid, three
orders of magnitude below `SNAP_TOLERANCE`, which the final coverage-clean
pass absorbs; see
[`docs/adr/0038-extend-merge-union-grid-fallback.md`](../adr/0038-extend-merge-union-grid-fallback.md).
