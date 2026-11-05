# code-create

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention, and
`docs/reference/shared.md` for rules `code-create` shares with other
tools, including the "Hierarchical code format and retention" section it
shares with `code-update`.

## Inputs

- `code-create` MUST accept exactly one input, loaded via the shared
  loader. It performs no topology gate and never touches geometry, only
  attribute columns.
- Each run MUST start from the loaded attributes (a fresh `cc_attr` copy
  of `layer_attr`), so rerunning with other settings never codes
  already-coded values.

## Level resolution

- `code-create` MUST resolve each level's own code column either via an
  explicit name/code field template pair (each containing a `{n}`
  placeholder, given together or not at all, raising if only one is given),
  or, when both are omitted, via structural auto-detection
  (`schema-map`'s `detectLevelColumnsOrSingle`, cardinality/containment
  only, no naming convention assumed).
- With explicit templates, a level `1..N` MUST resolve when it has a code
  column or a name column. A level `>= 1` whose code column is missing or
  entirely blank is seeded from its names (see Assignment). Level 0
  resolves only when its own code column exists.
- Structural auto-detection MUST raise when it finds zero levels, when
  detection sets any column aside as a supplemental coarser grouping
  (naming the columns), when any level has no existing code column, and
  when a level's cluster member collapses under its parent level
  (`verifyFunctionalCluster` with the parent's code column).
- Structurally resolved levels MUST be renumbered to a clean, relative
  `1..N` sequence, coarsest first; a genuinely constant coarsest column is
  dropped before reaching this step and never becomes a level.

## Assignment

- Min width MUST be a width list only when it has exactly one entry per
  numbered level, else raise.
- Every resolved code column MUST be cast to text, with blank values
  turned into nulls. A non-seeded level `>= 1` with any null source code
  MUST raise, naming the level and the row count.
- With source codes `copy`, each non-seeded level's source code column
  MUST be copied to its next free numbered sibling (`adm1_pcode1`), placed
  right after it, before any code is assigned. Level 0 gets a sibling only
  when level 1 does.
- A seeded level MUST have its code column filled from its name column,
  raising when there is no name column. A new code column MUST go right
  after its level's name columns. At the finest level, a name that repeats
  under one parent MUST raise.
- With explicit templates, level 0's code column MUST hold the root code on
  every row, added after level 0's name column (else after level 1's
  columns) when missing. Structural detection MUST NOT add a level 0 column.
- With source codes `replace` or `copy`, for each level `1..N`,
  ascending, `code-create` MUST rank that level's distinct source values
  under their parent level's assigned code (or the root code, for level
  1), sorted by source value, and overwrite the column with a fresh,
  sequential, zero-padded code (`assignNewCodes`, see
  `docs/reference/shared.md`).
- With source codes `embed`, each non-seeded level's code MUST be its
  parent's code, then the delimiter, then its own source value. When
  every source code at a level starts with its parent's source code (or
  the root code, at level 1) and is longer than it, that prefix MUST be
  removed first; when only some do, `embed` MUST raise. An integer
  source code column is the exception: its prefix MUST be removed only
  when every code starts with it and, without a delimiter, the
  remainders share one width, else its codes MUST be kept whole. Without
  a delimiter, an integer level MUST then be left-padded with zeros to
  the larger of its min width and its widest value, never truncated, and
  a text level whose source codes differ in length MUST raise. Seeded
  levels are ranked as under `replace`.

## Outputs

- `code-create` MUST export the finest-level table, every resolved
  level's code column overwritten in place, as the main output.
- `code-create` MUST always write an overflow issues table (`cc_issues`),
  empty when no parent exceeded capacity. A level is checked only at a
  fixed width and when it was ranked (not embedded). Schema: `kind`
  (`'digit-overflow'`), `level`, `parent_code`, `assigned_code` (the
  parent's longest, then highest, child code), `child_count`,
  `min_width` (that level's width), `reason`.

## Configuration

- `code-create` MUST process exactly one input file per run.
- Root code, delimiter, and min width MUST all be given explicitly,
  validated via `resolveCodeFormat` with an empty delimiter allowed. Min
  width is a width, a coarsest-first width list, or `auto`. The root
  code is opaque, never shape-checked.
- Source codes MUST be `replace` (default), `embed`, or `copy`.
