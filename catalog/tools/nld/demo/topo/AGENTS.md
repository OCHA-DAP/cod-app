# AGENTS.md: Gemeenten 2025 with digitization errors

Input for `topo-tools topo-detect` and `topo-tools topo-clean`: the 343 gemeenten from the CBS Wijk- en Buurtkaart 2025 ([full precision](../../2025/nld_admin2/AGENTS.md)), each with its water, so together they cover the country with no gaps or overlaps. Then one vertex on each of five shared borders is moved, the way a misplaced click would. The CRS is OGC:CRS84.

| Error | Gemeente | Neighbour | Vertex moved |
|---|---|---|---|
| Overlap | Utrecht | De Bilt | 30 m |
| Overlap | Amsterdam | Amstelveen | 25 m |
| Gap | Rotterdam | Krimpen aan den IJssel | 20 m |
| Gap | Eindhoven | Veldhoven | 15 m |
| Gap | Groningen | Het Hogeland | 25 m |

## Run the demo

```bash
topo-tools topo-detect https://data.source.coop/hdx/cod-site/tools/nld/demo/topo/nld_admin2.parquet nld_admin2_issues.parquet
topo-tools topo-clean https://data.source.coop/hdx/cod-site/tools/nld/demo/topo/nld_admin2.parquet nld_admin2_cleaned.parquet --maximum-gap-width thin
```

`topo-detect` reports 2 overlaps and 3 gaps, 17 to 43 m wide. `topo-clean` always fixes the overlaps. `--maximum-gap-width thin` also fills the gaps, because each is a thin wedge along a border. In the browser: [topo-clean](https://topo-tools.org/topo-clean?url=https://data.source.coop/hdx/cod-site/tools/nld/demo/topo/nld_admin2.parquet&gap=thin), [topo-detect](https://topo-tools.org/topo-detect?url=https://data.source.coop/hdx/cod-site/tools/nld/demo/topo/nld_admin2.parquet).

## Quirks

- `GM0998` Buitenland is the Belgian enclaves in Baarle-Nassau. It stays in so the coverage has no holes.
- Boundaries are simplified to 100 m. Use the full-precision layer for areas.
