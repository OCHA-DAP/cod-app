# Code Update

`code-update` reconciles an already-coded OLD layer against an uncoded
NEW candidate: classify what changed via `change`'s own engine, then
apply the standard changelog-driven retention policy so a unit's code
survives, gets replaced, or retires. Ported from topo-tools'
`code-update`.

## Table shape: split geometry/attribute tables, not one combined table

Every other tool in this app loads a file into a split `{prefix}layer_01`
(fid+geom) and `{prefix}layer_attr` (fid+attrs) pair, never one combined
table (`$lib/db/loader`). `code-update` resolves levels against each
side's `_layer_attr` table, then builds a joined `cu_a_input`/`cu_b_input`
table (fid+geom+attrs) ahead of the per-level dissolve loop, since dissolve
needs both geometry and the level's own code/name columns together. NEW's
side works on `cu_b_attr`, a fresh copy of `cu_b_layer_attr` per run,
since seeding and the final write both change it and a rerun has to start
from the loaded values. Final output is written onto `cu_b_attr` and
exported by joining it back against `cu_b_layer_01`, the same split-table
`tableToGeoJSON` convention every other tool uses.

## Level resolution and format detection

OLD's and NEW's own per-level code/name columns are resolved
independently, each via the explicit-pair-or-structural-fallback contract
`code-create` uses, including its refusal to guess a level in structural
mode (supplemental columns, a collapsed cluster member). With explicit
templates, level 0 is the root itself and is never recoded. A previous
release can have a names-only level with no code column to carry over, so
a NEW level with names but no codes is seeded from its names, prefixed
with its parent's code so same-named units under different parents stay
apart (py ADR 0126). A level-count mismatch between the two resolutions
raises before any dissolve or classify work starts, and so does a level
with a missing code, or a code carrying two names, on either side, since
dissolving by that code would silently merge units.

Releases keep ISO2-style codes with no delimiter (`SN0101`) until a bulk
migration to `ISO3.NNN`, so OLD may come in either format. When no
sampled code in OLD's finest level has a non-alphanumeric character (or
the delimiter is set to none), `detectUndelimitedFormat` reads the format
from OLD's per-level code columns; otherwise `detectCodeFormat` reads OLD's
finest level, which gives the richest sample for delimiter/root detection
and the per-position width mode. Each of `rootCode`/`delimiter`/`minWidth`
falls back to the detected value independently, only when that field
itself wasn't given. `auto` width needs a delimiter: without one, the
widths must match OLD's or the codes couldn't be split.

`linkByCode`/`linkByName` compare each side's own resolved code/name
column at each level by default. A code or name column given per side (a
persistent source ID shared by both releases) is compared at every level
instead, which rescues a `relocated` unit whose resolved code and name
both changed.

## Dissolve: independent per side, per level

OLD and NEW are dissolved independently at every level, always from that
side's own original `cu_{side}_input` table (never chained from a
coarser level's own dissolve output), reusing `package-polygons`'s own
`runDissolveCore`: OLD grouped by its own already-real code column, NEW
grouped by its own resolved (structural or explicit) raw column.

## Classify: reusing `change`'s stage function directly, per level

Each level's two dissolved tables are copied into the fixed table names
`change`'s own `stageClassify` expects
(`cw_a_keyed`/`cw_b_keyed`), which then runs unmodified, producing
`cw_pairs_classified` (`a_fid`, `b_fid`, `match_method`) and
`cw_polygon_class` (`side`, `fid`, `cluster_id`, `relationship_class`).
`assignLevel` reads both tables directly via SQL immediately afterward,
before the next level's `classifyLevel` call overwrites them, rather than
threading `stageClassify`'s in-memory return value through a function
chain: this mirrors Python's own per-level file-based handoff more
closely than passing a JS object would, and keeps `assignLevel` a plain
consumer of the same two tables regardless of how many levels ran before
it.

## Reparent: re-derived spatially, never trusted from an embedded column

