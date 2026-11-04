# Mosaic

Fits an input layer that is already the finished output of an Edge Extender
run into a new or different overlay boundary, without re-running Voronoi
extension. It chains assign-one (`$lib/db/assignOne.ts`), the clip engine
(`$lib/db/clipEngine.ts` over `$lib/db/clipTiles.ts`'s overlay tiles) and
one coverage clean (`$lib/db/coverageClean.ts`'s `coverageCleanRows`), all
shared with Edge Matcher. Ported from topo-tools' `edge-mosaic` (its ADR
0149).

## Pipeline

1. **Load** (`pipeline/load.ts`): load the input and overlay layers raw,
   with no clean on either. The input must already be a clean coverage:
   `checkValidTopology` with a gap width of 0 rejects any invalid edge,
   micro-polygon or interior hole, naming the file. The overlay must not
   overlap itself (`checkNoOverlaps`).
2. **Assign** (`$lib/db/assignOne.ts`): assign-one majority vote (below).
   Requested overlay columns are joined under their own names from the
   winning overlay polygon's attribute row onto `input_layer_attr`, before
   clipping.
3. **Clip** (`$lib/db/clipEngine.ts`): `buildTiles` subdivides the winning
   overlay polygon into tiles of at most `SUBDIVIDE_MAX_VERTICES`, and
   `pairBatches` pairs each input row with the tiles its bounding box
   touches, in batches under `CLIP_PAIR_VERTEX_BUDGET`. Each row's clip is
   the union of its tile intersections. A row that clips to nothing becomes
   a `clip-empty` issue, and zero output rows fail the run. Clip-detached
   pieces are then merged or kept against the optional original layer
   (`docs/reference/shared.md`).
4. **Clean** (`coverageCleanRows`): merge micro-polygons, then one gated
   `ST_CoverageClean` over the clipped rows, closing the seams where two
   input borders cross the overlay boundary at different points. With the
   clean skipped, only the micro-polygon merge runs.
5. **Assemble issues** (`pipeline/issues.ts`): `clip-empty`, `unassigned`,
   `detached-part`, `micro-polygon`, `invalid-edge` (edges that still don't
   match after the clean), `gap` (holes inside the winning overlay polygon,
   only with the clean) and any `code-mismatch`/`code-fallback` rows, in
   one report.

## Why assign-one

Every overlay polygon's vote is the number of distinct input polygons it
overlaps, not any one input polygon's overlap area. Input polygons here are
already extended and overshoot, so a per-polygon plurality (Edge Matcher's
"Many" mode) could send a polygon that reaches deep into a neighbouring
overlay polygon to the wrong one. Counting distinct polygons lets the many
polygons that touch the real overlay outvote it. Ties go to the lower
overlay fid, and every input polygon is assigned to the winner, overlapping
it or not, as topo-tools' `assign_one` does (its ADR 0082). One that doesn't
overlap clips to nothing.

## One winning overlay polygon

topo-tools' `edge-mosaic` votes per source file and clips each file to its
own winner. The site's DropZone loads every dropped file as one dataset
(`docs/adr/0026`), so a run has one vote and one winning overlay polygon.

## Clip-detached pieces

Clipping an extended polygon can cut one of its parts into several pieces,
for example where the overlay edge crosses a thin tip. `mergeDetachedParts`
(`$lib/db/coverage.ts`) keeps each pre-clip part's largest piece on the
original footprint, and merges a piece under 1% of it into the neighbour it
shares the longest edge with, unless the original drew it that way. Mosaic
needs the optional original layer (the input before extension) for that
test, and without it only reports such pieces. See `docs/adr/0042` and
topo-tools' ADR 0120.

## Code-based assignment override

Given a `matchColumn` (same name on both layers) or an
`overlayMatchColumn`/`inputMatchColumn` pair, `assignOne` also runs an exact
code join, limited to pairs that already overlap. The code result wins
wherever one exists, even when it disagrees with the vote, and the whole
file falls back to the vote when no code matches. See `docs/adr/0029` and
`src/lib/db/codeJoin.ts`.

## Skipping the clean

The clean is one `ST_CoverageClean` over every clipped row, the most
memory-hungry step for a large layer. The "Skip the final clean" option
leaves it out, so seams stay in the output and are listed as `invalid-edge`
issues, and no gap rows are reported.

## Reported, not raised

topo-tools raises when the cleaned output still fails its topology check.
Mosaic lists what remains as `invalid-edge` and `gap` issues and still
exports, the same warn-only handling as the site's other post-clean checks
(`docs/adr/0028`, `docs/adr/0054`). The input checks do raise, as in
topo-tools.
