# Performance Notes

Memory constraints and findings for DuckDB-WASM in the browser. The sister Python pipeline (`edge-extender`) has its own server-side notes; this file covers behaviour that differs in the WASM context. Algorithmic structure and SQL are ported verbatim from edge-extender — see that repo's `docs/explanation/performance.md` for profiling history.

---

## WASM GEOS OverlayNG floating-point divergence

Running this app's SQL in the browser (DuckDB WASM) surfaces a class of GEOS
robustness failure — `TopologyException: found non-noded intersection`, or a
mixed-type `GEOMETRYCOLLECTION` where a clean polygon was expected — that
does not reproduce natively. Same GEOS version family, same SQL, same input:
native `duckdb` CLI succeeds every time; the WASM build can fail when two
geometries that are supposed to coincide at a shared boundary don't, by a
few millimeters to centimeters, due to floating-point drift through an
extension/interpolation pipeline.

Confirmed **not** a monotonic "coarser is safer" knob: for one real case,
11mm and 33mm precision both failed but 16.7–27.8mm in between succeeded,
and separately 111mm also succeeded — no clean threshold, just scattered
working values (reconfirmed at finer grain by a later 155-value sweep, see
[`docs/adr/0006`](../adr/0006-precision-candidate-density-not-increased.md)).

**Mitigations**: Edge Extender's merge step snaps each Voronoi cell onto its
neighbour union with `ST_Snap` before differencing, and a difference that
still throws propagates, matching topo-tools
([`0022`](../adr/0022-noding-precision-retry-removed-for-python-parity.md)).
Its per-fid dissolve retries a failing fid's union on a 1e-11° grid
([`0038`](../adr/0038-extend-merge-union-grid-fallback.md)).
`src/lib/db/overlap.ts`'s `intersectPairs`, behind `computeOverlapPairs`
(Edge Matcher, Changelog, Code Update, Schema Join), assign-one, and the
shared overlap check (Detect, Topology Cleaner), runs its exact `ST_Intersection` set-based
first; if that throws, it recomputes pair by pair and snaps only the failing
pairs at `SNAP_TOLERANCE`, which reproduces native areas to ~1e-10 relative,
and a pair the snap doesn't rescue is intersected on a 1e-11° grid
([`0036`](../adr/0036-overlap-pairs-snap-fallback-on-wasm-noding-failure.md),
[`0037`](../adr/0037-snap-and-grid-fallbacks-extended-past-overlap-pairs.md),
[`0039`](../adr/0039-match-group-clip-uses-clip-engine-and-grid-tier.md)).
The clip engine retries a batch that throws with its input rows on the
1e-11° grid and the overlay exact
([`0055`](../adr/0055-clip-retries-noding-failures-on-the-grid.md)).
The shared gap check has no pair to snap, since its failure is in one
whole-layer union: it retries the union on a 1e-11° grid, three orders of
magnitude below `SNAP_TOLERANCE`, and drops each hole an input polygon
covers, since those are slits the grid opened between edges that were
shared in the original.

This failure class is also non-deterministic across otherwise-identical
runs of the same batch, likely tied to WASM heap state carried over from
earlier work in the same session — see
[`docs/adr/0007`](../adr/0007-noding-non-determinism-accepted-not-chased.md).

---

## WASM memory model vs. Linux

DuckDB on Linux uses virtual memory. The SPATIAL_JOIN operator pre-allocates ~1× physical RAM as a spill reservation — a virtual address claim with no physical pages mapped. Setting `memory_limit = '999GB'` exceeds the reservation threshold and lets the query proceed cheaply.

**In WASM this does not work.** WebAssembly has no virtual memory overcommit. Every `memory.grow()` call allocates real physical pages immediately. Setting `memory_limit = '999GB'` causes DuckDB to attempt a real multi-gigabyte allocation, which fails with `"Allocation failure"` rather than the budgeted `"failed to allocate data of size X MiB (Y GiB/Y GiB used)"`.

### Reading error messages

| Message                                                      | Meaning                                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"failed to allocate data of size X MiB (Y GiB/Y GiB used)"` | DuckDB's budget manager rejected the allocation. Y equals `memory_limit` exactly. Actual data in memory may be much smaller — this is often the SPATIAL_JOIN reservation bug, not real data pressure. |
| `"Allocation failure"`                                       | WASM `memory.grow()` failed. The physical heap is genuinely exhausted. No budget trick helps; the query must use less memory.                                                                         |

A whole-batch `ST_CoverageClean` on a large assembled result (e.g. Edge
Matcher's final output) can hit this ceiling outright — see
[`docs/adr/0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md)
for the confirmed ~3 GiB hard ceiling and why raising `memory_limit` doesn't
help.

