# AGENTS.md: Gemeenten and provincies 2025

Input for `topo-tools schema-join`: the 342 land gemeenten from the CBS Wijk- en Buurtkaart 2025 ([full precision](../../2025/nld_admin2/AGENTS.md)) and the 12 provincies from Kadaster Bestuurlijke Gebieden. The CRS is OGC:CRS84.

## Run the demo

```bash
topo-tools schema-join https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-join/nld_admin2.parquet https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-join/nld_admin1.parquet nld_admin2_join.parquet
```

`schema-join` assigns each gemeente to the provincie it overlaps most and copies that provincie's `adm1_code` and `adm1_name` onto it. `nld_admin2_join.parquet` has the columns `adm2_name, adm2_code, adm1_name, adm1_code` and is in EPSG:4326. Every gemeente lies inside one provincie, so no issues file is written.

## Quirks

- The provincies include water (IJsselmeer, Waddenzee, the Zeeland estuaries), while the gemeenten are land only.
- Boundaries are simplified to 100 m. Use the full-precision layer for areas.

## Queries

```sql
-- Provincie area in km², water included
SELECT adm1_code, adm1_name, round(ST_Area(ST_Transform(geometry, 'EPSG:28992', always_xy := true)) / 1e6) AS km2
FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-join/nld_admin1.parquet') ORDER BY adm1_code;
-- PV20 Groningen 2955, PV21 Fryslân 5753, PV22 Drenthe 2680, PV23 Overijssel 3421, PV24 Flevoland 2412, PV25 Gelderland 5136, PV26 Utrecht 1560, PV27 Noord-Holland 4092, PV28 Zuid-Holland 3308, PV29 Zeeland 2934, PV30 Noord-Brabant 5082, PV31 Limburg 2210
```