For every level finer than the coarsest, each NEW unit's true current
parent is re-derived spatially against the immediately-coarser level's
NEW, already-dissolved units, via `assignBestOverlap` (`$lib/db`, shared
with `edge-match`'s own per-child best-overlap assignment), never read off a
raw embedded parent column. A raw parent-reference column goes stale
exactly when the coarser unit was itself split, merged, or relocated this
same version.

## Assign: one retention policy, six shapes of change funneled through two code paths

Every relationship class reduces to one of two things happening to a
unit's code: it's **retained** (rewritten under a possibly-new parent
prefix, never re-ranked) or it's **replaced** (assigned fresh through the
same batched `assignNewCodes` call `code-create` itself uses).

`unchanged` and `renamed` are retained: `rewriteChildCode` reattaches the
OLD code's own tail onto the (possibly new) parent prefix, an identical
reconstruction when the parent didn't change and a genuine prefix cascade
when it did. Strict or lenient follows the code format: without a
delimiter, a `modified` 1:1 match is retained too, since those codes keep
continuity through re-digitising rather than promising identical
geometry; with one, it gets a new code.

A unit moved under a new parent can land on a code that already exists
there. Rewrites are computed up front, and one that differs from its OLD
code and repeats any OLD code at the level, or an earlier rewrite in code
order, gets a new code instead, with its OLD code as predecessor. A code
kept as-is always wins.

Every other class (`modified`, `relocated`, `created`, `split`, `merge`,
`complex`) funnels into one shared per-level batch: every new-code
request for that level is collected into a `cu_assign_new` staging table
and assigned in one `assignNewCodes` call, seeded with this level's
retained codes plus every OLD code at the level, retired ones included.
New numbers therefore start above everything a parent ever held, so a
code retired this run (a `merge`'s old codes, a `removed` unit's own
code) is never handed to a different unit (py ADR 0126). Without a
delimiter, numbering steps below the top-10% placeholder range when it
would otherwise overflow the width (py ADR 0127, see `code.md`).

`match_method` is collapsed per cluster: a cluster spanning exactly one
old/new pair keeps that pair's own value (`"spatial"` or `"identity"`)
untouched; a cluster spanning multiple linked pairs unions every linked
pair's own method and joins with `"+"` only when genuinely mixed.

`predecessorCode` stays a scalar field: `null` for `created` and for
every retained row, the one linked OLD code for `modified`/`relocated`,
the one shared OLD code for every `split` child, and `null` again on a
`merge`/`complex` survivor's own row, since a scalar can't losslessly
hold more than one predecessor. Full N:M lineage for a `merge`/`complex`
cluster lives in the changelog instead (every retired `old_code` row
shares that cluster's own `cluster_id`).

## Outputs: writing under OLD's own column names

Each level's new code is written into the column name OLD's own
resolution used at that level, in place on `cu_b_attr`; NEW's own
raw column at that level, if differently named, is left untouched as an
ordinary passthrough attribute. `predecessor_code` is populated only for
the finest level's own rows, joined back by the raw NEW value captured
right after that level's own dissolve, before that value's own column
gets overwritten later in the per-level loop.

The changelog is always written, even when it would be empty: a
`removed` code gets one row with `new_code=null`, a `created` code gets
one row with `old_code=null`, a `merge` gives N retired rows plus one new
row, and a `complex` cluster gives one row per actually-linked old/new
pair, never a full N×M cross-product. The changelog table itself has no
`predecessor_code` column (that lineage lives only on the output layer's
own attribute table), matching Python's own changelog schema exactly.

## UI scope: `change`'s map and table, one level at a time

`code-update`'s result view is `change`'s own `ResultView`, fed one
level's classification at a time, so a level's map and table read exactly
like a `change` run between that level's OLD and NEW units. The map colors
units by relationship class and draws `unchanged` units in the base input
fill. Unlike `change`, it lists `unchanged` units in the table and lets
them be hovered and clicked, since a retained code is a result the user
needs to see next to the new and retired ones. Each NEW unit's assigned
code stands in as its NEW code in the table, which is where the
`code_outcome` result shows up.
