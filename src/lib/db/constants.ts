// Snap/gap tolerance shared across tools, in decimal degrees (~1.1mm at the equator).
export const SNAP_TOLERANCE = 1e-8;

// Grid a union retries on when WASM GEOS throws a noding error that native GEOS doesn't.
export const NODING_FALLBACK_GRID = 1e-11;

// Geometries with at least SUBDIVIDE_MIN_VERTICES are split (ST_Subdivide) into
// pieces of at most SUBDIVIDE_MAX_VERTICES before per-row joins.
export const SUBDIVIDE_MIN_VERTICES = 5000;
export const SUBDIVIDE_MAX_VERTICES = 1350;
// Input vertices one batch of clip input/tile (or invalid-edge part) pairs may carry.
export const CLIP_PAIR_VERTEX_BUDGET = 20_000_000;

// Ported from topo-tools' core/constants.py; clip-detached piece merge rule,
// see mergeDetachedParts in $lib/db/coverage.ts.
export const DETACHED_MERGE_MAX_RATIO = 0.01;
export const DETACHED_MAX_ORIGINAL_SHARE = 0.5;
export const DETACHED_MIN_NECK_RATIO = 0.1;

// Ported from topo-tools' core/constants.py; notch detection and closing,
// see $lib/db/notches.ts.
export const NOTCH_SPACING = 0.0002;
export const NOTCH_MIN_SCORE = 2;
export const NOTCH_MAX_GAP_RATIO = 1 / 10;
export const NOTCH_WINDOW_MARGIN = 0.002;
