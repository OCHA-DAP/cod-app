# Schema Refactor

`schema-refactor` applies a crosswalk to the loaded layer, renaming and
dropping its columns. It is the apply step of the Schema Map tool
(`docs/explanation/schema-map.md`), which feeds it either the crosswalk edited in
its table or an imported crosswalk CSV. Ported from topo-tools'
`schema-refactor` (`docs/explanation/schema_refactor.md` there).

## Pipeline

1. **Load** (`$lib/db/loader`, shared) - the layer loads the same way every
   other tool loads one, into `layer_01` (fid, geom) and `layer_attr` (fid
   plus every other attribute column).
2. **Load crosswalk** (`pipeline/crosswalk.ts`'s `loadCrosswalkCsv`) - the
   crosswalk CSV is new input infrastructure for this app: it registers the
   dropped file into DuckDB's virtual filesystem and reads it with DuckDB's
   native `read_csv`, not the GDAL-based `ST_Read` path every geodata loader
   uses, since a crosswalk is plain tabular data with no geometry.
3. **Parse** (`pipeline/crosswalk.ts`'s `parseCrosswalk`) - skips blank
   `source_column` rows, rejects a crosswalk missing the `source_column`
   column or listing the same `source_column` twice.
4. **Validate** (`pipeline/validate.ts`) - the crosswalk's `source_column`
   set must exactly equal `layer_attr`'s own column set, minus `fid` and
   minus a noise column the crosswalk doesn't list, so a crosswalk naming
   `OBJECTID` or `GlobalID` still applies. Noise-column detection (`isNoiseColumn`) is
   imported directly from `schema-map`'s `pipeline/constants.ts` rather than
   reimplemented, since it already carries ~20 real-world edge cases from
   topo-tools' own ADR history. A second check rejects a duplicate or
   reserved-name (`fid`/`geom`/`geometry`, case-insensitive) `target_column`.
5. **Rename** (`pipeline/rename.ts`) - one `SELECT` renames every source
   column to its `target_column` and drops any column whose `target_column`
   is null/empty, writing `sr_result_attr` with columns in crosswalk row
   order (topo-tools ADR 0115: reordering is a row move, in a
   spreadsheet or in Schema Map's table). `misorderedSiblings` in
   `$lib/db/adminColumns.ts`, a port of its `core/admin_columns.py`, flags
   the swapped-sibling case (`adm2_name1` before `adm2_name`) that template
   ordering existed to prevent. A `__row_order` column ranks rows by the
   deepest level's code (`canonicalOrder`'s sort column); the shared export
   sorts by it and leaves it out, since this app runs with
   `preserve_insertion_order = false`. `layer_01`'s
   geometry is never touched or re-read; the renamed attribute table is
   only joined back to it at export time.

## Crosswalk semantics

A `target_column` of null/empty means "drop this column"; anything else is
the new name to rename it to, including the column's own original name if
the intent is simply to retain it unchanged. `schema-map` leaves an
unmatched column's target empty, so an unedited crosswalk drops it, as in
topo-tools; keeping it is an explicit edit.

## Why this needed new CSV-input infrastructure

Every other tool in this app loads geodata through `$lib/db/loader.ts`,
which routes through DuckDB's spatial extension (`ST_Read`/`read_parquet`)
because every other input carries a geometry column. A crosswalk CSV has
none, and forcing it through the geodata path would require synthesizing a
fake geometry column or fighting `ST_Read`'s format sniffing for no benefit.
DuckDB WASM's native `read_csv` reads a registered virtual file directly,
so `pipeline/crosswalk.ts` mirrors `loader.ts`'s file-registration pattern
(`db.registerFileBuffer`, a session-unique registered name, `db.dropFile`
cleanup) without going through GDAL at all. This loader is scoped to
exactly the two-column shape `schema-refactor` needs, not a general CSV
importer; `DropZone.svelte`'s `accept="csv"` mode is similarly scoped to
swapping its file-extension allowlist, not building a generic upload
component.
