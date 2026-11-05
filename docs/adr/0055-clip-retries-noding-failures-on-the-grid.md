# 0055: The clip retries a noding failure with its input rows on the grid

## Status

Accepted. Amends [0054](0054-edge-clips-are-plain-with-a-final-coverage-clean.md),
which left the clip without a fallback.

## Context

With the Edge Extender merge from topo-tools' #229, #231 and #232, the NLD
Edge Matcher demo failed in the clip with `TopologyException: found
non-noded intersection`. The exact `ST_Intersection` threw on 5 of 342 pairs,
in the Noord-Holland, Gelderland, Utrecht and Noord-Brabant groups, and on
the same groups' map previews. Every row and overlay polygon was valid.
topo-tools has no fallback here because native GEOS does not throw.

| Approach on the 5 failing pairs             | Pairs that worked |
| ------------------------------------------- | ----------------- |
| `ST_MakeValid(row)` then intersect          | 0                 |
| `ST_Snap(row, overlay, 1e-8)` then intersect | 1                 |
| `ST_ReducePrecision(·, 1e-11)` on both sides | 5                 |
| `ST_ReducePrecision(·, 1e-11)` on the row   | 5                 |

## Decision

- `clipEngine` retries a batch that throws once, with its input rows on
  `ST_ReducePrecision(geom, 1e-11)` and the overlay tiles exact. A batch that
  still throws propagates.
- Edge Matcher's group preview retries the same way.
- The retry covers the whole batch, not the failing row, so edges shared
  between rows in the batch round to the same vertices.
- The overlay stays exact so that groups on either side of an overlay
  boundary are cut by the same edge.

## Consequences

The NLD demo gives 342 rows, none invalid, with no `invalid-edge` or `gap`
rows and 4 `detached-part` rows. Rows in a retried batch move by at most
5e-12 degrees, three orders of magnitude below `SNAP_TOLERANCE`. Mosaic
shares the clip and gets the same retry. The retry catches any error, so an
out-of-memory failure runs the batch a second time before it propagates.
`tests/edge-match.test.ts` holds one failing NLD pair as a fixture and fails
if the retry goes away or the overlay goes on the grid.
