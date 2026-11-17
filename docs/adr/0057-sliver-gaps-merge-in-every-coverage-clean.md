# 0057: Sliver gaps merge in every coverage clean

## Status

Accepted. Supersedes [0020](0020-clean-auto-gap-width-epsilon-not-double.md) and
[0024](0024-clean-default-gap-fill-demoted-to-noise-floor.md).

## Context

Topology Cleaner's Thin mode filled every gap up to the width of the widest
gap with a Polsby-Popper ratio at or below 0.3. Width was the only thing
`ST_CoverageClean` could act on, so a wide compact gap narrower than that
sliver filled too, and the default (Minimal) left a long, narrow digitizing
crack open. topo-tools made the same change in its ADR 0152.

## Decision

Every `buildCoverageClean` run, `coverageCleanRows` and Topology Cleaner's
clean merge each enclosed gap with `2 * area * vertices / perimeter^2` at most
`SLIVER_GAP_MAX_RATIO` (0.2) into the neighbour sharing its longest border, and
write a `sliver-gap` issue row. Edge Extender's final clean of its merged
output skips the pass. Topology Cleaner has no Thin mode, Minimal runs the
clean whenever a gap is detected, and a `gap=thin` link opens Minimal.

## Consequences

- A gap is judged by its width against the spacing of the vertices drawn
  around it, so a finely drawn narrow lake stays open.
- Inputs whose only gaps are slivers are cleaned by default.
- An enclave inside a hole is never merged over or counted as gap area.
