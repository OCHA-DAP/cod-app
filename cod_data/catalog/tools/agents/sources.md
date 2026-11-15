# AGENTS.md: Admin 1 boundaries by source

Admin 1 units for a few locations from more than one source each, extracted from the explorer collections for comparing them. Every country and source is in one file. Compare sources by overlap, since each has its own codes.

Columns are `iso3`, `source`, `adm1_code` (the source's own code, so codes don't match across sources), `adm1_name`, `matches_ocha` (true when the unit and one OCHA unit in the same country each cover at least 95% of the other, and for OCHA's own units) and `geometry` in OGC:CRS84, simplified to about 100 m. Placeholder units such as "Under National Administration" or "Waterbody" are dropped.

| Country | `iso3` | Source | `source` | Units | Source date |
|---|---|---|---|---|---|
{rows}

```sql
INSTALL spatial; LOAD spatial;
SELECT adm1_code, adm1_name FROM read_parquet('{url}') WHERE iso3 = 'MLI' AND source = 'ocha';
```
