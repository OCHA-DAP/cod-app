// The six boundary-cleaning steps, in pipeline order, each with the main tool that runs it and its individual tools.
export const steps = [
  {
    n: 1,
    slug: "schema-map",
    extras: ["schema-join", "schema-fill", "schema-detect"],
    title: "Schema",
    brief: "Map source columns to codes and names",
  },
  {
    n: 2,
    slug: "topo-clean",
    extras: ["topo-detect"],
    title: "Topology",
    brief: "Find and fix gaps and overlaps",
  },
  {
    n: 3,
    slug: "edge-match",
    extras: ["edge-extend", "edge-mosaic"],
    title: "Edge matching",
    brief: "Fit units to the reference outline",
  },
  {
    n: 4,
    slug: "code-update",
    extras: ["code-create", "change", "code-detect"],
    title: "Codes",
    brief: "Carry codes over from the last release",
  },
  {
    n: 5,
    slug: "name-clean",
    extras: ["name-detect"],
    title: "Names",
    brief: "Fix encoding, spacing and duplicates",
  },
  {
    n: 6,
    slug: "package",
    extras: ["package-polygons", "package-points", "package-lines"],
    title: "Packaging",
    brief: "Check, then build polygons, points and lines",
  },
] as const;
