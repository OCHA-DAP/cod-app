# 0059: Package Lines builds a noded boundary network

## Status

Accepted. Supersedes the pair-finding and exterior-difference part of
0032. topo-tools made the same change in its ADR 0153.

## Context

An Edge Mosaic output with its final clean skipped keeps clip seams: two
neighbours overlap by a sliver, and one side carries T-junction vertices
just off the other side's segment. Per-pair extraction (`ST_Touches`,
then `ST_Intersection` of the two boundaries) drops such a pair or misses
the stretches beside each T-junction, so the border comes out as two
exterior lines.

## Decision

Node every unit boundary together into one line network, per 1° tile
with a small overlap, then label each edge by the units whose boundary
lies within `10 * SNAP_TOLERANCE` of its midpoint. Endpoints within that
tolerance merge onto the least one, twin copies of a shared border are
snapped onto each other, and every aggregate after noding is ordered, so
the output is the same on every run and in any input row order.

## Consequences

Seamed input gives the same shared borders as its cleaned copy. Noding
holds every tile's boundaries at once, raising peak memory over per-pair
extraction. A unit whose boundary touches itself at a vertex keeps one
row per side of that vertex.
