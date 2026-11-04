# Schema Fill

Cascades every admin-hierarchy column family (code, name, or any other
`adm{n}<suffix>` column) down from its deepest non-empty level, so a row
whose real data stops at, say, admin 2 still has a usable admin 3 value
(copied down from admin 2) instead of a `NULL`. Stamps a new depth column
recording each row's real (pre-fill) depth, since that's the only way to
tell a genuine leaf row from a coarser one apart after filling. Attribute-only,
no geometry touched. Ported from topo-tools' `schema-fill`. A target
schema is optional: given one, levels and column families are matched by its
`nameField`/`codeField` naming templates; omitted, `schema-map`'s structural
level-detection engine (`schema-map/pipeline/levelColumns.ts`) infers the
same information from cardinality, containment, and embedding alone.

## Pipeline

1. **Load** (`$lib/db/loader`), loads the input layer via the shared
   loader, same as every other tool.
2. **Detect levels** (`pipeline/levels.ts`'s `detectLevels` on the explicit
   schema path, `schema-map/pipeline/levelColumns.ts`'s `detectLevelColumns`
   on the auto-detect path), regexes the target schema's `codeField` prefix
   (e.g. `adm`) against `layer_attr`'s columns to find every level `1..N`
   present, `N` being the deepest level column found (auto-detect resolves
   the same level set structurally instead). Raises if a level in that range
   has no code column of its own, or if none is found at all. Opportunistically
   includes level 0 when its own code column exists, without requiring it.
3. **Fill** (`pipeline/fill.ts`'s `runFill`), groups every `adm{n}<suffix>`
   column into families sharing a naming kind across levels (matched against
   the schema's `codeField`/`nameField` prefixes on the explicit path, or via
   `levelColumns.ts`'s `groupFamiliesByLevel` on the auto-detect path), then
   for each family pins every row to its own real depth: a column at the
   level a row's own hierarchy genuinely reaches, including a legitimate
   `NULL` there, is left untouched; only a column at a level _deeper_ than
   the row's own real depth falls back to its nearest non-`NULL` shallower
   sibling. Appends the depth column, stamped by a deepest-first `CASE` over
   the family's _pre-fill_ code columns.
4. **Export** (`pipeline/index.ts`), joins the filled attributes back onto
   `layer_01`'s untouched geometry and exports.

## Why a depth pin, not an unconditional coalesce

An unconditional `COALESCE` over every shallower level backfills _any_ `NULL`
at level `k`, including one that's a row's genuine, correctly-recorded value
because that row's own hierarchy stops exactly at `k`. That's indistinguishable,
column-by-column, from a `NULL` that only exists because the row is coarser
and level `k` was never populated for it at all. The fix is a per-row depth
pin: `CASE WHEN "adm_lvl" >= k THEN "adm{k}_name" ELSE (fallback) END`, where
`fallback` is the same deepest-first `COALESCE`-equivalent `CASE` used for the
depth column itself. A row whose own depth reaches `k` always reads its own
column verbatim, NULL or not; only a row whose own depth stops short of `k`
falls through to the fallback.

## Why the depth column reads pre-fill values

DuckDB resolves a same-named column reference in a later `SELECT` expression
against the query's `FROM` clause, not against an earlier item's alias in the
same `SELECT` list, even when that alias shares the column's own name. The
depth `CASE` expression and the fill `CASE` expression for the same column
both appear in one `SELECT`, and the depth `CASE` still sees the original
(pre-fill) value, exactly the semantic this tool needs: a row's depth
should reflect how deep its own real data went, not how deep the fill made
it look.

## No topology gate

Schema Fill only touches attribute columns, geometry passes straight through
from `layer_01`. There is nothing here for a topology check to gate: unlike
`edge-mosaic`/`edge-match`, this tool never re-clips, re-extends, or otherwise
mutates geometry.

## Where this fits in a pipeline

Intended to run after `edge-match`/`edge-mosaic`, on already-matched-and-clipped
output, the same position topo-tools' `schema-fill` occupies. Running it
on raw pre-match source data works mechanically (it only needs the code
columns to exist) but produces a depth column describing the _source_ data's
depth, not the depth of whatever downstream geometry the rest of this app's
pipeline eventually produces.
