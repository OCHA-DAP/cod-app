# code-update

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `code-update` shares with other
tools, including the "Hierarchical code format and retention" section it
shares with `code-create`.

## Inputs

- `code-update` MUST accept exactly two inputs, OLD (already coded) and
  NEW (uncoded candidate), each loaded via the shared loader and coverage-
  cleaned independently (`gatedCoverageClean` on each side's own
  finest-level geometry table, also triggered by any enclosed hole).
- `code-update` MUST run automatically once OLD and NEW have both loaded,
  and rerun on every change to a valid setting; it MUST NOT require an
  explicit "Run" action. Invalid settings MUST show their error and not
  run.
- Each run MUST start from the loaded NEW attributes (a fresh `cu_b_attr`
  copy of `cu_b_layer_attr`), so rerunning with other settings never
  reads codes a prior run wrote.

## Level resolution and format detection

- `code-update` MUST resolve OLD's and NEW's own per-level code/name
  columns independently, each via the same explicit-pair-or-structural-
  fallback contract `code-create` uses: a name/code field template pair
  for OLD, a name/code field template pair for NEW, or, when a side omits
  both, structural auto-detection (`schema-map`'s
  `detectLevelColumnsOrSingle`).
- With explicit templates, level 0 MUST NOT be resolved as a level. A NEW
  level with a name column but no code column MUST be seeded from its
  names, prefixed with its parent level's code and `' > '` so same-named
  units under different parents stay apart; a name that repeats at the
  finest seeded level MUST raise.
- Structural auto-detection MUST raise when it sets any column aside as a
  supplemental coarser grouping, when a level has no code column, and
  when a level's cluster member collapses under its parent level.
- `code-update` MUST raise if OLD's and NEW's resolved level counts
  differ, before any dissolve/classify stage runs.
- On each side, a level with any null or blank code, or a code with more
  than one name value, MUST raise.
- Whenever any of `rootCode`/`delimiter`/`minWidth` is omitted,
  `code-update` MUST detect the format from OLD: with
  `detectUndelimitedFormat` over OLD's per-level code columns when the
  delimiter is given as none, or omitted and no sampled code in OLD's
  finest code column has a non-alphanumeric character; otherwise with
  `detectCodeFormat` over OLD's finest code column. Each field falls back
  to the detected value only when that field itself is omitted.
- Min width `auto` with no delimiter MUST raise, and a width list MUST
  have one entry per level.

## Dissolve

- `code-update` MUST dissolve OLD and NEW independently at every resolved
  level, always from that side's own original finest-level input table
  (never chained from a coarser level's own dissolve output): OLD grouped
  by its own already-real code column, NEW grouped by its own resolved
  (structural or explicit) raw column.

## Classify

- `code-update` MUST classify every level by reusing `change`'s own
  overlap and classify stage functions directly against that level's two
  dissolved tables, producing every `relationship_class` `change` defines:
  `unchanged`, `renamed`, `modified`, `relocated`, `split`, `merge`,
  `complex`, `created`, `removed`.
- `tauMatch`, `tauSame`, `linkByCode`, `linkByName`, and `linkMode` MUST be
  plain passthrough to `change`'s own classification engine, same names
  and defaults (`tauMatch=0.8`, `tauSame=0.98`, `linkByCode=false`,
  `linkByName=false`, `linkMode="either"`).
- The browser tool MUST classify by geometry only: it exposes `tauMatch`
  and `tauSame` and leaves `linkByCode`, `linkByName`, `linkMode` and the
  identity-linking columns at their defaults. It MUST show each level's
  classification in `change`'s map and table, one level at a time,
  without `renamed` and `relocated` filters, drawing `unchanged` units in
  the base fill as in `change` but listing them in the table under an
  `unchanged` filter that starts on, and making them hoverable and
  clickable on the map, with each NEW unit's assigned
  code as its NEW code, suffixed `(overflow)` for an `overflow` outcome
  and `(new)` for a `new` outcome on an `unchanged` or `modified` unit.
- The identity-linking code/name columns MUST be that level's own resolved
  code/name columns on each side, unless a code or name column is given
  for that side, which MUST then be compared at every level.

## Reparent

- For every level finer than the coarsest, `code-update` MUST re-derive
  each NEW unit's true current parent spatially against the immediately-
  coarser level's NEW, already-dissolved units (`assignBestOverlap`,
  per-child best overlap, shared with `edge-match`); it MUST NOT trust a stale
  embedded parent column.

