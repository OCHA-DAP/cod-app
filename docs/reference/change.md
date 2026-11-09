# change

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention.

`change` (route `/change`, tables/columns
prefixed `cw_`) compares two versions of a polygon layer ("Version A" = old,
"Version B" = new) and classifies each unit as `unchanged` / `renamed` /
`modified` / `relocated` / `split` / `merge` / `complex` / `created` /
`removed`.

## Inputs

- `change` MUST accept Version A and Version B independently, each in any
  format the shared loader supports (GeoJSON, GeoParquet, GeoPackage,
  Shapefile ZIP, KML, GML, GPX).
- `change` MUST run automatically once both Version A and Version B have
  loaded successfully; it MUST NOT require an explicit "Run" action beyond
  dropping both files.
- Re-dropping a file on either side MUST discard that side's prior load and
  all downstream results before reloading.

## Loading and keying

- `change` MUST reproject each side's geometry to `OGC:CRS84`, run `ST_MakeValid`,
  and force it to 2D, independently of the other side.
- `change` MUST run `gatedCoverageClean` over each side, triggered by any
  coverage violation, micro-polygon or enclosed hole.
- `change` MUST let the user pick a code column and a name column
  independently for each side, defaulting to the finest admin level's code
  and primary name column (`detectUnitColumns`), or `(none)` when no level
  is detected. Either or both MAY be left unset. Each pick MUST
  sync to `code-a`, `name-a`, `code-b` or `name-b` under `shared.md`'s
  query-parameter rules, with the detected column as the default; a
  URL value naming a column that side lacks MUST be ignored.
- `change` MUST derive a per-side keyed table (`fid`, `code`, `name`, `geom`)
  from the selected columns. A code column choice with more than one source
  column MUST be concatenated into a single value; a code or name column of
  any non-string type MUST be cast to `VARCHAR`.
- Changing a code or name column selection after a run MUST re-key that side
  and re-classify, without reloading or re-measuring overlap.

## Measuring overlap

- `change` MUST compute, for every pair of touching polygons `(a_fid, b_fid)`
  across the two sides, `shared_area`, `coverage_a` (`shared_area / area(A)`),
  `coverage_b` (`shared_area / area(B)`), and `iou`
  (`shared_area / (area(A) + area(B) - shared_area)`), using areas in an
  equal-area projection.
- `change` MUST compute overlap via exact geometric intersection; a failure
  MUST propagate to the caller rather than falling back to an
  approximation.
- An intersection piece with area below the sliver threshold
  (~1cm²) MUST be discarded before it contributes to any pair's shared area.
- `change` MUST NOT re-run overlap measurement when only classification
  thresholds or code/name column selections change; those MUST re-use the
  existing pair table.

## Classifying clusters

- `change` MUST group fids on both sides into clusters using union-find,
  where an edge exists between `a:<fid>` and `b:<fid>` whenever the pair is
  linked, either spatially or by identity.
- A spatial edge MUST be added whenever
  `max(coverage_a, coverage_b) >= tauMatch` for that pair.
- When identity linking is enabled (see Configuration), an identity edge
  MUST be added for a pair whose code and/or name values are equal on both
  sides, per the configured link mode, but only if that value is unique
  within its own side's keyed table. A `NULL` code or name value on either
  side MUST NOT count as a match.
- An identity edge MUST take priority over (pre-empt) the spatial edges for
  its two fids only if every other pair touching either fid above `tauMatch`
  is itself identity-covered on the far side. If any such neighboring pair
  lacks an identity match, `change` MUST fall through to spatial-only
  clustering for that fid.
- Every fid on both sides MUST end up in exactly one cluster, including fids
  with no edges at all (a singleton cluster of one).
- `change` MUST classify each cluster by the count of A-side members (`na`)
  and B-side members (`nb`):
  - `na=1, nb=0` → `removed`
  - `na=0, nb=1` → `created`
  - `na=1, nb=1`, linked only by identity (no spatial pass) → `relocated`
  - `na=1, nb=1`, spatial pass, `iou >= tauSame`, code/name unchanged →
    `unchanged`
  - `na=1, nb=1`, spatial pass, `iou >= tauSame`, code/name differ →
    `renamed`
  - `na=1, nb=1`, spatial pass, `iou < tauSame` → `modified`
  - `na=1, nb>1` → `split`
  - `na>1, nb=1` → `merge`
  - `na>1, nb>1` → `complex`
- `renamed` MUST NOT be produced when identity linking is disabled; in that
  mode code/name values MUST only be used for display, never for
  classification.
- Moving either threshold slider MUST re-classify from the existing pair
  table and MUST re-render the map and table, without reloading or
  re-measuring overlap.
- The map MUST draw `unchanged` units in the base input fill and MUST
  make them hoverable and clickable; the table MUST list them under an
  `unchanged` filter that starts on. The changelog download MUST include
  them.

## Outputs

- `change` MUST produce a tabular changelog with one row per classified
  pair plus one row per unmatched singleton fid, with columns `code_a`,
  `name_a`, `code_b`, `name_b`, `relationship_class`, `match_method`,
  `a_in_b` (coverage_a, 3dp), `b_in_a` (coverage_b, 3dp), `similarity`
  (iou, 3dp), `threshold_match` and `threshold_same` (both `DOUBLE`),
  `link_by_code`, `link_by_name`, `link_mode`. Rows for a singleton MUST have `NULL` in every column that
  belongs to the side the fid has no counterpart on.
- `change` MUST produce a spatial overlay layer tagging every Version-B
  unit, and every Version-A unit classed `removed`, with its cluster ID and
  relationship class. Together these MUST tile the full comparison area
  exactly once.
- `change` MUST produce an outline layer per side (geometry, fid, cluster
  ID, relationship class) for map rendering.
- `change` MUST report the comparison's bounding box, computed from the
  overlay layer, whenever that layer is non-empty.
- The tabular changelog MUST be downloadable as CSV or GeoParquet. The
  spatial overlay layer is exposed internally but MUST NOT require a
  separate download control beyond the tabular export.

## Configuration

- `tauMatch` (default `0.8`) MUST set the minimum
  `max(coverage_a, coverage_b)` for a pair to be spatially linked. Range
  `[0, 1]`.
- `tauSame` (default `0.98`) MUST set the minimum IoU for a spatially-linked
  1:1 pair to be `unchanged`/`renamed` rather than `modified`. Range
  `[0, 1]`.
- Identity linking MUST be enabled only when the user selects "Code or
  name" or "Code and name" as the matching mode, and MUST use whichever
  code/name columns are currently selected on both sides. Selecting "Code
  or name"/"Code and name" without a code or name column selected on both
  sides MUST have no linking effect on that attribute.
- `linkMode` (`either` | `both`, default `either`) MUST only be consulted
  when both a code column and a name column are selected on both sides; it
  MUST determine whether a pair needs a matching code, a matching name, or
  both, to count as an identity match.