---

## SPATIAL_JOIN operator

**What triggers it:** any `ST_Intersects`, `ST_Within`, or `ST_Contains` predicate in a JOIN ON clause — including LATERAL subqueries and correlated `EXISTS` / `NOT EXISTS` subqueries with a spatial predicate. DuckDB's optimiser rewrites these to `SPATIAL_JOIN`.

**WASM consequence:** because the reservation maps real pages, queries with SPATIAL_JOIN OOM immediately on memory-constrained devices, even when the actual data being joined is tiny.

### Patterns that work in WASM

- **Aggregate over one table** with no join (`ST_Union_Agg`, `ST_Node`, `ST_VoronoiDiagram`).
- **`CROSS JOIN` against a single-row intermediate table** — the optimiser sees it as a nested loop, not a spatial join. Useful for "subtract this one global geometry from each row" patterns.
- **Per-row scalar spatial functions** against a scalar geometry value (`ST_Intersection`, `ST_Difference`, `ST_Boundary`).
- **Bbox-prefiltered self-join.** Replace `JOIN b ON ST_Intersects(a.geom, b.geom)` with explicit scalar bbox-overlap predicates: `ST_XMax(b) >= ST_XMin(a) AND ST_XMin(b) <= ST_XMax(a) AND ST_YMax(b) >= ST_YMin(a) AND ST_YMin(b) <= ST_YMax(a)`. DuckDB plans this as `PIECEWISE_MERGE_JOIN` (range join), not `SPATIAL_JOIN`.
- **Bbox-prefiltered point-in-polygon.** For `JOIN ... ON ST_Within(p.pt, c.geom)`, add `ST_X(p.pt) >= ST_XMin(c.geom) AND ... AND ST_Within(p.pt, c.geom)`. The bbox predicates are necessary conditions for `ST_Within`, so semantics are preserved; the planner uses them as the join keys and `ST_Within` becomes a residual `FILTER`. Same for `NOT EXISTS` correlated subqueries.

These bbox-prefilter patterns are what make most of the pipeline WASM-safe without `memory_limit` overrides. They were profiled in edge-extender as identical-output and faster than the LATERAL+`ST_Intersects` forms they replaced. Topology Cleaner's own overlap detection uses the same bbox prefilter, combined with `ST_Overlaps`/`ST_Contains` instead of bare `ST_Intersects` — see [`docs/explanation/topo-clean.md`](clean.md#gapoverlap-detection-at-scale) for why plain `ST_Intersects` would also match every ordinary touching-edge pair.

---

## The remaining WASM-only adaptation: `voronoi.ts` `_04_tmp2`

The Voronoi cell-to-fid assignment uses `JOIN ... ON ST_Intersects(a.geom, b.geom)` (point × cell) and cannot use a bbox prefilter without changing semantics — generators that land exactly on a cell boundary must intersect both adjacent cells, and the bbox prefilter would still trigger `SPATIAL_JOIN` because the predicate is `ST_Intersects` rather than `ST_Within`.

The mitigation: wrap the join with `SET memory_limit = '999GB'` and restore the original limit afterwards. This is the one place the WASM SPATIAL_JOIN reservation cannot be avoided structurally. It works because the joined tables are small (bounded by `MAX_POINTS = 10M` generators × roughly equal cell count) and the reservation never triggers a real allocation past the working set.

An earlier version also created an explicit `USING RTREE (geom)` index on `_04_tmp1` before the join. It has been removed: measured net-negative at this site, since `SPATIAL_JOIN` already builds its own internal spatial index, so the explicit RTREE was a redundant index the planner had to weigh, plus a 0.9s build cost. Dropping it also dodges the v1.5.x "RTree indexes can only be created over GEOMETRY columns" rejection on CRS-tagged outputs from `ST_Read` (GeoPackage etc.), which removed the load-time WKB strip that had been added as a workaround.

The 999GB override is **not** applied anywhere else in the pipeline. `lines.ts` (bbox self-join) and `merge.ts` (bbox-prefiltered joins in `layer_05_tmp1`/`layer_05_tmp2`) all plan as `PIECEWISE_MERGE_JOIN` or `HASH_JOIN` and stay safely within the WASM heap.

---

## Voronoi collinearity cap and memory-budget-derived distance (`points.ts`, `distance.ts`)

Ported from edge-extender's `ce7fc0f`/`a3b1687`/`7f0a1a4` (see that repo's `docs/explanation/voronoi-memory.md` and `docs/adr/0012`/`0013` for the full derivation and profiling history). Two related fixes, both driven by the same root cause: a flat, user-supplied interpolation distance either wastes detail on fine boundaries or lets pathological inputs blow up.

