# Topology Cleaner

Detects overlaps and gaps in a polygon coverage and cleans them via DuckDB
spatial's `ST_CoverageClean`, with an adjustable gap-width threshold exposed
as Minimal / Thin / All / Manual modes.

## Pipeline

1. **Analyze coverage** — freeze `layer_01` into the array shape
   `ST_CoverageClean` expects (`buildInput`,
   `src/lib/db/coverageClean.ts`'s `buildCoverageCleanInput`), and cache
   whether the input has any overlaps/unmatched edges
   (`inputHasViolations`) — `layer_01` is static per load, so this is
   computed once and reused by every reclean rather than re-running
   `ST_CoverageInvalidEdges_Agg` on every slider drag.
2. **Find gaps & overlaps** (`pipeline/issues.ts`) — gap regions are the
   interior rings of the whole-coverage union, computed independent of
   `ST_CoverageClean` so detection still works even on a coverage whose
   defects would trip the cleaner itself. Overlap regions are pairwise
   intersections, bbox-prefiltered and filtered to `ST_Overlaps`/
   `ST_Contains` pairs (not `ST_Intersects`, which would also match every
   ordinary touching-edge pair in a real coverage and flood the join — see
   [`docs/explanation/performance.md`](performance.md#patterns-that-work-in-wasm)).
   Each detection query degrades to an empty, failure-flagged table on a
   GEOS overlay error rather than aborting the whole run (see
   [`0014`](../adr/0014-clean-precision-retry-removed.md) for why this no
   longer retries at reduced precision).
3. **Fix topology** — `buildClean` skips `ST_CoverageClean` entirely and
   copies `layer_01` straight through when the input already has no
   violations and no gap-fill was requested (see
   [`0013`](../adr/0013-clean-skips-coverageclean-when-no-defects.md));
   otherwise it runs `ST_CoverageClean(geoms, snap=SNAP_TOLERANCE, gap)` at
   the requested gap width.
4. **Verify export** (`pipeline/verify.ts`) — independently re-runs the same
   gap/overlap detection and an `ST_IsValid` sweep against the _exported_
   table (`tc_clean`), not just the pre-clean input, catching anything the
   clean itself might have introduced. Runs automatically after every
   clean/reclean.

## Gap-fill modes

The gap-width slider is in meters, converted to degrees in `pipeline/units.ts`
by the same fixed 111,320 m/° factor the issues table uses for max width, so a
slider value equal to a gap's displayed width fills exactly that gap. It has
four UI modes:

- **Minimal** (default) — fills only gaps at or below `SNAP_TOLERANCE`
  (floating-point-noise scale), at exactly that width. No shape heuristic.
  Matches topo-tools' own default (ADR-0033/0034 there).
- **Thin** — fills gaps shaped like a digitization sliver: a Polsby-Popper
  compactness ratio (`4·π·Area / Perimeter²`) at or below 0.3, the same
  formula and cutoff guidance ArcGIS Pro's "Polygon Sliver" check uses. The
  fill width is the widest qualifying gap's Maximum-Inscribed-Circle
  diameter plus 1% headroom, measured after notch closing, which reshapes
  gaps.
- **All** — fills every detected gap regardless of shape or width, via a
  fixed sentinel width (`GAP_MAXIMUM_WIDTH_ALL_DEG`, 360°) rather than one
  derived from the widest detected gap.
- **Manual** — the user sets the width directly.

Minimal or Thin can resolve to a width of 0 (no qualifying gaps), meaning
"fill nothing." A separate UI-only value (twice the widest detected gap,
rounded to a nice number) sizes the Manual slider's ceiling and All mode's
display estimate — it is never the actual fill width.

## Gap/overlap detection at scale

Overlap detection's join predicate deliberately excludes plain
`ST_Intersects` — at admin-boundary scale (thousands of fids, e.g. an
archipelago admin3 layer), `ST_Intersects` also matches every ordinary
touching-edge pair (the normal case for adjacent polygons in any real
coverage, not a defect), flooding the join with candidates whose
intersection is a degenerate line/point. Confirmed on the Python port
against Indonesia admin3 (7,069 fids): `ST_Intersects` matched 18,457 pairs
and the stage didn't finish in 6+ minutes natively. `ST_Overlaps` combined
with `ST_Contains` in both directions catches true interior overlaps
(including a fully-duplicated or nested polygon pair, which `ST_Overlaps`
alone would miss by OGC definition) without that flood.

## Precision retry and noise floor: removed, not ported from Edge Extender

Two safeguards that exist in Edge Extender/Edge Matcher were tried here and
then removed after direct measurement:

- A precision-reduction retry on GEOS overlay failure, which (unlike Edge
  Extender's retry) would have reduced precision on real input geometry
  itself, silently rewriting the exported result — removed, see
  [`0014`](../adr/0014-clean-precision-retry-removed.md).
- A 1cm² noise floor on detected gap/overlap area — removed after verifying
  against this app's actual WASM build that no sub-cm² floating-point
  artifacts occur, see [`0015`](../adr/0015-clean-noise-floor-removed.md).
