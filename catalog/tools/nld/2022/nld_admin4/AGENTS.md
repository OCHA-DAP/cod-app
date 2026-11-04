# AGENTS.md: Netherlands admin4 (buurten) 2022

14,317 land buurten, 94 water buurten and one `B` row from the CBS Wijk- en Buurtkaart 2022. The key is `(buurtcode, water)`. The parent codes are `wijkcode` and `gemeentecode`. The conventions and the cross-year recipe are in [../../AGENTS.md](../../AGENTS.md).

## Queries

```sql
INSTALL spatial; LOAD spatial;
-- Rows by land/water
SELECT water, count(*) FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2022/nld_admin4/nld_admin4.parquet') GROUP BY water;
-- B 1, JA 94, NEE 14317

-- Land area per unit in km²
SELECT buurtcode, buurtnaam, ST_Area(ST_Transform(geometry, 'EPSG:28992', always_xy := true)) / 1e6 AS km2
FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2022/nld_admin4/nld_admin4.parquet')
WHERE water = 'NEE';
```