**Segment cap.** `points.ts`'s `buildSegments` decomposes each `layer_02a` line into real vertex-to-vertex segments (`layer_03_tmp1`), independent of distance. `stagePoints` then caps interpolation density on any segment longer than `distance * MAX_POINTS_PER_SEGMENT` (100) — this bounds the size of the largest exactly-collinear point cluster fed to `ST_VoronoiDiagram`, which otherwise degrades toward worst-case behaviour independent of point count on long, straight, collinear boundaries (e.g. desert admin lines). Normal (non-capped) segments are re-merged per fid and resampled with the original whole-line formula, so the fix doesn't put a raw-vertex-count floor under every file's point count.

**Memory-budget-derived starting distance.** `distance.ts`'s `computeEffectiveDistance` replaces the old flat/user-supplied starting distance (the "Point spacing along boundary" Advanced-settings field has been removed — a coarser manual override could never win over natural-resolution auto-detection anyway) with `MAX(MIN(DEFAULT_DISTANCE, naturalRes), totalLength / targetPointBudget)`, using `current_setting('memory_limit')` as the `--memory-gb` equivalent from the Python port. `naturalRes` (median real segment length) lets finer-than-default boundaries start sharper; the budget term protects files whose exterior boundary would otherwise generate more points than the browser's memory budget can hold. If the raw segment count alone (independent of any resampling) already exceeds the budget, this falls back to `DEFAULT_DISTANCE` with a console warning rather than blocking — `memory_limit` is a soft target, not a hard gate, same as the Python port's `--memory-gb`.

**Constants not yet WASM-calibrated.** The memory-model constants (`REMERGE_BYTES_PER_RAW_SEGMENT`, `BASELINE_OVERHEAD_MB`, `BYTES_PER_POINT`, `SAFETY_MARGIN`) are carried over verbatim from the Python port's fitted values — measured against native GEOS process RSS inside a real `--memory=4g --memory-swap=4g` Docker container. WASM's `memory.grow()` physical-page-only model has no swap and different per-allocation overhead than a native GEOS process, so these should be treated as a provisional safeguard, not a validated budget, pending real-device recalibration.

---

## Connection settings (`duckdb.svelte.ts`)

| Setting                                                  | Effect                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SET preserve_insertion_order = false`                   | Free win. Removes sequence-tracking overhead from every intermediate buffer and eliminates the reorder pass after aggregations. No correctness impact.                                                                                    |
| `SELECT NULL::GEOMETRY('OGC:CRS84')` in `BEGIN`/`COMMIT` | Correctness: caches core's `OGC:CRS84` before spatial loads. Spatial's PROJ lookup of the same CRS throws `stoi` in WASM, which breaks every CRS84-tagged load. Outside an explicit transaction the cast itself throws an INTERNAL error. |
| `SET geometry_always_xy = true`                          | Correctness: forces (lon, lat) coordinate order regardless of CRS definition. Required for correct EPSG:4326 output.                                                                                                                      |
| `threads`                                                | Left at default. The base bundle runs without cross-origin isolation, so DuckDB has a single thread.                                                                                                                                      |
| `memory_limit`                                           | Left at default (about 3.1 GiB on the base bundle). The only override is the targeted `999GB` workaround in `voronoi.ts` described above.                                                                                                 |

---

## GDAL export via OPFS (`export.ts`)

The session database is an `opfs://` file opened with
`opfs: { fileHandling: "auto" }`, which registers every `opfs://` path a query
names. Single-file GDAL formats (GeoPackage, FlatGeobuf,
KML/LIBKML, GML) write to `opfs://<name>`, stored at `duckdb/fs/<name>` in the
origin private file system, and the export reads that file into a Blob and
removes it along with any SQLite `-journal`/`-wal`/`-shm` sidecar. GeoPackage
depends on this path: GDAL opens its SQLite journal at runtime under a name no
query mentions, and DuckDB serves such files from its OPFS scratch pool. A
20,000-polygon export (29 MB GeoPackage, 24 MB FlatGeobuf) reads back
complete. GeoParquet uses native `COPY ... (FORMAT PARQUET)` and bypasses GDAL.

