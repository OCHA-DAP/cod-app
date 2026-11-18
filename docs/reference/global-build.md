# global-build

See `docs/reference/README.md` for the MUST/SHOULD/MAY convention. Code in
`cod_data/catalog/global_build/`.

## Inputs

- The build MUST take each location's source from
  `src/lib/explorer/decisions.csv`. A location picked `none`, or with no
  pick, MUST be ADM0 fill only: each level's polygon MUST be the ADM0
  polygon with the ADM0 name and code, written without schema-fill or
  package, with one point per level and no boundary lines.
- The build MUST read the ADM0 layer named by `--adm0` (`gaul`, `improved`
  or `fieldmaps`) from the adm0-app catalog (`ADM0_CATALOG`), and source
  layers from the explorer catalog.
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
  cached by input content and topo-tools version.
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
- The merge MUST raise on duplicate or null P-codes, malformed P-codes,
  P-codes not under their parent, and `name{i}`/`lang{i}` disagreements,
  and MUST report srcids over 20 characters, rows missing a source `lang`,
  and null names. It MUST replace the layers only after every layer
  passes.
- Each location MUST build in a temporary folder that replaces its last
  build only on success. A location that fails MUST keep its last
  successful build when that build's ADM0 rows match the current ADM0
  layer, and otherwise MUST fall back to ADM0 fill, built in the main
  process after the pool. It MUST be listed before the merge,
  and MUST make the run exit non-zero.
- The merge MUST include only locations with `admin1`, `points` and
  `lines` outputs, listing the others.
- `--only` MUST rebuild only the listed locations and merge every location
  already built.
- The merge MUST write each `adm{n}` polygon layer ordered by
  `adm{n}_pcode`, and `points` and `lines` in Hilbert order.
- Each location's build MUST record the topo-tools version that built it.
  The global collections MUST name the merged locations'
  versions only when every one of them has a record.
- The catalog's `global` step MUST copy each ADM0 layer in `PUBLISH` that
  has a merged build into `catalog/global/<adm0>/<adm0>_<layer>/`, one
  collection per layer, as a single GeoParquet with PMTiles, and MUST name
  each ADM0 layer in `PUBLISH` without one. It MUST write the portolan
  `metadata.yaml` for `global/`, each `global/<adm0>/` and each collection,
  and `global/TERMS.md`.