## Assign (retention policy)

Applied per level, ascending, using the level's own already-re-derived
parent codes:

| `relationship_class`       | outcome                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `unchanged`, `renamed`     | code retained: `rewriteChildCode()` reattaches the OLD code's own tail onto the unit's (possibly new) parent prefix                |
| `modified`                 | without a delimiter, retained as above; with one, as `relocated`                                                                   |
| `relocated`                | new code assigned under the re-derived parent; `predecessor_code` is the one linked OLD code                                       |
| `created`                  | new code assigned; `predecessor_code` is `NULL`                                                                                    |
| `split` (1 OLD to N NEW)   | each NEW unit gets its own new code; all share one `predecessor_code`, the one OLD code                                            |
| `merge` (N OLD to 1 NEW)   | the one NEW unit gets one new code; `predecessor_code` is `NULL` on that geometry row                                              |
| `complex` (N OLD to M NEW) | each NEW unit gets its own new code, one shared next-available scope per level; `predecessor_code` is `NULL` on every geometry row |
| `removed`                  | no NEW-side output row; the OLD code is excluded from output and from this run's own next-available computation                    |

- A retained code whose rewrite differs from its OLD code (a unit moved
  under a new parent) and repeats any OLD code at the level, or an earlier
  rewrite in code order, MUST get a new code instead, with its OLD code as
  `predecessor_code` and reason `moved under a new parent where its code
is already taken, new code assigned`.
- New numbers MUST start above every code the parent's direct children
  had in OLD at this level, retired codes included, and above every code
  retained this run. No OLD code at the level is ever given to a
  different unit.
- `match_method` MUST be that one pair's own `change`-assigned value
  (`"spatial"` or `"identity"`) for a cluster spanning exactly one old/new
  pair; for a cluster spanning multiple linked pairs (`merge`, `complex`,
  or a `split`'s per-child links), every linked pair's own `match_method`
  MUST be collapsed into one value, joined with `"+"` when genuinely
  mixed.
- At a fixed width, a `'new'`-outcome row's `code_outcome` MUST be
  overwritten to `'overflow'` when its parent's total retained-plus-new
  child count at that level exceeds `10 ** width - 1`, that level's
  width; `reason` MUST be overwritten to state the overflow. `'retained'`
  rows are never flagged, and no row is flagged under `auto`.

## Outputs

- `code-update` MUST write each level's new code into the column OLD's own
  resolution named at that level, in place on `cu_b_attr`. NEW's own raw column at that level, if differently
  named, MUST be left untouched as an ordinary passthrough attribute.
- `code-update` MUST add a `predecessor_code` column, populated only for
  the finest level's own rows.
- `code-update` MUST always write a changelog, even when it would be
  empty, no geometry column: `level`, `old_code`, `old_name`, `new_code`,
  `new_name`, `relationship_class`, `cluster_id`, `match_method`,
  `code_outcome` (`retained`/`new`/`retired`/`overflow`), `reason`. A
  `merge` gives N retired rows plus 1 new row; a `complex` cluster gives
  one row per actually-linked old/new pair, never a full N×M
  cross-product; a `removed` code gives one row with `new_code=NULL`; a
  `created` code gives one row with `old_code=NULL`.
- `code-update` performs no topology hard gate of its own beyond the
  shared coverage-clean gate applied to each side's input.

## Configuration

- `code-update` MUST process exactly one OLD/NEW file pair per run.
- `linkMode` MUST be `"either"` or `"both"`.
