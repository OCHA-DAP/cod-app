# 0011: Near-miss cross-group boundary edges accepted as a cosmetic, zero-cost defect

## Status

Superseded by [0054](0054-edge-clips-are-plain-with-a-final-coverage-clean.md)

## Context

Loading Edge Matcher's Burundi Zone output into QGIS's Topology Checker
surfaced 85,568 "gap" errors, scattered essentially uniformly across the
entire interior of the coverage. Investigated as a possible cheap
alternative to `ST_CoverageClean` (see
[0008](0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md)): if
these were a few genuine area defects, targeted local fixes could sidestep
the expensive global clean entirely.

Ruled out true area defects first: the same gap/overlap detection queries
`topology-cleaner/pipeline/issues.ts` uses, run natively against the output,
found **zero** enclosed-area gaps and zero overlaps at a sub-mm² threshold;
total union area matched the original input to full float64 precision.
But `ST_CoverageInvalidEdges_Agg` (10m tolerance) flagged 135,547 invalid
edge segments (~1,245 km total), vs. 469 such edges (~330m) in the original
source data — roughly 300x more edges, 3,800x more invalid length.

Root cause, confirmed via same-group vs. cross-group control pairs: each
Edge Matcher group clips its own independently-derived output against its
own parent polygon via `clipToBoundary()`'s `ST_Intersection`. Wherever a
group's own extension slightly undershoots the parent boundary at some
interior point, GEOS has no choice but to use that group's own vertex there
instead of the parent's — introducing a location-specific vertex that the
_adjacent_ group (clipping a differently-shaped extension against a
different parent polygon) has no way to agree with, even though both
groups' outputs pass through virtually the same physical point. Same-group
polygons (built from one shared dissolve pass) are vertex-identical by
construction and never show this; cross-group polygons, clipped
independently, do. This is a same-line-different-sampling defect (near-identical
geometric path, different vertex density), not a true positional offset.

Two candidate fixes were tested and ruled out as insufficient on their own:
a proactive `ST_ReducePrecision` snap on both sides (tops out at 28%
invalid-length reduction even at an unacceptably coarse 111mm grid — the
mismatch is a structural difference in vertex sampling, not sub-grid
rounding noise); and rebuilding the parent/coarse layer from one globally-
noded boundary network so every parent polygon shares literal vertex
identity with its neighbors at the source — validated as geometrically
faithful (area conserved to float64 precision) but the naive fragment-to-fid
reassignment made the layer's own invalid-edge count _worse_ (163m vs.
81.5m baseline), not better. `ST_Snap(geom, target, tolerance)` — the
function this class of fix actually wants — was merged into
`duckdb-spatial` upstream (PR #829, 2026-06-26) but isn't yet present in
either the native or WASM spatial extension build used here.

## Decision

**Accept the defect, don't chase vertex-exact compliance.** The defect has
zero measured real-world cost: total area is exactly conserved (confirmed
to float64 precision on two independent datasets), there are no true gaps
or overlaps, and the only consumers that notice are strict vertex-exact
validators (`ST_CoverageInvalidEdges_Agg`, QGIS's Topology Checker) — not a
correctness problem for GIS use. The one fix idea that could plausibly reach
zero (a canonical boundary rebuild) needs real unbuilt engineering and made
a naive first attempt _worse_; the other tested idea tops out at a 28%
reduction even at an unacceptably coarse grid. Revisit if `ST_Snap` becomes
available in the WASM spatial extension build and a user reports an actual
downstream breakage (not just a validator warning) traceable to this
defect.

## Consequences

No engineering investment in vertex-exact cross-group agreement.
Downstream, `match/pipeline/load.ts` was changed to proactively clean the
coarse/parent and fine/child input layers before matching — a cheap, real
win independent of this decision, see
[0012](0012-match-cleans-parent-and-child-inputs-on-load.md). Users of
strict topology validators (QGIS Topology Checker in particular) should
expect near-miss "gap" warnings at group boundaries despite verified-zero
real area defects.
