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
   `resolvePointLevelPlans`) - detects every level (explicit schema, or
   `schema-map/pipeline/levelColumns.ts`'s `detectLevelsWithRoot` on the
   auto-detect path, which adds a whole-table-constant coarser family as
   its own root level, numbered by its own anchor digit). Each level's
   own identity columns come from its column families: `genericFamilies`
   (`$lib/db/adminColumns`) names an explicit schema's families by their
   suffix, and `groupFamiliesByLevel`, or `fallbackFamilies` when no
   naming anchor exists, groups auto-detected ones.
   `levelCodeColumns` gives a constant root, which has no group-by column,
   the member of the next level's code family, so a bare `adm0` lands
   under `code` beside `adm1`/`adm2`, not under `name`.
   `checkGenericNames` throws when two families reduce to one name.
3. **Per-level dissolve and point extraction**
   (`pipeline/index.ts`'s `buildLevelOutput`) - dissolves via
   `package-polygons/pipeline/dissolveCore.ts`'s `runDissolveCore`,
   keeping only the level's group-by and own identity columns, checks
   the dissolved row count against the input's own distinct group-by
   tuple count, computes `(ST_MaximumInscribedCircle(geom)).center` per
   row, stamps the depth column (an input column of that name, such as
   Schema Fill's real-depth stamp, is left out of the input first), and
   verifies every point is `ST_Covers`-ed by its own source polygon.
4. **Rename and combine** - each level's own identity columns are renamed
   to their generic names, then every level's points table is combined
   via `UNION ALL BY NAME`. The output schema is fixed (geometry, identity
   columns, depth), since any other attribute stays on the polygons and
   joins back by code and depth.

## Why `ST_MaximumInscribedCircle`, not the centroid

`ST_Centroid` is a purely geometric average of a polygon's area and can
land outside the polygon itself for a concave shape, or on open water
between two islands for a multi-part one. `ST_MaximumInscribedCircle`'s
`center` is always interior to the polygon (the center of the largest
circle that fits inside it), the standard technique for keeping a
web-map label anchored on its own territory.
