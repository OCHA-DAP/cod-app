# Code Create

Gives every unit of a flat, finest-level input a new hierarchical code,
numbered within its parent, or builds the code from each level's own
source codes. It is the tool for when there is no previous release to
carry codes from; `code-update` is the one for when there is. The input
needs only a hierarchy embedded as columns (the same shape
`package-polygons`/`schema-fill` expect). Ported from topo-tools'
`code-create`. Attribute-only, no geometry touched.

## Pipeline

1. **Load** (`$lib/db/loader`), loads the input layer via the shared
   loader, same as every other tool. Each run copies `layer_attr` to
   `cc_attr` and codes the copy, so a rerun starts from the source values.
2. **Resolve levels** (`pipeline/levels.ts`'s `resolveCodeLevels`), an
   explicit name/code field template pair first, and if both are omitted,
   structural auto-detection (`schema-map`'s `detectLevelColumnsOrSingle`
   + `verifyFunctionalCluster`). Each level is a `Level { code, name,
   seeded }`.
3. **Assign** (`pipeline/assign.ts`'s `assignCreateCodes`), prepares the
   source codes, then chains level to level, ascending: each level is
   numbered under its parent level's already-assigned code (or the
   literal root code, for level 1). Ranking a level's units requires that
   level's parent code to already exist, so level 2 can't be assigned
   until level 1 has produced real parent codes to group under.
4. **Issues** (`pipeline/issues.ts`'s `buildCodeIssues`), per numbered
   level at a fixed width, groups codes by their parent level's code and
   flags any parent with more children than the width holds. Always
   (re)writes the `cc_issues` table, empty when nothing overflowed.
5. **Export**, the finest-level table with every resolved level's code
   column overwritten in place.

## Structural detection never guesses a level

A skipped level would corrupt every code below it, so structural mode
stops rather than guess (py ADR 0121). It raises when detection set any
column aside as a supplemental coarser grouping, since a nesting share
can't tell a missed level (parent-local codes nest 11 to 29% by value)
from an attribute column (which nests 100%). It also raises when a
level's cluster member collapses under its parent level, the sign that a
coarser level merged into this one. Either way the fix is explicit field
templates.

## Source codes: replace, embed, copy

Under `replace` (the default), every source value is re-ranked into a
fresh integer before formatting: a raw hierarchy column (a GADM-style
`AFG.1_1`, or a plain integer with gaps) is rarely clean enough to
zero-pad directly, and nothing guarantees it's unique or gap-free across
every sibling group. `copy` does the same after keeping each source code
column in its next free numbered sibling (`adm1_pcode1`).

`embed` keeps government codes as the identifiers being published (py ADR
0122): COD-AB p-codes released in 2026 are the country's ISO2 code
followed by each level's government code, concatenated. Government codes
come either local to each level (`11`, `22`) or already containing the
parent's code (`11`, `1122`), and an existing p-code (`AF34`, `AF3404`)
has the second shape. When every source code at a level starts with its
parent's source code (or the root, at level 1) the prefix is stripped
first, so both shapes give the same p-code and existing p-codes come out
unchanged (py ADR 0125). Only some codes doing so is ambiguous and
raises. Without a delimiter, a level's codes must all be one length,
since the code couldn't be split otherwise. Integer codes (`1` to `11`,
`101` to `1105`) are zero-padded to the larger of the min width and the
widest code, which changes how they're written, not their value (py ADR
0135). Their parent's code is stripped only when every code repeats it
and the remainders share one width; otherwise they're kept whole,
since stripping `110` and `1100` under `11` would leave `0` and `00`.

A source code that is missing raises under every mode: ranking would
merge every code-less unit under a parent into one.

## Seeded levels

With explicit templates, a level with a name column but no codes (a
names-only admin2) gets codes seeded from its names, then ranked under
its parent by name, under every mode. A seeded level's numbers follow
alphabetical name order, so they shift when a sibling is added or
renamed.

## The root code and level 0

Structurally resolved levels are renumbered to a clean `1..N`, coarsest
first. A genuinely constant coarsest column (a single-country file's own
admin0 code) never becomes a level, so the root code is only the literal
parent of level 1, since no level 0 column name follows from the data.
With explicit templates, level 0 always exists: its code column holds the
root code on every row, and only levels `>= 1` are numbered.
