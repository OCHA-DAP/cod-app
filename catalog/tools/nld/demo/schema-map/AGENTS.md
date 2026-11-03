# AGENTS.md: Gemeenten 2025

Input for `topo-tools schema-map`: the 342 land gemeenten from the CBS Wijk- en Buurtkaart 2025 ([full precision](../../2025/nld_admin2/AGENTS.md)), with the provincie code and name from CBS StatLine table 86059NED. The CRS is OGC:CRS84.

## Run the demo

```bash
topo-tools schema-map https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-map/nld_admin2.parquet nld_admin2_mapped.parquet --csv-output nld_admin2_crosswalk.csv
topo-tools schema-map https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-map/nld_admin2.parquet --map-only --csv-output nld_admin2_crosswalk.csv
```

`--map-only` writes only the crosswalk. Without it, `schema-map` writes the same crosswalk and applies it:

| source_column | target_column | unique_count |
|---|---|---|
| `gemeentenaam` | `adm2_name` | 342 |
| `gemeentecode` | `adm2_code` | 342 |
| `provincienaam` | `adm1_name` | 12 |
| `provinciecode` | `adm1_code` | 12 |
| `landcode` | dropped | 1 |
| `landnaam` | dropped | 1 |
| `water` | dropped | 1 |
| `jaar` | dropped | 1 |

`nld_admin2_mapped.parquet` has the columns `adm2_name, adm2_code, adm1_name, adm1_code` and is in EPSG:4326.

## Quirks

- Boundaries are simplified to 100 m. Use the full-precision layer for areas.
- Water rows are left out, so `topo-detect` reports the water bodies, such as the IJsselmeer, as 87 gaps.
- `landcode` and `landnaam` each hold one value. They are there to show `schema-map` dropping single-value columns.

## Queries

```sql
-- Gemeenten per provincie
SELECT provinciecode, provincienaam, count(*) AS gemeenten
FROM read_parquet('https://data.source.coop/hdx/cod-site/tools/nld/demo/schema-map/nld_admin2.parquet')
GROUP BY ALL ORDER BY provinciecode;
-- PV20 Groningen 10, PV21 Fryslân 18, PV22 Drenthe 12, PV23 Overijssel 25, PV24 Flevoland 6, PV25 Gelderland 51, PV26 Utrecht 26, PV27 Noord-Holland 44, PV28 Zuid-Holland 50, PV29 Zeeland 13, PV30 Noord-Brabant 56, PV31 Limburg 31
```
