# Change (Changelog)

`change` compares two versions of a polygon layer and classifies every unit
as `unchanged` / `renamed` / `modified` / `relocated` / `split` / `merge` /
`complex` / `created` / `removed`. Source lives at
`src/lib/tools/change/`, with tables/columns prefixed `cw_` from the tool's
original name, "Boundary Cross-walk".

## Pipeline

1. **Load** (`pipeline/load.ts`) — each side is loaded and normalized
   independently (`loadFile` in `$lib/db/loader.ts`: `ST_MakeValid`,
   reproject to `OGC:CRS84`, force 2D), then reduced to a keyed table
   (`fid`, `code`, `name`, `geom`) from the user's column picks.
2. **Overlap** (`$lib/db/overlap.ts`, shared with Edge Matcher) — computes
   `shared_area`/`coverage_a`/`coverage_b`/`iou` for every touching pair.
3. **Classify** (`pipeline/classify.ts`) — union-find clustering plus
   cardinality-based classification.
4. **Render** (`pipeline/render.ts`, `pipeline/table.ts`) — builds the map
   overlay layer and the table rows shown in the UI.

## Overlap computation

`$lib/db/overlap.ts` is shared with Edge Matcher, Code Update, and Schema
Join, not owned by Changelog alone. It computes overlap via exact
`ST_Intersection` in one set-based query. DuckDB-WASM's GEOS OverlayNG build
can throw "found non-noded intersection" on near-coincident,
independently-digitized boundaries, a WASM-specific floating-point bug (the
same query succeeds natively). When that happens the overlap table is
rebuilt pair by pair, and a pair that still throws is intersected after
snapping it onto the other side at `SNAP_TOLERANCE` (1e-8°). The snapped
areas match native exact areas to within ~1e-10 of the unit's area; see
[`docs/adr/0036`](../adr/0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md).

Intersection crumbs below `1e-12` deg² (~1cm²) are dropped before
they contribute to shared area — a cheap pre-filter on raw degree² area,
applied only to already-computed intersection geometry (not the whole
layer). Areas and ratios use an equal-area projection so the resulting
`coverage_a`/`coverage_b`/`iou` ratios aren't biased toward
higher-latitude units the way raw EPSG:4326 degree-area would be.

## Classification: identity + spatial union-find

`stageClassify` builds a union-find over `"a:<fid>"`/`"b:<fid>"` nodes.
Unmatched fids end up as their own singleton component. Matching runs in
two phases when identity linking (code and/or name) is enabled:

**Phase 1 — Identity.** A pair is a candidate identity match if its code
and/or name values are equal on both sides _and_ unique within each side's
own keyed table (added in commit `f844472`). Values that repeat within a
side (e.g. a placeholder like `"No_Pcode"` shared by several polygons) are
excluded — matching on a non-unique value would union every polygon sharing
it into one cluster, which is never the intent.

A candidate identity pair is only pre-unioned ahead of spatial matching
("claimed") if _every other pair connecting either fid above `tauMatch`_ is
itself identity-covered on the far side. This guard is the load-bearing part
of the algorithm:

- **Why it's needed.** Say old unit A splits into new B1 (which inherits A's
  code) and new B2 (a new code). A connects spatially above `tauMatch` to
  both B1 and B2. Without the guard, claiming A↔B1 as an identity pair would
  leave B2 stranded, showing up as a spurious `created` unit instead of a
  correct `split`. Since B2 has no identity match, not all of A's spatial
  neighbors are identity-covered, so A is _not_ claimed — Phase 2 then
  clusters A, B1, and B2 together and classifies the whole group as `split`.
- **What it enables.** When a whole region of shifted units each has a
  clean 1:1 code match to its counterpart, every spatial neighbor of every
  unit in the region _is_ identity-covered, so all of those pairs get
  claimed individually. An N:M cluster that spatial-only matching would
  otherwise lump into one `complex` blob decomposes into N separate 1:1
  pairs, each independently classified (typically `relocated` or
  `unchanged`/`modified`, since the geometry may or may not have moved).

