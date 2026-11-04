# 0012: Edge Matcher cleans both parent and child input layers on load

## Status

Accepted. Superseded for the overlay layer by [0054](0054-edge-clips-are-plain-with-a-final-coverage-clean.md)

## Context

Alongside accepting the cross-group near-miss defect
([0011](0011-near-miss-cross-group-edges-accepted-as-cosmetic.md)), the
Burundi source data itself was measured to already carry ~81.5m of
pre-existing invalid-edge length on the parent (Commune) layer and ~328m on
the child (Zone) layer, independent of anything Edge Matcher's own pipeline
introduces. The parent layer was never cleaned anywhere in the pipeline
before; the child layer was only ever cleaned per-group, after splitting
(`edge-extender/pipeline/clean.ts`'s `stageCleanInput`), which misses
defects between child units assigned to _different_ groups.

## Decision

`match/pipeline/load.ts`'s `loadLayers` runs
`gatedCoverageClean(conn, "parent_layer_01")` and
`gatedCoverageClean(conn, "child_layer_01")` right after loading, at default
settings (`snap=-1` auto, `gap=0` no gap-fill) — the same gated,
preserve-fid-set pattern used elsewhere in this pipeline.

## Consequences

Verified natively (this SQL doesn't touch any WASM-only code path, so
native verification is representative): on the real Burundi data, the
parent layer's pre-existing 81.5m of invalid-edge length drops to exactly
0m, and the child layer's 328m drops to 133m (60% reduction) — both with
fid count and total area preserved to float64 precision. This does **not**
address the much larger cross-group clip-introduced defect from
[0011](0011-near-miss-cross-group-edges-accepted-as-cosmetic.md) (135,547
edges, ~1,245 km) — that mechanism is introduced downstream by the per-group
clip step, not present in the raw inputs. Live end-to-end verification on
the full Burundi batch: 43/43 groups succeeded, 0 errors, no regressions.
