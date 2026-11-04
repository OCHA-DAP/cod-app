# AGENTS.md: Admin 1 boundaries by source

Admin 1 units for a few locations from more than one source each, extracted from the explorer collections for comparing them. Every country and source is in one file. Compare sources by overlap, since each has its own codes.

Columns are `iso3`, `source`, `adm1_code` (the source's own code, so codes don't match across sources), `adm1_name`, `matches_ocha` (true when the unit and one OCHA unit in the same country each cover at least 95% of the other, and for OCHA's own units) and `geometry` in OGC:CRS84, simplified to about 100 m. Placeholder units such as "Under National Administration" or "Waterbody" are dropped.

| Country | `iso3` | Source | `source` | Units | Source date |
|---|---|---|---|---|---|
| Central African Republic | `CAF` | OCHA | `ocha` | 20 | 2023-01-01 |
| Central African Republic | `CAF` | FAO | `fao` | 7 | - |
| Mali | `MLI` | OCHA | `ocha` | 20 | 2025-05-13 |
| Mali | `MLI` | WFP | `wfp` | 10 | 2023-04-05 |
| Burkina Faso | `BFA` | OCHA | `ocha` | 17 | 2025-07-01 |
| Burkina Faso | `BFA` | UNICEF | `unicef` | 13 | - |
| Ghana | `GHA` | OCHA | `ocha` | 16 | 2021-03-10 |
| Ghana | `GHA` | UNICEF | `unicef` | 10 | - |
| South Sudan | `SSD` | OCHA | `ocha` | 10 | 2020-11-01 |
| South Sudan | `SSD` | World Bank | `wb` | 12 | - |
| Madagascar | `MDG` | OCHA | `ocha` | 24 | - |
| Madagascar | `MDG` | World Bank | `wb` | 6 | - |

```sql
INSTALL spatial; LOAD spatial;
SELECT adm1_code, adm1_name FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/sources/sources_adm1.parquet') WHERE iso3 = 'MLI' AND source = 'ocha';
```
