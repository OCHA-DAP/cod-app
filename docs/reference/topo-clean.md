# topo-clean

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `topo-clean` shares with other tools.

## Inputs

- `topo-clean` MUST read the input and reproject it via the shared loader (see
  `docs/reference/shared.md`) without correcting any topology defect first,
  so the issues stage sees the original, unmodified geometry.
- `topo-clean` MUST merge micro-polygons in the loaded input (see
  `docs/reference/shared.md`) before freezing it, listing each as a fixed
  `micro-polygon` issue.
- When any notch was detected, `topo-clean` MUST close every notch (see
  `docs/reference/shared.md`) in a copy of the loaded input before the
  micro-polygon merge, and clean that copy. The validation gate MUST still
  measure against the loaded input.
- `topo-clean` MUST freeze the loaded input into an array shape once per load
  (`buildInput`) and MUST cache whether that input has any coverage
  violation (`inputHasViolations`), reusing both across every reclean
  triggered by the gap-width slider rather than recomputing them.

## Detecting gaps and overlaps

- `topo-clean` MUST report every fully-enclosed hole in the union of all input
  polygons as a gap, regardless of its size. An open, non-enclosed inlet
  between two polygons MUST NOT be reported as a gap.
- `topo-clean` MUST report every case where two polygons' interiors genuinely
  overlap, or one fully contains the other, as an overlap, regardless of
  its size. Two polygons that only share a boundary edge MUST NOT be
  reported as an overlap.
- The overlap join MUST use a bounding-box prefilter combined with
  `ST_Overlaps`/`ST_Contains`, not a bare `ST_Intersects`, so that ordinary
  touching-edge pairs (the normal case for adjacent polygons in a real
  coverage) never enter the candidate set.
- If detecting one kind of defect fails (a GEOS overlay error), `topo-clean`
  MUST degrade that kind to an empty result and still report the other
  kind, rather than aborting the whole run. The degraded kind MUST be
  distinguishable, in the result, from a kind that genuinely found zero
  issues.
- Each issue row MUST carry a stable key, its kind (`gap` or `overlap`),
  its area, and its maximum width (`ST_MaximumInscribedCircle` diameter). A
  gap row MUST also carry a Polsby-Popper compactness ratio
  (`4·π·Area / Perimeter²`). An overlap row MUST also identify the two
  units involved. Neither MUST appear on the other kind's rows.

## Gap-fill modes

- The default mode (`minimal`) MUST fill a gap only when its maximum width
  is at or below `SNAP_TOLERANCE` (floating-point-noise scale), and MUST
  set the fill width to exactly `SNAP_TOLERANCE` — no shape heuristic.
- The `thin` mode MUST fill a gap only when its compactness ratio is at or
  below `0.3` (a digitization-sliver shape), measured after notch closing,
  and MUST set the fill width to the widest such gap's maximum width plus 1%
  headroom — just enough to
  reliably clear `ST_CoverageClean`'s internal width comparison, not enough
  to also sweep in a wider, non-thin gap.
- The `all` mode MUST consider every detected gap regardless of shape or
  width, and MUST set the fill width to a fixed sentinel
  (`GAP_MAXIMUM_WIDTH_ALL_DEG`, `360°`) guaranteed to exceed any real gap by
  construction, rather than a width derived from the widest detected gap.
- The `manual` mode MUST use the width the user supplies directly, with no
  shape filtering.
- The `manual` slider's ceiling, and `all` mode's display estimate, MAY use
  a separate UI-only value (twice the widest detected gap's maximum width,
  rounded up to a nice number, 1/2/5 × 10^k) — this value MUST NOT be used
  as the actual fill width for any mode.
- `minimal` or `thin` MAY resolve to a width of `0` when no gap qualifies,
  meaning no gap is filled.

## Fixing topology

- `topo-clean` MUST skip `ST_CoverageClean` entirely and copy the input straight
  through when the cached violations check is false and the resolved
  gap-fill width is `0`.
- Otherwise, `topo-clean` MUST run `ST_CoverageClean` exactly once, with a fixed
  snapping tolerance (`SNAP_TOLERANCE`, not GEOS's own extent-relative
  auto-default) and the resolved gap-fill width, over the frozen input
  array.
- `topo-clean` MUST NOT apply a precision-reduction retry to a `ST_CoverageClean`
  failure on real input geometry.

## Outputs

- Immediately after a real `ST_CoverageClean` call (not the skip-gate
  copy-through), `topo-clean` MUST reject the result — raising, leaving the
  previous cleaned output untouched — if any of: the output still has
  coverage violations; the output's total area falls below a floor set by
  a small baseline tolerance plus headroom sized to the total area of the
  overlaps actually detected; a polygon with no connection to any detected
  gap, overlap or notch collapses to nothing; any polygon's fixed shape is not
  a valid polygon; or the output has a gap at or below the resolved
  gap-fill width, when that width is above `0`. A polygon that was itself
  party to a gap or overlap being resolved MAY change area substantially, including losing all of
  it, without triggering rejection. This validation gate is separate from,
  and stricter than, the export check below.
- `topo-clean` MUST independently re-run gap/overlap detection, plus an
  `ST_IsValid` sweep, against the exported table itself (not just the
  pre-clean input) after every clean or reclean, and MUST report the
  result as a distinct "export check," separate from the original issues
  list and from the validation gate above. The export check MUST NOT raise
  or abort — an unfilled gap or a residual defect it finds is surfaced for
  display, not rejected.
- `topo-clean` MUST report, for every originally-detected issue, whether it
  ended up resolved in the current cleaned output: an overlap or a
  micro-polygon MUST always count as resolved; a gap MUST count as resolved
  only if no gap still open in the cleaned output overlaps it; a notch MUST
  count as resolved only if no notch between the same two units still
  intersects it in the cleaned output. A gap open in the cleaned output that
  overlaps no detected gap MUST get its own unresolved `gap` row (key
  `gap-new-N`, reason `gap opened by the fix`), replaced on every reclean, so
  the unresolved gap rows match `topo-detect` on the output.
- `topo-clean` MUST merge or drop every micro-polygon left in its output,
  including when the clean was skipped, and MUST replace the previous
  clean's output `micro-polygon` issues with this clean's on every reclean.
- `topo-clean` MUST report a collapsed-polygon count (input row count minus
  surviving cleaned row count) whenever a clean or reclean runs. A polygon
  removed by the micro-polygon merge MUST NOT count toward the validation
  gate's unrelated-collapse check.

## Configuration (UI)

- The gap-width control MUST accept meters and MUST convert them to
  degrees with the exact inverse of the factor that converts a detected
  gap's max width to meters, so every mode's resolved width in degrees
  (e.g. `minimal`'s `SNAP_TOLERANCE`) reaches `ST_CoverageClean` unchanged.
- Changing the gap-width slider MUST trigger only a reclean (`buildClean`
  - `checkFixedIssues` + export-check), reusing the cached input freeze
    and the cached issues list, never re-running gap/overlap detection.
- Opening the page with a `gap` query parameter MUST set the gap-fill mode
  before the first clean: `thin` or `all` selects that mode, a non-negative
  number selects `manual` at that width in meters, and any other value
  leaves `minimal`. The first clean MUST run at that mode and width.
- Every mode or width change MUST write the current mode to `gap` (the
  Manual width in meters, or `thin`/`all`), and MUST remove `gap` for
  `minimal`. The mode and width MUST persist when a new input is loaded.
- The gap-fill mode controls, the issues table, and the input map MUST be
  available once gap/overlap detection finishes, including when the first
  clean is rejected, so a reclean at another mode or width can retry it.
