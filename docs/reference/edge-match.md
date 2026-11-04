# edge-match

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md`/`docs/reference/edge-extend.md` for rules `edge-match` shares
with other tools.

## Inputs

- `edge-match` MUST load the input (fine) layer and the overlay (coarse) layer
  independently via the shared loader (see `docs/reference/shared.md`).
- `edge-match` MUST close every notch in the input layer (see
  `docs/reference/shared.md`), not the overlay layer, before its
  whole-layer clean.
- `edge-match` MUST run a gated whole-layer `gatedCoverageClean` pass over
  the input layer immediately after loading, also triggered by any enclosed
  hole, at default settings (`SNAP_TOLERANCE` snap, no gap-fill), before
  assignment, since a defect between two input polygons later assigned to
  different groups is invisible to any later per-group check.
- `edge-match` MUST load the overlay layer raw, with no clean, and MUST
  raise if it overlaps itself (see `docs/reference/shared.md`,
  Coverage-topology checks).

## Assigning input polygons to overlay polygons

- `edge-match` MUST compute area-overlap pairs between every input polygon and every
  bounding-box-nearby overlay polygon, via the shared overlap measurement contract
  (`docs/reference/shared.md`).
- In assign-one mode, `edge-match` MUST assign every input polygon by
  assign-one (see `docs/reference/shared.md`, Assign-one), including an
  input polygon that does not overlap the winner.
- In per-polygon mode, `edge-match` MUST instead assign each input
  polygon to the single overlay polygon it shares the largest overlap area
  with (plurality, not necessarily more than half the input polygon's own
  area). A tie between two candidate overlay polygons for the same input
  polygon MUST be broken by the lower overlay polygon fid.
- An input polygon left without an overlay polygon (assign-one: no overlay
  polygon won; per-polygon: zero overlap with any) MUST be recorded as
  unassigned, not silently dropped and not treated as fatal to the run.
- When the opt-in passthrough flag is set (see Configuration), every
  unassigned input polygon MUST instead be tagged with a sentinel overlay polygon id and
  processed as its own group (see Per-group extension), landing in the
  output unclipped rather than only in the issues export.
- `edge-match` MAY accept a code-based assignment override, evaluated per file
  in assign-one mode and per input polygon in per-polygon mode;
  see `docs/reference/shared.md`'s "Code-based assignment override" section
  and `docs/adr/0029`. `code-mismatch`/`code-fallback` issues rows join
  `edge-match`'s existing failed-group/unassigned issues rows in the same
  report.

## Per-group extension

- `edge-match` MUST group assigned input polygons by their overlay polygon, including a group
  of exactly one input polygon, and MUST process only non-empty groups.
- For each group, `edge-match` MUST populate `edge-extend`'s pipeline with that
  group's own input polygon subset and run it unmodified (see
  `docs/reference/edge-extend.md`), with its own final `gatedCoverageClean` pass
  skipped (one whole-batch clean runs after every group, see Assembly below).
- `edge-match` MUST run the shared no-erosion guard (`docs/reference/shared.md`)
  against each group's extended result before clipping, comparing it to
  that group's own pre-extension input polygon subset, and MUST treat a violation
  as a hard failure of that group.
- `edge-match` MUST clip each group's extended result to that group's own known
  overlay polygon (an exact-boundary clip, not another extension pass)
  through the shared clip engine (see `docs/reference/shared.md`, Clip
  engine), except for the passthrough pseudo-group (see Configuration),
  which is never clipped.
- `edge-match` MUST merge or keep each clipped group's clip-detached pieces
  (see `docs/reference/shared.md`), deciding them against its own
  pre-extension input layer.
- A group whose extension or clip fails MUST be recorded as a failed group
  and skipped, without aborting the run. Every input polygon belonging to a failed
  group MUST be recorded with the overlay polygon fid and the failure reason, for
  reporting and export purposes.

## Assembly

- `edge-match` MUST join every successfully clipped group's output into one
  combined result table.
- By default, `edge-match` MUST merge micro-polygons in the combined result,
  then run one gated coverage clean over it, to close the seams between
  groups. With the clean skipped, it MUST merge micro-polygons only. Each
  merged micro-polygon MUST be added to the issues export as a
  `micro-polygon` row (see `docs/reference/shared.md`).
- Passthrough rows MUST be left out of the clean, the micro-polygon merge,
  the invalid-edge check and the gap rows, and MUST be exported unchanged.
- `edge-match` MUST NOT raise on a topology defect left in the combined
  result. Each pair of rows whose shared edges still don't match MUST be
  reported as an `invalid-edge` row.

## Outputs

- `edge-match` MUST export the assembled, clipped result, plus a separate
  combined export of every unassigned input polygon, every input polygon
  belonging to a failed group, every input polygon whose extended geometry
  clipped to empty against its overlay polygon (`kind='clip-empty'`, with
  that pre-clip geometry), every merged or kept clip-detached piece
  (`kind='detached-part'`), every merged micro-polygon
  (`kind='micro-polygon'`), every `invalid-edge` pair, and, when the clean
  ran, a `gap` row for every interior hole in the final result wider than
  `SNAP_TOLERANCE` whose interior point falls inside an overlay polygon the
  result was clipped to, each tagged with which kind it is, available
  independently of the main result export. A residual gap MUST NOT fail the
  run.
- `edge-match` MUST report, per group, whether it succeeded or failed, and MUST
  report the total count of unassigned input polygons, the total count of
  input polygons excluded via a failed group, the count clipped to empty,
  the counts of clip-detached pieces merged and kept, the count of
  residual gaps and the count of invalid-edge pairs. In assign-one mode it MUST also report
  the winning overlay polygon.
- `edge-match` MUST report the assembled result's bounding box for map fit,
  whenever the bounds are finite.
- During a run, the map MUST fit to the overlay layer, show the input
  layer from assignment onward, and highlight the overlay polygon of the
  running group. Each finished group's result MUST replace that group's
  input polygons as it completes, and the final result MUST replace the
  streamed groups. A failed group's input MUST stay visible until the run
  ends. A failure to preview a group MUST NOT fail that group.

## Configuration

- `edge-match` MUST process exactly one input file and one overlay file per run.
- `edge-match` MUST accept a mode of `auto`, `one` (assign-one) or
  `many` (per-polygon), and MUST default to `auto`.
- In `auto` mode, `edge-match` MUST run assign-one's majority vote and MUST
  switch to per-polygon when fewer than half the input polygons overlap the
  winner. It MUST report which of the two modes it ran.
- `edge-match` MAY accept a `matchColumn` name or a
  `overlayMatchColumn`/`inputMatchColumn` pair for the code-based
  assignment override. Omitting them MUST leave assignment, per-group
  extension and the final clean unaffected.
- `edge-match` MUST offer an option to skip the final clean, off by
  default.
