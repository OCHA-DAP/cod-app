# edge-mosaic

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `edge-mosaic` shares with other tools.

## Inputs

- `edge-mosaic` MUST load the input layer and the overlay layer
  independently via the shared loader, without running `gatedCoverageClean`
  or any other clean pass on either.
- `edge-mosaic` MUST raise, naming the input file, unless the input layer
  passes `checkValidTopology` with a gap width of 0: no invalid edge, no
  interior hole and no micro-polygon.
- `edge-mosaic` MUST raise if the overlay layer overlaps itself (see
  `docs/reference/shared.md`, Coverage-topology checks).
- `edge-mosaic` MUST NOT re-run Voronoi extension on any input polygon. The
  input layer is expected to be a finished Edge Extender output, though
  `edge-mosaic` never verifies this.
- `edge-mosaic` MUST process exactly one input file and one overlay file per
  run (see `docs/adr/0026`), plus at most one original layer file.

## Assigning

- `edge-mosaic` MUST assign every input polygon by assign-one (see
  `docs/reference/shared.md`, Assign-one), and MUST fail the run if no
  overlay polygon wins.

## Clipping

- `edge-mosaic` MUST clip every assigned input polygon to the winning
  overlay polygon through the shared clip engine (see
  `docs/reference/shared.md`, Clip engine).
- `edge-mosaic` MUST fail the run if the clipped result has zero rows.
- `edge-mosaic` MUST merge or keep every clip-detached piece (see
  `docs/reference/shared.md`) against the optional original layer.

## Cleaning

- By default, `edge-mosaic` MUST merge micro-polygons in the clipped result,
  then run one gated coverage clean over it.
- With the clean skipped, `edge-mosaic` MUST merge micro-polygons only.

## Outputs

- `edge-mosaic` MUST NOT raise on a topology defect left in its output.
  Each pair of rows whose shared edges still don't match MUST be reported
  as an `invalid-edge` row.
- `edge-mosaic` MUST export the cleaned layer.
- `edge-mosaic` MUST produce a combined issues report, only when it has at
  least one row, listing every input polygon that never reached the output,
  identified by its own fid (kind `unassigned` when no overlay polygon won,
  `clip-empty` when its clip came out empty), every merged or kept
  clip-detached piece (`detached-part`), every merged or dropped
  micro-polygon (`micro-polygon`), every `invalid-edge` pair, every gap
  wider than `SNAP_TOLERANCE` whose interior point falls inside the winning
  overlay polygon (`gap`, only when the clean ran), and any
  `code-mismatch`/`code-fallback` rows from a code-based assignment
  override (see `docs/reference/shared.md`).
- `edge-mosaic` MUST report the count of remaining gaps and invalid-edge
  pairs alongside the result.

## Configuration

- `edge-mosaic` MAY accept one original layer file (`original` URL param).
- `edge-mosaic` MAY accept a `matchColumn` name or an
  `overlayMatchColumn`/`inputMatchColumn` pair for the code-based
  assignment override (see `docs/adr/0029`).
- `edge-mosaic` MAY accept a list of overlay polygon attribute columns to carry into the
  output, each joined onto every output row, under its own name, from the
  single winning overlay polygon's own attribute row. A carried column whose
  name already exists on the input layer MUST raise.
- `edge-mosaic` MUST offer an option to skip the final clean, off by
  default.
