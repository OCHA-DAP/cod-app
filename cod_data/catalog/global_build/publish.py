"""Stage the global build in catalog/global/: adm{n}-{geom} collections and one iso3/<iso3>/ collection per location."""

import shutil
from itertools import product
from pathlib import Path

import duckdb

from cod_data.catalog.common import (
    CATALOG,
    DECISIONS,
    HOST,
    PARTNERS,
    TILE_MAX_ZOOM,
    connect,
    tile_parquet,
    write_yaml,
)
from cod_data.catalog.global_build.config import BUILD, MAX_LVL, VERSION_FILE
from cod_data.shared.geoparquet import HILBERT, write_geoparquet

GLOBAL = CATALOG / "global"
ISO3 = GLOBAL / "iso3"
# The ADM0 layer the published build is edge-matched to.
ADM0 = "improved"
GEOMS = ("polygons", "points", "lines")
LAYERS = list(product(range(1, MAX_LVL + 1), GEOMS))
GLOBAL_ROW_GROUP = "32MB"
ISO3_ROW_GROUP = "8MB"
# A location's layers follow the Hilbert curve over its own extent, which splits small
# locations into compact row groups where the world curve can straddle them.
LOCAL_HILBERT = "ST_Hilbert(geometry, ST_Extent(ST_Extent_Agg(geometry) OVER ()))"
PROVIDER = {**HOST, "roles": ["producer", "processor", "host"]}
TERMS = "Each producer's terms of use apply to its locations. Check them before reusing the data."
DESCRIPTIONS = {
    "polygons": "Admin {n} units as GeoParquet, with polygon tiles. A location with fewer levels repeats its deepest units, and area no unit covers is its admin 0 unit.",
    "points": "One label point per admin {n} unit, at the center of the unit's maximum inscribed circle, as GeoParquet with point tiles.",
    "lines": "Shared and exterior boundary lines of admin levels 1 to {n}, each with the units on either side and its level, as GeoParquet with line tiles.",
}


def name(n: int, geom: str) -> str:
    return f"adm{n}_{geom}"


def built() -> bool:
    """Whether tmp/global/ holds a merged build for ADM0."""
    files = [f"adm{n}_polygons" for n in range(1, MAX_LVL + 1)] + ["points", "lines"]
    return all((BUILD / ADM0 / f"{f}.parquet").exists() for f in files)


def newer(path: Path, than: Path) -> bool:
    return path.exists() and path.stat().st_mtime >= than.stat().st_mtime


def layer_sql(n: int, geom: str, polygons: str, points: str, lines: str) -> str:
    """Level-n rows of geom; points take the level of their polygon."""
    return {
        "polygons": f"SELECT * FROM {polygons}",
        "points": f"""SELECT p.* EXCLUDE (adm_lvl), g.level FROM {points} p
            JOIN (SELECT adm{n}_pcode, level FROM {polygons}) g ON p.pcode = g.adm{n}_pcode
            WHERE p.adm_lvl = {n}""",
        "lines": f"SELECT * EXCLUDE (adm_lvl), adm_lvl AS level FROM {lines} WHERE adm_lvl <= {n}",
    }[geom]


def write(
    con: duckdb.DuckDBPyConnection, query: str, out: Path, order: str, row_group: str
) -> None:
    """Write query to out in order, through a hidden copy so a failed run leaves no half file."""
    tmp = out.with_name(f".{out.name}")
    write_geoparquet(con, query, tmp, order, row_group)
    tmp.replace(out)


def tile(con: duckdb.DuckDBPyConnection, parquet: Path, layer: str) -> None:
    """Tile parquet when its tiles are missing or older, tiles moving in only once whole."""
    pmtiles = parquet.with_suffix(".pmtiles")
    if newer(pmtiles, parquet):
        return
    rows = con.execute(
        f"SELECT num_rows FROM parquet_file_metadata('{parquet}')"
    ).fetchall()[0][0]
    if not rows:
        pmtiles.unlink(missing_ok=True)
        return
    tmp = pmtiles.with_name(f".{pmtiles.name}")
    tile_parquet(parquet, tmp, layer)
    tmp.replace(pmtiles)


def check(con: duckdb.DuckDBPyConnection, poly: Path, pts: Path, n: int) -> None:
    """Raise unless level-n points pair 1:1 with polygons by P-code."""
    n_poly, n_pts, n_orphan = con.execute(f"""
        SELECT (SELECT count(*) FROM '{poly}'), (SELECT count(*) FROM '{pts}'),
            (SELECT count(*) FROM '{pts}' p ANTI JOIN '{poly}' g ON p.pcode = g.adm{n}_pcode)
    """).fetchall()[0]
    if n_poly != n_pts or n_orphan:
        msg = f"{poly}: {n_poly} polygons, {n_pts} points, {n_orphan} without a polygon"
        raise ValueError(msg)


