# AGENTS.md: COD site data

Data behind the CODs site. Each collection holds a GeoParquet or Parquet file, and boundary collections also hold PMTiles.

## Layout

- `explorer/{{source}}/{{source}}_adm{{n}}/`: admin boundaries from each partner source (`wfp`, `unicef`, `unhcr`, `fao`, `wb`, `erm`), with polygon tiles and `{{source}}_adm{{n}}_labels.pmtiles` label points. OCHA boundaries are COD-AB's own global layers at https://source.coop/hdx/cod-ab. See [explorer/AGENTS.md](explorer/AGENTS.md).
- `explorer/basemap/`: country outlines and boundary lines for the explorer's base map.
- `explorer/reference/{{table}}/`: per-location reference tables.
- `global/{{adm0}}/{{adm0}}_{{layer}}/`: global admin 1 to 4 polygons, label points and boundary lines built from the explorer's picks, edge-matched to one ADM0 layer, with tiles.
- `tools/`: sample inputs for the tools. See [tools/AGENTS.md](tools/AGENTS.md).

## Reading

DuckDB reads every file over HTTP:

```sql
INSTALL spatial; LOAD spatial;
SELECT * FROM read_parquet('{data}/explorer/wfp/wfp_adm1/wfp_adm1.parquet') LIMIT 5;
```

## License

Catalog metadata and `tools/` are CC-BY-4.0. Layers in `explorer/` and `global/` follow their producers' terms, see [explorer/TERMS.md](explorer/TERMS.md) and [global/TERMS.md](global/TERMS.md).
