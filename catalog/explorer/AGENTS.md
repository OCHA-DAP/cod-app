# AGENTS.md: Boundaries Explorer data

Admin boundaries from several partner sources, one collection per source and level, plus the reference tables the Boundaries Explorer compares them with.

## Boundaries

Each `{source}/{source}_adm{n}/` collection holds `{source}_adm{n}.parquet`, its polygon tiles (layer `{source}_adm{n}`) and label points (layer `{source}_adm{n}_labels`). `hover_id` is a row index, not an admin code. The explorer's OCHA source is COD-AB's global layers (https://source.coop/hdx/cod-ab), not part of this catalog. Columns differ by source:

| Source | Location column | Name column | Code column | Levels |
|---|---|---|---|---|
| `wfp` | `iso3` | `adm{n}_name` | `source_id` | 1 to 4 |
| `unicef` | `adm0_ucode` (starts with the ISO3 code) | `name` | `Source_ID` | 1 to 4 |
| `unhcr` | `iso3` | `gis_name` | `adm{n}_source_code` | 1 to 2 |
| `fao` | `ISO3_CODE` | `GAUL{n}_NAME` | `GAUL{n}_CODE` | 1 to 2 |

Some sources include filler units such as "Under National Administration", "N/A" or "Waterbody" that aren't real subdivisions.

```sql
INSTALL spatial; LOAD spatial;
SELECT source_id, adm1_name FROM read_parquet('https://data.source.coop/hdx/cod-site/explorer/wfp/wfp_adm1/wfp_adm1.parquet') WHERE iso3 = 'MLI';
```

## Reference tables

Each `reference/{table}/` collection holds `{table}.parquet`. Join them on `iso3`.

```sql
SELECT * FROM read_parquet('https://data.source.coop/hdx/cod-site/explorer/reference/source_stats/source_stats.parquet') WHERE iso3 = 'MLI';
```
