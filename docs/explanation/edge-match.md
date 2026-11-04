# Edge Matcher

Assigns a fine (input) layer to coarse (overlay) polygons, either all of it
to the one overlay polygon most input polygons overlap (assign-one, the
"One" mode and topo-tools' default) or each input polygon to the overlay
polygon it overlaps most (per-polygon, "Many"). The default "auto" mode
picks between them from the data and shows the pick on the switch, so the
user can compare the other mode on the map
([`0052`](../adr/0052-match-defaults-to-auto-mode.md)). Groups input polygons by their assigned overlay polygon, then
runs Edge Extender's pipeline independently within each group so the
group's result meets its own overlay polygon boundary exactly. Spatial by default;
an optional code-based assignment override is available (see below).

## Pipeline

1. **Load** (`pipeline/load.ts`): load both layers, close the input's
   notches, then clean the input with a gated `ST_CoverageClean` (see
   [`0012`](../adr/0012-match-cleans-parent-and-child-inputs-on-load.md)),
   since a defect between input polygons that land in different groups is
   invisible to each group's own clean. The overlay loads raw, as in
   topo-tools, and the run stops if it overlaps itself (`checkNoOverlaps`):
   an input polygon can't be clipped to two overlapping boundaries.
2. **Assign** (`pipeline/assign.ts`), in assign-one mode runs `assignOne`
   (`$lib/db/assignOne.ts`, the vote Mosaic uses, see
   `docs/explanation/edge-mosaic.md`), assigning every input polygon,
   overlapping or not, to the majority-vote winner. Auto mode runs the same vote, then
   switches to per-polygon when fewer than half the input polygons overlap
   the winner. In per-polygon mode it
   instead computes area-overlap pairs between every input polygon and
   nearby overlay polygon (`src/lib/db/overlap.ts`, shared with the Changelog
   tool) and assigns each input polygon to the overlay polygon with the
   largest shared area (plurality, not necessarily >50%). Input polygons
   left without an overlay polygon go to `ge_unassigned` instead of being
   silently dropped. With
   the opt-in passthrough toggle, those same input polygons are also inserted
   into `ge_assignment` under a sentinel `PASSTHROUGH_OVERLAY_FID` (`-1`,
   `pipeline/groups.ts`), turning them into their own pseudo-group instead
   of only being reported as excluded.
3. **Per-group extend** (`pipeline/groups.ts`), for each non-empty overlay polygon
   group (including the passthrough pseudo-group, when present), populates
   `layer_01`/`layer_attr` with that group's input polygon subset and runs Edge
   Extender's pipeline unmodified (`skipOutputClean: true`, since cleaning
   per-group here would be redundant, see
   [`0004`](../adr/0004-consolidate-coverageclean-to-single-final-call.md)).
   The extended result is checked against its own pre-extension subset by
   the shared no-erosion guard (`docs/reference/shared.md`) as a hard
   failure, then clipped against the known overlay polygon geometry by the
   shared clip engine (`src/lib/db/clipEngine.ts` over
   `src/lib/db/clipTiles.ts`'s overlay tiles, the same one Mosaic uses, as
   in topo-tools), except the passthrough group, which
   has no real overlay polygon boundary and lands in `ge_results` unclipped.
   Each clipped group's detached pieces are merged or kept against the
   whole pre-extension input (`input_layer_01`, see
   `docs/explanation/edge-mosaic.md`), accumulating rows in `ge_detached`.
   An extended input polygon whose clip comes out empty is recorded in
   `ge_clip_empty`, which in assign-one mode is every input polygon lying
   outside the winning overlay polygon. A
   failing group's input polygons are recorded in `ge_dropped` (with the overlay polygon
   fid and error message) rather than aborting the whole batch.
4. **Clean** (`pipeline/index.ts`): `coverageCleanRows` merges
   micro-polygons, then runs one gated `ST_CoverageClean` over every clipped
   row, closing the seams between groups. Passthrough rows are held out of
   the clean and every later check, since an extended orphan overlaps its
   neighbours by design and would otherwise take area from a matched row.
   Each pair of rows whose edges still don't match is then reported as an
   `invalid-edge` issue (see "Seams" below).

## Issues export

`ge_unassigned` (input polygons left without an overlay polygon), `ge_dropped` (input polygons
whose whole group's extension failed), `ge_clip_empty` (input polygons
clipped to nothing), `ge_detached` (clip-detached pieces), `ge_micro`
(merged micro-polygons), `ge_invalid` (row pairs whose edges don't match)
and the remaining gaps inside the clip targets are combined into one
`ge_issues` table, each row tagged with a `kind` (`unassigned`,
`dropped_group`, `clip-empty`, `detached-part`, `micro-polygon`,
`invalid-edge` or `gap`) and,
for dropped groups, the overlay polygon fid and the error that caused the drop. When
the passthrough toggle is on and a formerly-unassigned input polygon made it through
its pseudo-group into `ge_results`, it's also surfaced as a `passthrough`
row, so a user can see which of the reported unassigned input polygons were
actually included (unclipped) rather than dropped. This is exportable on
demand as `match_issues` and is the only way to recover the geometry of any
of these kinds, the UI's group list only shows dropped groups as status
text.

## Code-based assignment override (optional)

Given a `matchColumn` (same column name on both layers) or a
`overlayMatchColumn`/`inputMatchColumn` pair, `pipeline/assign.ts`'s
`computeAssignment` also computes an exact code join, restricted to
`(input polygon, overlay polygon)` pairs that already spatially overlap, alongside the
spatial vote above (per file in assign-one mode, per input polygon in
per-polygon mode). The code result wins whenever one exists, even on
disagreement; an input polygon whose code has no overlapping overlay match falls back
to the spatial result. Both outcomes are recorded on `ge_assignment`
(`assignment_method`, `spatial_agrees`) and surfaced as `ge_issues` rows
(`kind='code-mismatch'`/`'code-fallback'`), alongside the existing
`unassigned`/`dropped_group` kinds. Ported from topo-tools'
`core/assign`; see `docs/adr/0029` and `docs/reference/shared.md` for the
full contract, and `src/lib/db/codeJoin.ts` for the shared implementation
`edge-mosaic` also uses.

## Overlap computation

`src/lib/db/overlap.ts`'s `computeOverlapPairs` (shared with Changelog, Code
Update, and Schema Join) computes overlap via exact `ST_Intersection`, with a
per-pair snap fallback for the WASM-only GEOS robustness failure described in
[`docs/explanation/performance.md`](performance.md#wasm-geos-overlayng-floating-point-divergence).

## Seams

Each group is extended and clipped on its own, so where two groups' input
borders cross the overlay boundary at different points, the clipped rows on
either side sample that boundary with different vertices. The final clean
snaps them into one shared edge. The "Skip the final clean" option leaves
that pass out for layers too large to clean in browser memory, and the seams
are then listed as `invalid-edge` issues instead, with no gap rows. A
clean that leaves a seam behind is reported the same way rather than
failing the run; see [`0054`](../adr/0054-edge-clips-are-plain-with-a-final-coverage-clean.md).
