# AGENTS.md: Netherlands admin3 (wijken) 2023

3,352 land wijken, 81 water wijken and one `B` row from the CBS Wijk- en Buurtkaart 2023. The key is `(wijkcode, water)`. The parent code is `gemeentecode`. The conventions and the cross-year recipe are in [../../AGENTS.md](../../AGENTS.md).

## Queries

```sql
INSTALL spatial; LOAD spatial;
-- Rows by land/water
SELECT water, count(*) FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2023/nld_admin3/nld_admin3.parquet') GROUP BY water;
-- B 1, JA 81, NEE 3352

-- Land area per unit in km²
SELECT wijkcode, wijknaam, ST_Area(ST_Transform(geometry, 'EPSG:28992', always_xy := true)) / 1e6 AS km2
FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2023/nld_admin3/nld_admin3.parquet')
WHERE water = 'NEE';
```
