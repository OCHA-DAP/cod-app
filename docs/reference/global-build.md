# global-build

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention. Code in
`cod_data/catalog/global_build/`.

## Inputs

- The build MUST take each location's source from
  `src/lib/explorer/decisions.csv`. A location picked `none`, or with no
  pick, MUST be ADM0 fill only: each level's polygon MUST be the ADM0
  polygon with the ADM0 name and code, written without schema-fill or
  package, with one point per level and no boundary lines.
- The build MUST raise when a pick names a source it doesn't take.
  World Bank layers are for comparison in the explorer only.
- The build MUST read the ADM0 layer named by `--adm0` (`improved` by
  default, `gaul` or `fieldmaps`) from the adm0-app catalog
  (`ADM0_CATALOG`), and source layers from the explorer catalog.
- The build MUST NOT write to the cod-ab catalog (`COD_AB_CATALOG`) or the
  adm0-app catalog.

## Staging

- Filler rows (the source's `junk_values` in `cod_data/catalog/common.py`) MUST be
  dropped, unless every unit at that level is filler. Then a single filler
  unit MUST be named after the ADM0 layer's location, and each of several
  MUST be named from the source's ADM0 name column where it has one (WFP),
  else after the ADM0 layer's location.
- Units with no name MUST be kept, and counted in the run report.
- A location's depth MUST be its deepest level with more units than the
  level above and at least 99% of level 1's area (`FULL_COVER`), unless
  `DEPTH` sets it for that location and source. For an
  OCHA pick it MUST NOT exceed the deepest level that has a cod-ab extended
  layer, and only units in that layer MUST be kept.
- `lang` MUST come from the source for OCHA, from the subnational layers
  for ERM, and MUST be `en` for every other source and for fill rows.
  Locations in `PRIMARY_NAME1` MUST swap `name` with `name1` and `lang`
  with `lang1`.
- Each row MUST carry one `lang1`..`lang3`, the tag nearest the deepest
  level. A level's `name1`..`name3` MUST be kept only where its own tag
  equals the row's, and `lang{i}` MUST be null on a row with no
  `name{i}` in that layer.

## Geometry

- Every pick MUST have each unit that fully covers another cut around it
  (identical units excepted), and MUST be cleaned with `topo_clean` when
  `topo_detect` finds overlaps or gaps (with the `GAP_WIDTH` entry for the
  location, if any).
- An OCHA pick MUST then take its geometry from the cod-ab catalog's
  `extended/<iso3>/latest` layer, joined by P-code, MUST raise unless every
  unit matches exactly one extended unit with none left over, and MUST be
  cleaned with `topo_clean` when `topo_detect` finds any defect.
- Any other pick MUST then be extended with `edge_extend` and cleaned with
  `topo_clean` when `topo_detect` finds any defect. Extensions MUST be
  cached by input content, the DuckDB, spatial extension and topo-tools
  versions, and the extend code.
- For locations in `PARTS`, each unit MUST go to the ADM0 part holding its
  maximum inscribed circle center, else its largest overlap, else the
  nearest part. The build MUST raise if a unit lands in a part not listed.
- Units MUST be edge-matched to the ADM0 layer with `edge_mosaic`. ADM0
  area no unit covers MUST become one admin 0 unit per location with
  `level` 0, and a unit wholly outside the ADM0
  layer MUST be dropped and listed as `clip-empty` in the location's
  `mosaic_issues.parquet`.

## Codes

- P-codes MUST follow `src/content/standards/specification/assignment.md`
  (`ISO3.NNN`, sort cascade with digit-only srcids by numeric value). The
  source's own code MUST be kept in `adm{N}_srcid`.

## Outputs

- The build MUST write `adm1_polygons` to `adm4_polygons`, `points` and
  `lines` GeoParquet to `tmp/global/<adm0>/`, with the fields of
  `schema.md`. A location shallower than a layer MUST repeat its deepest
  units there with their own `level`, copying their fields down.
- Polygon fields MUST run from the layer's level down to adm0, each level's
  fields in `schema.md` order, before `version`.
- `version` MUST be 1, and `updated` and `valid_to` MUST be null.
  `valid_from` MUST be recorded when the location is built, as its
  `source_updated` in the explorer's `source_provenance`: the latest
  `valid_on` for OCHA (provenance MUST raise when a location has more than
  one), `src_date` for ERM, `update_date` for UNHCR, `source_date` for WFP,
  `start_date` for UNICEF, and the "Accessed on" date of GAUL's metadata
  spreadsheets for FAO. It MUST be null on or before 1900-01-01, when
  there is no date, and when the location is ADM0 fill.
- `lang1` to `lang3` MUST be constant within a location: the source's tag
  wherever any of its units has that `name{i}`, and null otherwise.
- The merge MUST raise on duplicate or null P-codes, malformed P-codes,
  P-codes not under their parent, a `name{i}` without its `lang{i}`,
  fields out of `schema.md` order, a location with more than one value,
  or a mix of null and non-null, in `version`, `updated`, `valid_from`,
  `valid_to`, `lang` or `lang1` to `lang3`, and `version` other than 1 or
  a set `updated` or `valid_to`.
  It MUST report rows missing a source `lang` and null names. It MUST
  replace the layers only after every layer passes.
- Each location MUST build in a temporary folder that replaces its last
  build only on success. A location that fails MUST keep its last
  successful build when that build has every output the merge needs and
  its ADM0 rows match the current ADM0 layer, and otherwise MUST fall back
  to ADM0 fill, built in the main
  process after the pool. An error reading the ERM catalog MUST fail only
  the ERM picks. A location whose fill also fails MUST count as
  unbuilt. It MUST be listed before the merge,
  and MUST make the run exit non-zero.
- Each location's build MUST record a fingerprint of its inputs: its
  pick, its rows in the ADM0 layer and in each of the pick's explorer
  layers, the cod-ab extended layers (OCHA), the ERM original layers' size
  and modification time (ERM), the pick's `BOUNDARY_SOURCES` entry, the
  code its build runs (the global build modules except the merge and
  staging, `common.py`, `erm.py` and `geoparquet.py`), and the DuckDB,
  spatial extension and topo-tools versions. A run MUST skip a
  built location whose fingerprint is unchanged, rewriting only its
  `valid_from`.
- The run MUST NOT merge while any location lacks its `admin1`, `points`,
  `lines`, `valid_from.txt`, fingerprint or build id output. It MUST list those
  locations, leave the merged layers as they are and exit non-zero.
- `--only` MUST rebuild the listed locations even when unchanged, then
  merge every location, stopping when any is unbuilt. `--merge-only` MUST skip the builds
  and merge again.
- Each build MUST record a unique build id. The run MUST skip the merge
  when every merged layer exists and the merge code (with the build
  settings and `geoparquet.py`) and each location's build id and
  `valid_from` are unchanged.
- The merge MUST write each `adm{n}` polygon layer ordered by
  `adm{n}_pcode`, `points` by `pcode` and `lines` in Hilbert order, with
  row groups of at most 32 MB.
- Each location's build MUST record the installed topo-tools version,
  including ADM0 fill builds and OCHA picks whose geometry comes from the
  cod-ab catalog. The global collections MUST name the merged locations'
  versions only when every one of them has a record.
- The catalog's `global` step MUST publish only the `improved` build, and
  MUST skip the step with a message when it has no merged build. It MUST
  fail when the merged layers don't hold every location's current build,
  when any build's fingerprint or `valid_from` differs from its current
  inputs (so an ADM0 fill or kept build of a failed pick blocks it), or
  when the merged layers hold a location the ADM0 layer no longer has, or
  lack one it has.
  It therefore needs every build input: the adm0-app, cod-ab and ERM
  catalogs and the explorer layers. A missing or unreadable
  `parents.parquet` MUST count as not current. It MUST
  write `catalog/global/adm{n}-{geom}/adm{n}_{geom}.parquet` for levels 1
  to 4 and `polygons`, `points` and `lines`, each with PMTiles named after
  the file: `polygons` the merged layer, `points` the level-`n` points with
  their polygon's `level`, `lines` every line with `adm_lvl <= n` and
  `adm_lvl` written as `level`.
- It MUST write the same twelve layers for each merged location to
  `catalog/iso3/<iso3>/`, polygons cut from the merged layer by
  `adm0_pcode` and points and lines from the location's build, and MUST
  remove the folder of a location the merge no longer has.
- Published polygons MUST be ordered by `adm{n}_pcode` and points by
  `pcode`. Lines MUST be in Hilbert order, over the world box in the global
  layers and over the location's extent per location. Row groups MUST be
  at most 32 MB in the global layers and 8 MB per location.
- The catalog check MUST pass apart from PTL-DAT-006 (rows not spatially
  ordered) on published polygons, which P-code order can raise.
- A global layer MUST be rewritten only when its merged source is newer,
  polygons as a copy of the merged layer. A location's layers MUST be
  rewritten only when its build id, its `valid_from`, the merge code (with
  the build settings and `geoparquet.py`) or the staging code changed since they were last written, or a layer is
  missing. A layer MUST be tiled only when its tiles are missing or older.
- Each level's points MUST pair 1:1 with its polygons by P-code, or the
  step MUST fail.
- It MUST write the portolan `metadata.yaml` for `global/`,
  `iso3/`, each collection and each location (titled with its
  `adm0_name`, naming its picked source's provider), and
  `global/TERMS.md` and `iso3/TERMS.md`.
