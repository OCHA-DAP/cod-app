# 0056: Edge gap rows report uncovered overlay area

## Status

Accepted. Supersedes the `gap` rows in [0054](0054-edge-clips-are-plain-with-a-final-coverage-clean.md).

## Context

Mosaic and Edge Matcher built `gap` rows from enclosed holes in the output whose
interior point fell inside a clip target, and wrote none with the final clean
skipped, so overlay area left uncovered along an open edge went unreported.
topo-tools made the same change in its ADR 0150.

## Decision

Mosaic and Edge Matcher write `gap` rows from `uncoveredOverlayIssuesSql` in both
clean modes. The clip engine records its rows' area per overlay polygon in
`<out>_cover`, and only an overlay falling short by more than
`UNCOVERED_AREA_RATIO` is unioned.

## Consequences

- A run with the final clean skipped reports gaps.
- A hole in the overlay's own shape is not reported.
- Each gap row carries its `overlay_fid`.
