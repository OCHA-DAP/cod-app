"""Paths and settings for the global COD-AB build."""

import os
from pathlib import Path

BUILD = Path("tmp/global")
EXPLORER = Path(os.environ.get("CATALOG", "catalog")) / "explorer"
ADM0_CATALOG = Path(os.environ.get("ADM0_CATALOG", "../adm0-app/catalog"))
# Read-only: OCHA picks take their extended geometry from its extended/ tier.
COD_AB_CATALOG = Path(
    os.environ.get("COD_AB_CATALOG", "../hdx-scraper-cod-ab-global/portolan")
)
MAX_LVL = 4
WORKERS = 2
THREADS = max(1, (os.cpu_count() or 4) // (2 * WORKERS))

NAME_FIELD = "adm{n}_name"
CODE_FIELD = "adm{n}_pcode"
MATCH_KEY = "match_key"
# Share of the level-1 area a level must cover to count as the source's depth.
FULL_COVER = 0.99
# Depth per (iso3, source) where the deeper level leaves out only a lake or salt flat,
# filled by the cod-ab extended layer (OCHA) or edge-extend (others).
DEPTH = {("ARM", "ocha"): 2, ("BOL", "ocha"): 3, ("MWI", "ocha"): 3, ("RWA", "wfp"): 3}

# ADM0 candidates in adm0-app's catalog: file, iso3, row name.
ADM0_LAYERS = {
    "fieldmaps": (
        "fieldmaps/fieldmaps_polygons/fieldmaps_polygons.parquet",
        "iso_3",
        "adm0_name",
    ),
    "improved": ("build/build_adm0.parquet", "iso3", "name"),
    "gaul": ("gaul/gaul_l0/gaul_l0.parquet", "upper(ISO3_CODE)", "GAUL0_NAME"),
}
# FieldMaps ADM0 parts that the source covers; the iso3's other parts get the ADM0 fill.
PARTS_LAYER = "fieldmaps/fieldmaps_polygons/fieldmaps_polygons.parquet"
# topo_clean maximum_gap_width (degrees) per iso3, for sources' needle gaps above the default fill.
GAP_WIDTH = {"BRA": "1e-7"}
# iso3s whose source fills name1 at every level but leaves name blank below adm1.
PRIMARY_NAME1 = {"CMR"}
PARTS = {"AUS": ["AUS_1"], "JAM": ["JAM_1"], "MUS": ["MUS_1"], "ZAF": ["ZAF_1"]}
