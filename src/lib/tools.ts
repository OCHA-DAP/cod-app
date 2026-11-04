import { toolsUrl } from "$lib/utils/data";

export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  iconHref: string;
  /** Demo query params: input URL per DropZone `urlParam`, plus any tool setting (e.g. `gap`). */
  demo?: Record<string, string>;
}

export const tools: Tool[] = [
  {
    slug: "topo-clean",
    name: "Topology Cleaner",
    tagline:
      "Detect overlaps and gaps in a polygon coverage and clean them automatically, with an adjustable gap-width threshold.",
    iconHref: "/icons/tools/topo-clean.svg",
    demo: {
      url: toolsUrl("nld/demo/topo/nld_admin2.parquet"),
      gap: "thin",
    },
  },
  {
    slug: "edge-extend",
    name: "Edge Extender",
    tagline:
      "Fill gaps between adjacent polygons by extending boundaries outward with Voronoi diagrams.",
    iconHref: "/icons/tools/edge-extend.svg",
  },
  {
    slug: "edge-match",
    name: "Edge Matcher",
    tagline:
      "Match fine polygons to their best-overlapping coarse boundary (admin 4 into 3, admin 4 into 0, or any other pair), then extend each group to fit its boundary exactly.",
    iconHref: "/icons/tools/edge-match.svg",
    demo: {
      input: toolsUrl("nld/demo/edge/nld_admin2.parquet"),
      overlay: toolsUrl("nld/demo/edge/nld_admin1.parquet"),
    },
  },
  {
    slug: "change",
    name: "Changelog",
    tagline:
      "Compare two versions of a polygon layer and classify each unit as unchanged, modified, merged, split, created, or removed.",
    iconHref: "/icons/tools/change.svg",
    demo: {
      old: toolsUrl("nld/demo/code/nld_admin2_2022.parquet"),
      new: toolsUrl("nld/demo/code/nld_admin2_2023.parquet"),
      "code-a": "adm2_code",
      "name-a": "adm2_name",
      "code-b": "adm2_code",
      "name-b": "adm2_name",
    },
  },
  {
    slug: "topo-detect",
    name: "Detect",
    tagline:
      "Scan a polygon layer for gaps and overlaps and report them without fixing anything (read-only).",
    iconHref: "/icons/tools/topo-detect.svg",
    demo: {
      url: toolsUrl("nld/demo/topo/nld_admin2.parquet"),
    },
  },
  {
    slug: "edge-mosaic",
    name: "Mosaic",
    tagline:
      "Fit an already-extended input layer into a new overlay boundary. Assign and clip in one pass, no re-extension.",
    iconHref: "/icons/tools/edge-mosaic.svg",
  },
  {
    slug: "package",
    name: "Package",
    tagline:
      "Run Package Polygons, Package Points, and Package Lines against the same layer in one pass.",
    iconHref: "/icons/tools/package.svg",
    demo: {
      url: toolsUrl("nld/demo/package/nld_admin2.parquet"),
      name: "adm{n}_name",
      code: "adm{n}_code",
    },
  },
  {
    slug: "package-polygons",
    name: "Package Polygons",
    tagline:
      "Dissolve a polygon layer up to every coarser admin level it contains, one output file per level.",
    iconHref: "/icons/tools/package-polygons.svg",
  },
  {
    slug: "package-points",
    name: "Package Points",
    tagline:
      "Produce one representative point per admin unit, at every level a polygon layer's hierarchy contains.",
    iconHref: "/icons/tools/package-points.svg",
  },
  {
    slug: "package-lines",
    name: "Package Lines",
    tagline:
      "Extract every shared and exterior boundary edge in a polygon layer, classified by the coarsest level at which two neighbours diverge.",
    iconHref: "/icons/tools/package-lines.svg",
  },
  {
    slug: "schema-map",
    name: "Schema Map",
    tagline:
      "Infer a polygon layer's admin hierarchy crosswalk, review and edit it in place, and apply it to download the renamed layer, the crosswalk CSV, or both.",
    iconHref: "/icons/tools/schema-map.svg",
    demo: {
      url: toolsUrl("nld/demo/schema-map/nld_admin2.parquet"),
    },
  },
  {
    slug: "schema-join",
    name: "Schema Join",
    tagline:
      "Copy a join layer's admin hierarchy columns onto each input polygon by largest overlap, keeping conflicting values as numbered siblings.",
    iconHref: "/icons/tools/schema-join.svg",
    demo: {
      input: toolsUrl("nld/demo/schema-join/nld_admin2.parquet"),
      join: toolsUrl("nld/demo/schema-join/nld_admin1.parquet"),
    },
  },
  {
    slug: "schema-fill",
    name: "Schema Fill",
    tagline:
      "Cascade each admin-hierarchy column family down from its deepest non-empty level, and stamp every row with its real depth.",
    iconHref: "/icons/tools/schema-fill.svg",
  },
  {
    slug: "schema-detect",
    name: "Schema Detect",
    tagline:
      "Check a layer's admin-hierarchy columns for undetectable or skipped levels, inconsistent column naming, and units with several parents or none, without changing anything.",
    iconHref: "/icons/tools/schema-detect.svg",
  },
  {
    slug: "code-create",
    name: "Code Create",
    tagline:
      "Give every unit a new hierarchical code, numbered within its parent, or build it from the layer's own source codes.",
    iconHref: "/icons/tools/code-create.svg",
  },
  {
    slug: "code-update",
    name: "Code Update",
    tagline:
      "Reconcile an already-coded layer against an uncoded candidate: retain codes for unchanged units, assign fresh ones for the rest.",
    iconHref: "/icons/tools/code-update.svg",
    demo: {
      old: toolsUrl("nld/demo/code/nld_admin2_2022.parquet"),
      new: toolsUrl("nld/demo/code/nld_admin2_2023.parquet"),
    },
  },
  {
    slug: "code-detect",
    name: "Code Detect",
    tagline:
      "Check a coded layer's unit codes for blanks, conflicting names, duplicates, split units, parent-prefix mismatches and format outliers, without changing anything.",
    iconHref: "/icons/tools/code-detect.svg",
  },
  {
    slug: "name-detect",
    name: "Name Detect",
    tagline:
      "Check a coded layer's unit names for blanks, placeholders, duplicates under one parent, encoding errors and invisible characters, without changing anything.",
    iconHref: "/icons/tools/name-detect.svg",
    demo: {
      url: toolsUrl("nld/demo/names/nld_admin2.parquet"),
    },
  },
  {
    slug: "name-clean",
    name: "Name Clean",
    tagline:
      "Fix the name defects that can't change a name's meaning (spacing, invisible characters, Unicode normalization, encoding repairs) and report the rest for review.",
    iconHref: "/icons/tools/name-clean.svg",
    demo: {
      url: toolsUrl("nld/demo/names/nld_admin2.parquet"),
    },
  },
  {
    slug: "validate",
    name: "Validate",
    tagline:
      "Run the schema, topology, code and name checks on one layer and summarize their findings by kind, without changing anything.",
    iconHref: "/icons/tools/validate.svg",
  },
];
