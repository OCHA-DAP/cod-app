# AGENTS.md: Gemeenten and provincies 2025 for edge-match

Input for `topo-tools edge-match`: the 342 land gemeenten from the CBS Wijk- en Buurtkaart 2025 ([full precision](../../2025/nld_admin2/AGENTS.md)) and the 12 provincies from Kadaster Bestuurlijke Gebieden, which include water. The CRS is OGC:CRS84.

## Run the demo

```bash
topo-tools edge-match https://data.source.coop/hdx/cod-site/tools/nld/demo/edge/nld_admin2.parquet https://data.source.coop/hdx/cod-site/tools/nld/demo/edge/nld_admin1.parquet nld_admin2_matched.parquet --per-feature
```

`edge-match --per-feature` assigns each gemeente to the provincie it overlaps most, then extends each provincie's gemeenten over its water (IJsselmeer, Waddenzee, the Zeeland estuaries) until they fill it. Without `--per-feature`, every gemeente goes into the one provincie most of them overlap and the rest are clipped away. The issues file lists the provincies' own 0 holes, such as the Baarle-Nassau enclaves. In the browser: [edge-match](https://topo-tools.org/edge-match?input=https://data.source.coop/hdx/cod-site/tools/nld/demo/edge/nld_admin2.parquet&overlay=https://data.source.coop/hdx/cod-site/tools/nld/demo/edge/nld_admin1.parquet&fit=each).

## Quirks

- Gemeente parts under 1 ha are dropped. They are slivers from the CBS land/water split, and edge-match grows each one into a spike ([topo-tools-py#142](https://github.com/OCHA-DAP/topo-tools-py/issues/142)).
- Water goes to the nearest gemeente, not its CBS owner. Vlissingen owns most of the Westerschelde in CBS; here the gemeenten on each shore split it.
- Boundaries are simplified to 100 m. Use the full-precision layer for areas.