def stage_global(con: duckdb.DuckDBPyConnection, notes: str) -> None:
    src = BUILD / ADM0
    for n, geom in LAYERS:
        collection = GLOBAL / f"adm{n}-{geom}"
        parquet = collection / f"{name(n, geom)}.parquet"
        source = src / (
            f"adm{n}_polygons.parquet" if geom == "polygons" else f"{geom}.parquet"
        )
        collection.mkdir(parents=True, exist_ok=True)
        if not newer(parquet, source):
            polygons = f"'{src}/adm{n}_polygons.parquet'"
            query = layer_sql(
                n, geom, polygons, f"'{src}/points.parquet'", f"'{src}/lines.parquet'"
            )
            write(con, query, parquet, HILBERT, GLOBAL_ROW_GROUP)
        tile(con, parquet, name(n, geom))
        write_yaml(
            collection / ".portolan" / "metadata.yaml",
            {
                "title": f"Global admin {n} {geom}",
                "description": f"{DESCRIPTIONS[geom].format(n=n)} Covers every location.",
                "providers": [PROVIDER],
                "processing_notes": notes,
                "license": "other",
                "license_url": "../TERMS.md",
            },
        )
    for n in range(1, MAX_LVL + 1):
        poly, pts = (
            GLOBAL / f"adm{n}-{g}" / f"{name(n, g)}.parquet" for g in GEOMS[:2]
        )
        check(con, poly, pts, n)


def stage_iso3(con: duckdb.DuckDBPyConnection, notes: str) -> None:
    src = BUILD / ADM0
    work = src / "iso3"
    picks = dict(
        con.execute(f"SELECT iso3, selected_source FROM {DECISIONS}").fetchall()
    )
    names = dict(
        con.execute(
            f"SELECT adm0_pcode, any_value(adm0_name) FROM '{src}/adm1_polygons.parquet' GROUP BY 1"
        ).fetchall()
    )
    for old in sorted(
        p for p in ISO3.glob("*/") if p.is_dir() and not p.name.startswith(".")
    ):
        if old.name.upper() not in names:
            print(f"global/iso3/{old.name}: no longer built, removing")
            shutil.rmtree(old)
    for iso3, adm0_name in sorted(names.items()):
        folder = ISO3 / iso3.lower()
        folder.mkdir(parents=True, exist_ok=True)
        for n, geom in LAYERS:
            parquet = folder / f"{name(n, geom)}.parquet"
            source = src / f"adm{n}_polygons.parquet"
            if not newer(parquet, source):
                polygons = f"(SELECT * FROM '{source}' WHERE adm0_pcode = '{iso3}')"
                query = layer_sql(
                    n,
                    geom,
                    polygons,
                    f"'{work / iso3.lower() / 'points.parquet'}'",
                    f"'{work / iso3.lower() / 'lines.parquet'}'",
                )
                write(con, query, parquet, LOCAL_HILBERT, ISO3_ROW_GROUP)
            tile(con, parquet, name(n, geom))
        for n in range(1, MAX_LVL + 1):
            check(con, *(folder / f"{name(n, g)}.parquet" for g in GEOMS[:2]), n)
        pick = picks.get(iso3)
        label = PARTNERS.get(pick, {}).get("provider") if pick else None
        source = f" Source: {label}." if label else ""
        write_yaml(
            folder / ".portolan" / "metadata.yaml",
            {
                "title": f"{adm0_name} ({iso3}) COD-AB layers",
                "description": f"Admin levels 1 to {MAX_LVL}, each with polygons, label points and boundary lines, edge-matched to the global layers.{source} Parts no source covers repeat their admin 0 area at every level.",
                "providers": [PROVIDER],
                "processing_notes": notes,
                "keywords": [iso3, *([pick] if pick else [])],
                "license": "other",
                "license_url": "../../TERMS.md",
            },
        )


def stage() -> None:
    """Write each layer when the build is newer, tile it, and write its metadata."""
    record = BUILD / ADM0 / VERSION_FILE
    built_with = f" {record.read_text()}" if record.exists() else ""
    notes = f"Built with topo-tools{built_with}. Each location's picked source is cleaned, extended and edge-matched to a global ADM0 layer, coded to the COD-AB Specification, then tiled with tylertoo to zoom {TILE_MAX_ZOOM} with every feature kept at every zoom."
    write_yaml(
        GLOBAL / ".portolan" / "metadata.yaml",
        {
            "title": "Global COD-AB layers",
            "description": "Admin 1 to 4 polygons, label points and boundary lines for every location, built from each location's pick in the Boundaries Explorer and edge-matched with no gaps or overlaps. Each layer covers the world, and iso3/ holds the same layers cut by location.",
        },
    )
    write_yaml(
        ISO3 / ".portolan" / "metadata.yaml",
        {
            "title": "Global COD-AB layers by location",
            "description": "The global layers cut by ISO3 code, one collection per location.",
        },
    )
    (GLOBAL / "TERMS.md").write_text(
        f"# Terms\n\nThe layers in `global/` combine admin boundaries published by several producers, one per location, as picked in the Boundaries Explorer. {TERMS}\n"
    )
    con = connect()
    try:
        stage_global(con, notes)
        stage_iso3(con, notes)
    finally:
        con.close()
