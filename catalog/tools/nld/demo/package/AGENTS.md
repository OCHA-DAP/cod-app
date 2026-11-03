# AGENTS.md: Gemeenten 2025 for package

Input for `topo-tools package`: the 342 gemeenten from the [edge](../edge/AGENTS.md) demo after `edge-match --per-feature`, so together they fill the provincies, water included. Each has adm0 `NL`, its provincie as adm1 from Kadaster Bestuurlijke Gebieden, and its CBS code and name as adm2. The CRS is OGC:CRS84.

## Run the demo

```bash
topo-tools package https://data.source.coop/hdx/cod-site/tools/nld/demo/package/nld_admin2.parquet --output 'nld_{x}.parquet' --name-field 'adm{n}_name' --code-field 'adm{n}_code'
```

`package` writes `nld_admin0`, `nld_admin1` and `nld_admin2` (1, 12 and 342 polygons), `nld_points` (355 points, one per unit) and `nld_lines` (1057 boundary lines). Each level's issues file lists the provincies' own 22 holes, such as the Baarle-Nassau enclaves. In the browser: [package](https://topo-tools.org/package?url=https://data.source.coop/hdx/cod-site/tools/nld/demo/package/nld_admin2.parquet&name=adm{n}_name&code=adm{n}_code).

## Quirks

- Without `--name-field` and `--code-field`, auto-detection finds only adm1 and adm2, so no country polygon is written.
- Boundaries are simplified to 100 m. Use the full-precision layer for areas.
