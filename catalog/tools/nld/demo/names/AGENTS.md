# AGENTS.md: Gemeenten 2025 with name errors

Input for `topo-tools name-detect` and `topo-tools name-clean`: the 342 gemeenten of the [package](../package/AGENTS.md) demo with six `adm2_name` values edited, one per kind of finding. The CRS is OGC:CRS84.

| Code | Name | Stored as | Finding | Fixed by name-clean |
|---|---|---|---|---|
| GM1900 | Súdwest-Fryslân | `S\xc3\xbadwest-Frysl\xc3\xa2n` | `encoding-artifact` | yes |
| GM1970 | Noardeast-Fryslân | `Noardeast-Frysla\u0302n` | `unnormalized-unicode` | yes |
| GM0484 | Alphen aan den Rijn | `Alphen aan den  Rijn` | `whitespace` | yes |
| GM0502 | Capelle aan den IJssel | `Capelle\xa0aan\xa0den\xa0IJssel` | `invisible-character` | yes |
| GM0599 | Rotterdam | `ROTTERDAM` | `case-outlier` | no |
| GM0352 | Wijk bij Duurstede | `Utrechtse heuvelrug` | `normalized-duplicate-name` | no |

## Run the demo

```bash
topo-tools name-detect https://data.source.coop/hdx/cod-site/tools/nld/demo/names/nld_admin2.parquet nld_admin2_name_issues.csv
topo-tools name-clean https://data.source.coop/hdx/cod-site/tools/nld/demo/names/nld_admin2.parquet nld_admin2_cleaned.parquet nld_admin2_name_issues.csv
```

`name-detect` reports the six findings and changes nothing. `name-clean` restores the four names whose fix can't change their meaning, and leaves the capitals and the duplicate for review. In the browser: [name-clean](https://topo-tools.org/name-clean?url=https://data.source.coop/hdx/cod-site/tools/nld/demo/names/nld_admin2.parquet), [name-detect](https://topo-tools.org/name-detect?url=https://data.source.coop/hdx/cod-site/tools/nld/demo/names/nld_admin2.parquet).
