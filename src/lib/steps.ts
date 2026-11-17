// The six boundary-cleaning steps, in pipeline order, each with the main tool that runs it.
export const steps = [
  {
    n: 1,
    slug: "schema-map",
    title: "Schema",
    brief: "Map source columns to codes and names",
    summary: "Map source columns to admin code and name columns, then apply the crosswalk.",
  },
  {
    n: 2,
    slug: "topo-clean",
    title: "Topology",
    brief: "Find and fix gaps and overlaps",
    summary: "Find gaps and overlaps between units, then clean them.",
  },
  {
    n: 3,
    slug: "edge-match",
    title: "Edge matching",
    brief: "Fit units to the reference outline",
    summary: "Fit units to a reference boundary so the outer edge follows the agreed outline.",
  },
  {
    n: 4,
    slug: "code-update",
    title: "Codes",
    brief: "Carry codes over from the last release",
    summary:
      "Keep the previous release's codes for units that carry over, or cold-start codes when there is no previous release.",
  },
  {
    n: 5,
    slug: "name-clean",
    title: "Names",
    brief: "Fix encoding, spacing and duplicates",
    summary:
      "Fix spacing, invisible characters and encoding errors, then review what's left by hand: duplicates under the same parent, near-duplicate typos, blanks and placeholders.",
  },
  {
    n: 6,
    slug: "package",
    title: "Packaging",
    brief: "Check, then build polygons, points and lines",
    summary:
      "Check the schema, topology, codes and names, then build per-level polygons, label points, and the boundary line network for release.",
  },
] as const;

export type StepSlug = (typeof steps)[number]["slug"];

export const step = (slug: StepSlug) => steps.find((s) => s.slug === slug)!;