Shapefile export is hidden. On duckdb-wasm 2.0 (1.33.1-dev111 to dev114), GDAL
writes to a registered buffer or OPFS handle land at the end of the file
whatever offset they ask for, and truncates have no effect, so Shapefile's
header back-patching appends extra headers and the `.shp`/`.shx`/`.dbf` come
out corrupt. Writing to `opfs://x.shp` produces no files, since only the `.shp`
is named in the query, and `.shp.zip`/`.shz` output is an empty archive.
Native DuckDB 2.0 writes the same shapefile correctly, and so does GDAL's own
`/vsimem/`, but SQL cannot read those bytes back out. The export code (one OPFS
handle per component file, zipped in the browser with fflate) stays in place
behind `hidden: true`. Reading shapefiles is unaffected.

FileGDB has no driver in the WASM spatial build: `OpenFileGDB` is absent from
`ST_Drivers()`, while native spatial can open and create it.

Two canaries in `tests/export.test.ts` track both gaps: `duckdb-wasm writes a
valid shapefile` and `duckdb-wasm has the OpenFileGDB driver`, each marked
`test.fails`. `.github/workflows/duckdb-canary.yml` runs them daily against
`@duckdb/duckdb-wasm@next` and opens an issue when either starts passing.

---

## Pipeline phase memory profile

| Phase       | Module                     | Memory concern | Notes                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load        | `loader.ts`                | Low            | File buffer registered directly; no copy                                                                                                                                                                                                                                                                                                                                          |
| Lines       | `lines.ts`                 | Medium         | Bbox-self-join materializes per-polygon neighbor unions (3–10 geoms each). No global aggregate.                                                                                                                                                                                                                                                                                   |
| Points      | `points.ts`, `distance.ts` | Low–medium     | Starting distance is derived per-file from `memory_limit` + natural boundary resolution (`distance.ts`), not user-supplied. Segments longer than `distance * MAX_POINTS_PER_SEGMENT` are capped to avoid Voronoi collinearity degeneracy. `MAX_POINTS = 10M` enforces a hard cap with retry-and-double-distance fallback.                                                         |
| **Voronoi** | `voronoi.ts`               | **High**       | `ST_VoronoiDiagram(ST_Collect(list(geom)))` materialises entire point cloud in GEOS. `_04_tmp2` join uses the `999GB` override. Retry mechanism doubles spacing until it fits.                                                                                                                                                                                                    |
| **Merge**   | `merge.ts`                 | **High**       | Per-part bbox-prefiltered neighbor-union differencing (`layer_05_tmp1`/`layer_05_tmp2`) computes each fid's Voronoi-cell remainder against nearby originals, then a single whole-table `ST_CoverageClean` pass (`layer_05_tmp3` → `layer_05`) closes floating-point-scale seams left by the independent per-fid `ST_Difference` calls. Bbox-prefiltered joins avoid SPATIAL_JOIN. |
| Export      | `index.ts`                 | Medium         | `ST_AsGeoJSON` per row, then JS string concat. Validation checks (overlap / gap / row count) run first; `runValidation` warnings go to console.                                                                                                                                                                                                                                   |

The retry loop in `pipeline/index.ts` (up to 10 attempts, doubling distance each time) is the safety valve for Points and Voronoi OOMs. It only covers stages 3–4; an OOM at lines (stage 2) or merge (stage 5) propagates as an unrecoverable error — the user is expected to fall back to the Python `edge-extender` for inputs that don't fit.

---

## Known-good baselines at real scale

Confirmed clean end-to-end runs against real portolan-catalog data (see the
`at-scale-testing` skill for how to pick a file):

| Tool           | Dataset            | Scale                                      | Result                                                                                             |
| -------------- | ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `/edge-match`  | `bgd` adm3→adm2    | 507 fine / 64 coarse groups                | ~5m24s, 0 invalid edges, area conserved                                                            |
| `/edge-extend` | `eth` adm3         | 1,148 features                             | ~100s, 0 retries                                                                                   |
| `/topo-clean`  | `bgd` adm3         | 507 features (12 MB)                       | ~35s, 0 overlaps, 0 gaps, 5 slivers                                                                |
| `/topo-clean`  | `cod` adm3         | 519 features (4.8 MB)                      | ~35s, 0 overlaps, 0 gaps, 6 slivers                                                                |
| `/topo-clean`  | `eth` adm3         | 1,148 features (9.3 MB)                    | ~25s, 0 overlaps, 0 gaps, 2 slivers                                                                |
| `/change`      | `ukr` adm3 v02→v04 | 1,770 A / 1,769 B features (14–15 MB each) | ~45s, 1287 unchanged / 481 modified / 1 merge / 0 created or removed, row totals exactly conserved |

`/edge-match`'s `cod` adm3→adm2 combination hits the 3 GiB WASM ceiling at higher
scale (519 fine / **164 coarse** groups) — see
[`docs/adr/0008`](../adr/0008-wasm-coverageclean-oom-ceiling-mitigated-not-fixed.md).
