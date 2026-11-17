# 0058: Package cleans and validates

## Status

Accepted. topo-tools made the same change in its ADR 0151.

## Context

Validation ran as a separate Validate tool, easy to skip before packaging.
Package refused any input that overlapped itself, so a layer with seams (an
Edge Mosaic output with its final clean skipped) could never be packaged.

## Decision

Package coverage-cleans the layer on load when it has gaps or invalid edges,
then runs Schema Detect, Topology Detect, Code Detect and Name Detect on every
run and packages nothing while any finding is an error. "Package anyway"
packages despite errors, with the check reports still offered. With Clean off,
the topology check is skipped, the sub-tools accept overlaps, and Package
Polygons lists `invalid-edge` rows in each level's issues, without gap rows,
since the gap scan's union fails on unmatched edges. An out-of-memory clean
asks to turn Clean off. The Validate tool is removed.

## Consequences

- Packaging a layer with a duplicate code, a placeholder name or a similar
  error requires fixing it or choosing "Package anyway".
- A package built with Clean off has seams and no gap check.
