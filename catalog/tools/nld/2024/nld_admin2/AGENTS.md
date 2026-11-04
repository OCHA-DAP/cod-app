# AGENTS.md: Netherlands admin2 (gemeenten) 2024

342 land gemeenten, 81 water rows sharing their gemeente's code and one `B` row from the CBS Wijk- en Buurtkaart 2024. The key is `(gemeentecode, water)`. The conventions and the cross-year recipe are in [../../AGENTS.md](../../AGENTS.md).

## Queries

```sql
INSTALL spatial; LOAD spatial;
-- Rows by land/water
SELECT water, count(*) FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2024/nld_admin2/nld_admin2.parquet') GROUP BY water;
-- B 1, JA 81, NEE 342

-- Largest gemeenten by land area in km²
SELECT gemeentecode, gemeentenaam, round(sum(ST_Area(ST_Transform(geometry, 'EPSG:28992', always_xy := true))) / 1e6, 1) AS land_km2
FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/2024/nld_admin2/nld_admin2.parquet')
WHERE water = 'NEE'
GROUP BY ALL ORDER BY land_km2 DESC LIMIT 3;
-- GM1900 Súdwest-Fryslân, 574.6
```
