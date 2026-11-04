# AGENTS.md: Gemeenten 2022 and 2023 for code-update

Input for `topo-tools code-update`: the land gemeenten from the CBS Wijk- en Buurtkaart 2022 and 2023 ([2022](../../2022/nld_admin2/AGENTS.md), [2023](../../2023/nld_admin2/AGENTS.md)), each with adm0 `NL` and its provincie from Kadaster Bestuurlijke Gebieden. The CRS is OGC:CRS84.

| File | Gemeenten | Codes |
|---|---|---|
| `nld_admin2_2022.parquet` | 345 | From `code-create`, root `NL`, no delimiter, 2-digit parts (`NL08`, `NL0804`). The Kadaster and CBS codes are kept as `adm1_code1` and `adm2_code1`. |
| `nld_admin2_2023.parquet` | 342 | Kadaster `PV` and CBS `GM` codes only. |

## Run the demo

```bash
topo-tools code-update https://data.source.coop/hdx/cod-site/tools/nld/demo/code/nld_admin2_2022.parquet https://data.source.coop/hdx/cod-site/tools/nld/demo/code/nld_admin2_2023.parquet nld_admin2_2023_coded.parquet nld_admin2_changelog.csv
```

`code-update` gives each 2023 gemeente the 2022 code of the gemeente it matches. Two mergers took effect on 1 January 2023: Amsterdam and Weesp into Amsterdam, and Brielle, Hellevoetsluis and Westvoorne into Voorne aan Zee. The changelog retires their 5 codes, creates 2 new ones and keeps the other 340. In the browser: [code-update](https://topo-tools.org/code-update?old=https://data.source.coop/hdx/cod-site/tools/nld/demo/code/nld_admin2_2022.parquet&new=https://data.source.coop/hdx/cod-site/tools/nld/demo/code/nld_admin2_2023.parquet).

## Quirks

- Amsterdam gets a new code even though CBS keeps `GM0363`, because every merger produces a new unit.
- Boundaries are simplified to 100 m. Use the full-precision layers for areas.
