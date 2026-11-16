# Package Points

`package-points` produces one label point per admin unit per detected
level, combined into a single output file, for web-map label placement.
It uses the pole of inaccessibility (`ST_MaximumInscribedCircle`) rather
than the centroid, since a centroid can fall outside a concave or
multi-part polygon (e.g. a crescent-shaped or archipelago admin unit),
which would place a label off its own territory. Ported from
topo-tools' `package-points`.

## Pipeline

1. **Load** (`$lib/db/loader`, shared), then `pipeline/index.ts` joins
   `layer_01`/`layer_attr` into a working `pkpt_input` table.
2. **Resolve level plans** (`pipeline/points.ts`'s
   `resolvePointLevelPlans`) - detects every level (explicit schema or
   structural auto-detection, same engine `package-polygons` uses), and,
   on the auto-detect path, looks for a whole-table-constant coarser
   family one level below the finest detected levels
   (`schema-map/pipeline/levelColumns.ts`'s `detectRootLevel`), injecting
   it as a synthetic level 0 when found (`rootInjected`). Each level's
   `groupBy` is filtered to the anchor-conforming subset of its
   `identityColumns` (see `docs/adr/0033`), and `exclude` is every
   _other_ level's own `identityColumns` (not just finer ones, since an
   ancestor never survives under its own numbered name here either).
3. **Per-level dissolve and point extraction**
   (`pipeline/index.ts`'s `buildLevelOutput`) - dissolves via
   `package-polygons/pipeline/dissolveCore.ts`'s `runDissolveCore`, checks
   the dissolved row count against the input's own distinct group-by
   tuple count, computes `(ST_MaximumInscribedCircle(geom)).center` per
   row, stamps the depth column (an input column of that name, such as
   Schema Fill's real-depth stamp, is left out of the input first), and
   verifies every point is
   `ST_Covers`-ed by its own source polygon.
4. **Generalizable-columns gate** - processing runs coarsest-to-finest,
   as in topo-tools; `generalizable` seeds from the coarsest real
   level's own surviving column set, and every finer level's own output is
   filtered down to that set before renaming. A column a coarser dissolve
   drops (e.g. a finest-level-only attribute) would be `NULL` on that
   level's rows, so it is dropped from every level. The root level (if
   injected) is exempt, since it has nothing coarser to compare against.
5. **Rename and combine** - each level's own identity columns are renamed
   to a name shared across every level
   (`schema-map/pipeline/levelColumns.ts`'s `groupFamiliesByLevel`/
   `levelFamilyNames` on the auto-detect path, or a fixed `code`/`name` on
   the explicit-schema path), then every level's points table is combined
   via `UNION ALL BY NAME`: a column excluded at a given level is simply
   absent from that level's own table, not unioned in as an always-`NULL`
   column.

## Why `ST_MaximumInscribedCircle`, not the centroid

`ST_Centroid` is a purely geometric average of a polygon's area and can
land outside the polygon itself for a concave shape, or on open water
between two islands for a multi-part one. `ST_MaximumInscribedCircle`'s
`center` is always interior to the polygon (the center of the largest
circle that fits inside it), the standard technique for keeping a
web-map label anchored on its own territory.
