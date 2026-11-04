# 0054: Edge clips are plain, with one final coverage clean that reports instead of raising

## Status

Accepted. Follows topo-tools' ADR 0149 (its #253). Supersedes
[0011](0011-near-miss-cross-group-edges-accepted-as-cosmetic.md), and
supersedes [0012](0012-match-cleans-parent-and-child-inputs-on-load.md) for
the overlay layer only.

## Context

topo-tools' #226 clipped Mosaic and Edge Matcher rows onto shared border
points, snapping each row to points collected from both sides of an overlay
boundary so the clipped edges matched without a final clean. Ported to the
site, the snap made rows invalid with nothing checking them before the clip.
Native GEOS tolerates that, and DuckDB-WASM's does not: on the NLD Edge
Matcher demo the clip threw `TopologyException`, and the unsnapped and
`ST_MakeValid` fallbacks threw too. topo-tools' #253 dropped the snapping:
rows clip straight to subdivided overlay tiles, one `coverage_clean` closes
the seams, `check_valid_topology` raises on what's left, and `--no-clean`
skips the clean and lists the seams as `invalid-edge` rows. It also refuses
an overlay that overlaps itself, a Mosaic input that isn't a clean coverage,
and overlapping Package and Schema Join inputs.

## Decision

The site ports #253 with two differences:

- What the final check finds is reported as `invalid-edge` and `gap` issue
  rows, not raised, in line with the site's other post-clean checks
  ([0028](0028-mosaic-warn-only-gate-covers-both-overlaps-and-gaps.md)).
  The input checks raise, as in topo-tools.
- The final clean is `gatedCoverageClean`, which skips `ST_CoverageClean`
  when nothing needs cleaning, since an unconditional clean crashed WASM
  more often.

Edge Matcher loads the overlay raw, as topo-tools does: cleaning it on load
would hide the overlap the new check is there to catch. The input is still
cleaned on load.

## Consequences

On the NLD Edge Matcher demo the site gives topo-tools' 342 rows, none
invalid, with no `invalid-edge` or `gap` rows. The site reports 7
`detached-part` and 4 `micro-polygon` rows to topo-tools' 4 `detached-part`,
from small differences in the WASM-extended geometry. Cross-group seams are
closed, not accepted as cosmetic. The clip has no snap or grid fallback, so
a WASM intersection failure there fails the run. Mosaic refuses an input
with an enclave, because a gap width of 0 counts every interior hole,
including the Baarle-Hertog enclaves in NLD (topo-tools #256). The
"Skip the final clean" option is the way through for layers too large to
clean in browser memory.
