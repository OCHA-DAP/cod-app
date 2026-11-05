// Meters ⇄ degrees conversion for display-only measurements (issue-report
// area/width columns, gap-width sliders). All data is normalized to
// WGS84 lon/lat (degrees) on load, so geometry math stays in degrees throughout;
// this exists only to render distances/areas in units a user reasons in.
// One degree of longitude shrinks by cos(latitude), so conversions scale by
// the dataset's centroid latitude (cached once per load, per tool module
// instance — each Astro route is a fresh module load).

export const METERS_PER_DEGREE = 111_320;

let centroidLat = 0;

export function setCentroidLat(lat: number): void {
  centroidLat = Number.isFinite(lat) ? lat : 0;
}

// Guard cos near the poles so the factor never collapses to ~0.
export function cosLatFactor(): number {
  return Math.max(Math.cos((centroidLat * Math.PI) / 180), 0.05);
}

// Approximate an area expressed in square degrees (ST_Area on EPSG:4326 data) as
// square metres, using the dataset's centroid latitude. Display-only — not for
// any geometry math.
export function degSqToM2(areaDegSq: number): number {
  return areaDegSq * METERS_PER_DEGREE * METERS_PER_DEGREE * cosLatFactor();
}

// Convert a scalar degree distance (e.g. MIC radius) to metres.
// Uses the latitude-scale constant (111 320 m/deg), which is exact for N-S
// distances and approximate for E-W; adequate for display-only widths.
export function degToM(deg: number): number {
  return deg * METERS_PER_DEGREE;
}
