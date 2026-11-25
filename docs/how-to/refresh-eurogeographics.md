# Refresh EuroGeographics and legacy COD-AB inputs

The catalog's `eurogeographics` and `ocha` steps read local copies of
sources that have no stable download URL.

## EuroGeographics

1. Download EuroRegionalMap (GeoPackage, FullEurope) and EuroGlobalMap
   (GeoPackage) from https://www.mapsforeurope.org/datasets.
2. Unzip each into its own folder. Point `ERM_DIR` at the folder holding
   `data/FullEurope/FullEurope.gpkg` and `Metadata/Countries/`, and
   `EGM_DIR` at the folder holding `DATA/FullEurope/EuroGlobalMap_*.gpkg`.
   The defaults are `tmp/eurogeographics/erm` and `tmp/eurogeographics/egm`.
3. Run the step:

   ```bash
   uv run -m cod_data.catalog.run --step eurogeographics
   ```

   It rewrites `tmp/catalog/cache/eurogeographics/` when a GeoPackage, an ERM
   country metadata file, `iso3166`, `eurogeographics.py` or the clean code
   is newer than the last ingest, or topo-tools changed. Then it dissolves
   the explorer layers. A new release that adds orders or renames layers makes
   the step exit with the location and the cause. Adjust `skip`, `merge`,
   `split` or `extra` in `eurogeographics.py` to match.
4. Run `provenance`, `comparison` and `bbox`, and rebuild the global layers
   for EuroGeographics picks.

## Legacy COD-AB

`COD_AB_LEGACY_DIR` (default `tmp/cod-ab-legacy`) holds one folder per
location, each with `<key>_original.parquet` and `<key>_metadata.json`. The
layers are frozen. Copy them once from a fieldmaps/subnational checkout at
`3b8d919`:

```bash
S=../../fieldmaps/subnational/catalog/source
for k in $(duckdb -csv -noheader -c "SELECT DISTINCT key FROM (SELECT unnest(rows, recursive := true) FROM read_json('$S/*/*_metadata.json', union_by_name = true)) WHERE src = 'cod-ab-legacy' AND tier = 'original'"); do
  mkdir -p tmp/cod-ab-legacy/$k
  cp -p $S/$k/${k}_original.parquet $S/$k/${k}_metadata.json tmp/cod-ab-legacy/$k/
done
```
