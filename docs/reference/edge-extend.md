# edge-extend

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `edge-extend` shares with other tools.

## Inputs

- `edge-extend` MUST read the input via the shared loader (see
  `docs/reference/shared.md`).
- `edge-extend` MUST close every notch in the loaded input (see
  `docs/reference/shared.md`) before checking it for coverage violations.
  Run from `edge-match`, it MUST skip this, since `edge-match` already
  closed the whole input's notches.
- If the loaded input has any coverage violation (an overlap or a
  mismatched shared edge), a micro-polygon or an enclosed hole, `edge-extend`
  MUST correct it via `gatedCoverageClean` before continuing; otherwise it
  MUST leave the input unmodified. Run from `edge-match`, `edge-extend` MUST skip the
  hole check, since `edge-match` already cleaned the whole input.
- Correcting a violation MAY shift any polygon's boundary, not just the
  violating one.
- `edge-extend` MUST NOT distinguish a real hole from a digitization gap at this
  stage — both are left for the boundary-extension algorithm to close.

## Extracting boundaries

- Each polygon's exterior boundary MUST be its own boundary minus the
  combined boundary of every bounding-box-overlapping neighbor. A polygon
  with no such neighbor MUST keep its full boundary.
- The neighbor-union join MUST use bounding-box predicates rather than a
  bare spatial predicate, per `docs/reference/shared.md`'s `SPATIAL_JOIN`
  rule.

## Generating points and the Voronoi diagram (retried together)

- `edge-extend` MUST generate points along each polygon's exterior boundary, as
  input to a Voronoi diagram, at a target spacing derived once per input
  (`computeEffectiveDistance`): the smaller of a fixed default and the
  file's own median real-segment length.
- A single real segment MUST NOT contribute more than a fixed cap's worth
  of interpolated points, independent of the resolved spacing.
- Points on each line MUST start at a stable per-line offset of up to one
  spacing, so the same input always gives the same points.
- Generated points MUST NOT lie on x = ±180 or y = ±90: those edges are map
  cuts, not borders.
- Generated points MUST exclude a buffered zone around every shared
  boundary endpoint, so junction vertices don't become redundant Voronoi
  generators.
- `edge-extend` MUST build a Voronoi diagram from the generated points, assign
  each cell to the polygon whose point generated it via a point-in-polygon
  join, and union cells by polygon into that polygon's extension.
- `edge-extend` MUST verify every generator point was assigned to a Voronoi
  cell and that no cell holds more than one distinct point. Either failure
  MUST raise at once, naming the spacing, with no retry.
- A spacing whose estimated point count exceeds a fixed maximum MUST be
  skipped without building its points.
- On any other failure of point generation or the Voronoi diagram, or a
  generated point count exceeding that maximum, `edge-extend` MUST retry with
  the resolved spacing doubled, up to 10 attempts, then MUST raise, reporting
  which stage and spacing last failed. When all 10 spacings are skipped, the
  error MUST say so.

## Merging

- Each polygon's final geometry MUST be its Voronoi extension minus the
  other polygons' original parts that intersect it, unioned with the part of
  its own original outside the extension. A polygon with no Voronoi cell MUST
  keep its original geometry.
- Before differencing, a polygon's Voronoi extension MUST be snapped
  (`ST_Snap`, `SNAP_TOLERANCE`) to the union of those intersecting parts, so
  near-but-not-quite-coincident seams from Voronoi cell generation don't
  cause a GEOS noding failure on the subsequent difference. A noding failure
  that survives the snap MUST propagate as a normal pipeline error.
- When the union of those two pieces throws, each fid MUST be unioned on its
  own, and a fid whose union still throws MUST be retried once with both
  pieces on `ST_ReducePrecision(geom, 1e-11)`. A retry that still
  throws MUST propagate. The number of fids unioned on the grid MUST be
  logged to the console.
- `edge-extend` MUST run the shared no-erosion guard (`docs/reference/shared.md`)
  against the merged result, before the final clean pass below, comparing
  it to the loaded-and-normalized input, and MUST treat a violation as a
  hard failure of the run.
- `edge-extend` MUST run one whole-layer `gatedCoverageClean` pass over the
  merged result, using a fixed gap-closing width, unless the caller
  explicitly requests skipping it (see `edge-match`'s per-group use).

## Outputs

- `edge-extend`'s final output SHOULD have no overlap and no gap after the
  merge stage's `gatedCoverageClean` pass; `edge-extend` MUST run an
  independent, warn-only validation sweep (overlap check, gap check, row-
  count-vs-input check) afterward and MUST log any residual defect rather
  than raising.
- `edge-extend` MUST export the final merged layer, plus its computed bounding
  box for map fit, whenever the bounds are finite.

## Configuration

- `edge-extend` MUST process exactly one input file per run.
- `edge-extend` has no user-configurable point-spacing or snapping parameter;
  the target spacing is always derived automatically (see "Generating
  points" above).