**Phase 2 — Spatial.** Any pair not already claimed by Phase 1, with
`max(coverage_a, coverage_b) >= tauMatch`, is unioned — the original,
identity-agnostic algorithm.

Every connected component (cluster) is then classified purely by how many
A-side (`na`) and B-side (`nb`) fids it contains:

| na  | nb  | condition                                           | class       |
| --- | --- | --------------------------------------------------- | ----------- |
| 1   | 0   | —                                                   | `removed`   |
| 0   | 1   | —                                                   | `created`   |
| 1   | 1   | identity-only, no spatial `tauMatch` pass           | `relocated` |
| 1   | 1   | spatial pass, `iou >= tauSame`, code/name unchanged | `unchanged` |
| 1   | 1   | spatial pass, `iou >= tauSame`, code/name differ    | `renamed`   |
| 1   | 1   | spatial pass, `iou < tauSame`                       | `modified`  |
| 1   | >1  | —                                                   | `split`     |
| >1  | 1   | —                                                   | `merge`     |
| >1  | >1  | —                                                   | `complex`   |

`renamed` only fires when identity linking is enabled. In pure geometry
mode, code/name are never consulted for classification, only for display in
the output table (commit `7244e8a` fixed an earlier bug where a `NULL`
code/name on one side could be counted as a "change").

The algorithm runs entirely in JS on data already fetched from DuckDB
(`.toArray()` once, no query-per-pair), because it scales with feature
count, not vertex count — cheap to hold as JS `Map`/`Set` structures even
for a several-thousand-unit admin layer.

## Thresholds

- **`tauMatch`** (default `0.8`, per commit `420f2ad`) — minimum
  `max(coverage_a, coverage_b)` for a spatial union-find edge. The `max`,
  not `coverage_a` alone, is what lets a small split fragment connect to its
  parent even when the fragment is a small share of the parent's own area:
  a fragment fully contained in its parent (`coverage_b = 1.0`) clears the
  bar regardless of how small `coverage_a` is.
- **`tauSame`** (default `0.98`) — minimum IoU for a 1:1 spatially-linked
  pair to be `unchanged`/`renamed` rather than `modified`.

## Output schema

- **Tabular changelog** (`cw_changelog`, exported as `crosswalk_changelog`,
  CSV or GeoParquet): one row per classified pair, plus one row per
  unmatched singleton. Columns: `code_a`, `name_a`, `code_b`, `name_b`,
  `relationship_class`, `match_method`, `a_in_b` (coverage_a, 3dp),
  `b_in_a` (coverage_b, 3dp), `similarity` (iou, 3dp), `threshold_match`,
  `threshold_same`, `link_by_code`, `link_by_name`, `link_mode`, named as in
  topo-tools. The last five
  columns echo the run's own parameters into every row — added in commit
  `06c073a` so an identity-mode run is self-documenting from the CSV alone,
  without needing to know what the UI's sliders/toggles were set to when it
  ran.
- **Spatial overlay** (`cw_overlay_render`, exported internally as
  `crosswalk_overlay` but not wired to its own download button — the
  tabular changelog is the only user-facing export): whole units, not
  intersection slivers, since classification is per cluster and there's no
  single sub-polygon geometry to color for a cluster with more than one
  member per side. Renders every B-side unit, plus every A-side unit classed
  `removed` (gone in B, so no B polygon stands in for it). Together these
  tile the comparison area exactly once, colored by `relationship_class`.
- **Outline layers** (one per side, built from the keyed tables): geometry
  plus `fid`/`cluster_id`/`relationship_class`, used for the map's outline
  overlay and for resolving a click back to a cluster/row.

## Column auto-detection

`pipeline/columns.ts` picks a default code column and name column per side
from the finest admin level that Schema Map's `resolveLevels` finds in the
data (topo-tools' ADR 0148), so a hierarchy's unit columns win over its
parents'. A side with no detectable level starts at `(none)`. It only
supplies the _default_ selection shown in the column picker; the user can override either pick per side at any time, and
changing a selection re-keys that side and re-classifies without reloading
or re-measuring overlap.
