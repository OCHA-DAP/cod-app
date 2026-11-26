"""Stage the global build: adm{n}-{geom} collections in catalog/global/, one collection per location in
catalog/iso3/<iso3>/, and each picked location's source layers in catalog/source/<iso3>/."""

import hashlib
import json
import shutil
import tempfile
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
from cod_data.catalog.global_build import merge, schema
from cod_data.catalog.global_build.adm0 import write_parents
from cod_data.catalog.global_build.build import (
    digests,
    fingerprint,
    is_built,
    valid_from,
)
from cod_data.catalog.global_build.build import inputs as picks_and_iso3s
from cod_data.catalog.global_build.config import (
    BUILD,
    BUILD_ID_FILE,
    FINGERPRINT_FILE,
    GLOBAL_ROW_GROUP,
    MAX_LVL,
    PROD_THREADS,
    VALID_FROM_FILE,
    VERSION_FILE,
)
from cod_data.shared.geoparquet import HILBERT, write_geoparquet

GLOBAL = CATALOG / "global"
ISO3 = CATALOG / "iso3"
SOURCE = CATALOG / "source"
TIERS = ("original", "extended")
# The ADM0 layer the published build is edge-matched to.
ADM0 = "improved"
GEOMS = ("polygons", "points", "lines")
LAYERS = list(product(range(1, MAX_LVL + 1), GEOMS))
ISO3_ROW_GROUP = "8MB"
# A location's lines follow the Hilbert curve over its own extent, which splits small
# locations into compact row groups where the world curve can straddle them.
LOCAL_HILBERT = "ST_Hilbert(geometry, ST_Extent(ST_Extent_Agg(geometry) OVER ()))"
# Polygons and points by P-code, so a level's global polygons are the merged file as is.
ORDER = {"polygons": "adm{n}_pcode", "points": "pcode", "lines": HILBERT}
# Digest per location of what its iso3 layers were last staged from.
STAGED = BUILD / ADM0 / "staged.json"
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


def newer(path: Path, *inputs: Path) -> bool:
    """Whether path exists and is at least as new as every existing input."""
    return path.exists() and all(
        path.stat().st_mtime >= i.stat().st_mtime for i in inputs if i.exists()
    )


def inputs(n: int, geom: str, polygons: Path, points: Path, lines: Path) -> list[Path]:
    """The files layer_sql reads for geom at level n."""
    return {"polygons": [polygons], "points": [points, polygons], "lines": [lines]}[
        geom
    ]


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
        files = (
            src / f"adm{n}_polygons.parquet",
            src / "points.parquet",
            src / "lines.parquet",
        )
        collection.mkdir(parents=True, exist_ok=True)
        stale = not newer(parquet, *inputs(n, geom, *files))
        if stale and geom == "polygons":
            tmp = parquet.with_name(f".{parquet.name}")
            shutil.copy2(files[0], tmp)
            tmp.replace(parquet)
        elif stale:
            query = layer_sql(n, geom, *(f"'{f}'" for f in files))
            write(con, query, parquet, ORDER[geom], GLOBAL_ROW_GROUP)
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


def column_description(col: str, level: bool) -> str | None:
    """The schema's description of a layer column; lines carry a_/b_ fields for the units on each side."""
    if col == "level":
        return schema.description(col) if level else None
    if col[:2] in ("a_", "b_") and (d := schema.description(col[2:])):
        return f"Unit on side {col[0]}. {d}"
    return schema.description(col)


def describe_columns() -> None:
    """Fill each global, iso3 and source collection's table:columns descriptions from the schema."""
    for path in [
        *GLOBAL.glob("adm*-*/collection.json"),
        *ISO3.glob("*/collection.json"),
        *SOURCE.glob("*/collection.json"),
    ]:
        stac = json.loads(path.read_text())
        # Lines' level is the boundary's, and iso3 collections mix lines with the rest.
        level = path.parent.parent == GLOBAL and not path.parent.name.endswith("-lines")
        for c in stac.get("table:columns", []):
            if d := column_description(c["name"], level):
                c["description"] = d
        path.write_text(json.dumps(stac, indent=2, ensure_ascii=False) + "\n")


def write_stats(con: duckdb.DuckDBPyConnection) -> None:
    """Write global/stats.json for the home page: ISO3 locations (no X-codes) and native units per level."""
    polygons = {
        n: GLOBAL / f"adm{n}-polygons" / f"{name(n, 'polygons')}.parquet"
        for n in range(1, MAX_LVL + 1)
    }
    locations = con.execute(
        f"SELECT count(DISTINCT adm0_pcode) FROM '{polygons[1]}' WHERE adm0_pcode NOT LIKE 'X%'"
    ).fetchall()[0][0]
    units = {
        str(n): con.execute(f"SELECT count(*) FROM '{p}' WHERE level = {n}").fetchall()[
            0
        ][0]
        for n, p in polygons.items()
    }
    stats = {"locations": locations, "units": units}
    (GLOBAL / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")


def staged_digest(folder: Path) -> str:
    """Hash of a location's build, its date and the code that merges and cuts it."""
    h = hashlib.sha256()
    for f in (folder / BUILD_ID_FILE, folder / VALID_FROM_FILE):
        h.update(f.read_bytes())
    for f in (*merge.CODE, Path(__file__)):
        h.update(f.read_bytes())
    return h.hexdigest()


def stage_iso3(con: duckdb.DuckDBPyConnection, notes: str) -> None:
    src = BUILD / ADM0
    work = src / "iso3"
    staged = json.loads(STAGED.read_text()) if STAGED.exists() else {}
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
            print(f"iso3/{old.name}: no longer built, removing")
            shutil.rmtree(old)
            staged.pop(old.name.upper(), None)
    restaged = 0
    for iso3, adm0_name in sorted(names.items()):
        folder = ISO3 / iso3.lower()
        folder.mkdir(parents=True, exist_ok=True)
        digest = staged_digest(work / iso3.lower())
        parquets = {(n, g): folder / f"{name(n, g)}.parquet" for n, g in LAYERS}
        if staged.get(iso3) != digest or not all(p.exists() for p in parquets.values()):
            restaged += 1
            for (n, geom), parquet in parquets.items():
                source = src / f"adm{n}_polygons.parquet"
                points, lines = (
                    work / iso3.lower() / f"{g}.parquet" for g in GEOMS[1:]
                )
                polygons = f"(SELECT * FROM '{source}' WHERE adm0_pcode = '{iso3}')"
                query = layer_sql(n, geom, polygons, f"'{points}'", f"'{lines}'")
                order = LOCAL_HILBERT if geom == "lines" else ORDER[geom].format(n=n)
                write(con, query, parquet, order, ISO3_ROW_GROUP)
            for n in range(1, MAX_LVL + 1):
                check(con, *(parquets[(n, g)] for g in GEOMS[:2]), n)
            staged[iso3] = digest
            STAGED.write_text(json.dumps(staged, indent=1, sort_keys=True) + "\n")
        for (n, geom), parquet in parquets.items():
            tile(con, parquet, name(n, geom))
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
                "license_url": "../TERMS.md",
            },
        )
    print(f"iso3: restaged {restaged} of {len(names)} locations")


def stage_source(con: duckdb.DuckDBPyConnection, notes: str) -> None:
    """Copy each picked location's source layers into source/<iso3>/."""
    work = BUILD / ADM0 / "iso3"
    staged = json.loads(STAGED.read_text()) if STAGED.exists() else {}
    picks = dict(
        con.execute(f"SELECT iso3, selected_source FROM {DECISIONS}").fetchall()
    )
    built = {
        p.name.upper()
        for p in work.glob("*/")
        if (p / "source_original.parquet").exists() and p.name.upper() in picks
    }
    for old in sorted(p for p in SOURCE.glob("*/") if not p.name.startswith(".")):
        if old.name.upper() not in built:
            print(f"source/{old.name}: no longer picked, removing")
            shutil.rmtree(old)
            staged.pop(f"source/{old.name.upper()}", None)
    restaged = 0
    for iso3 in sorted(built):
        key, src = iso3.lower(), picks[iso3]
        folder = SOURCE / key
        folder.mkdir(parents=True, exist_ok=True)
        digest = staged_digest(work / key)
        layers = {t: folder / f"{key}_{t}.parquet" for t in TIERS}
        if staged.get(f"source/{iso3}") != digest or not all(
            p.exists() for p in layers.values()
        ):
            restaged += 1
            for tier, out in layers.items():
                shutil.copyfile(work / key / f"source_{tier}.parquet", out)
            staged[f"source/{iso3}"] = digest
            STAGED.write_text(json.dumps(staged, indent=1, sort_keys=True) + "\n")
        label = PARTNERS.get(src, {}).get("provider", src)
        write_yaml(
            folder / ".portolan" / "metadata.yaml",
            {
                "title": f"{iso3} source layers",
                "description": f"The picked source's admin boundaries for {iso3}, cleaned and coded to the COD-AB Specification ({key}_original), and the same units extended past the coastline and borders, not yet edge-matched ({key}_extended). Source: {label}.",
                "providers": [PROVIDER],
                "processing_notes": notes,
                "keywords": [iso3, src],
                "license": "other",
                "license_url": "../TERMS.md",
            },
        )
    print(f"source: restaged {restaged} of {len(built)} locations")


def stale(adm0: str) -> list[str]:
    """Locations whose build is missing or behind its current inputs and date, or that the merge and ADM0 layer disagree on."""
    out = BUILD / adm0
    con = connect(threads=PROD_THREADS)
    try:
        with tempfile.TemporaryDirectory(dir=out) as tmp:
            parents = Path(tmp) / "parents.parquet"
            write_parents(con, adm0, parents)
            picks, iso3s = picks_and_iso3s(con, parents)
            rows = digests(con, parents, set(picks.values()))
        merged_iso3s = {
            r[0]
            for r in con.execute(
                f"SELECT DISTINCT adm0_pcode FROM '{out / 'adm1_polygons.parquet'}'"
            ).fetchall()
        }
    finally:
        con.close()
    folders = {i: out / "iso3" / i.lower() for i in iso3s}
    behind = [
        i
        for i in iso3s
        if not is_built(folders[i])
        or (folders[i] / FINGERPRINT_FILE).read_text()
        != fingerprint(i, picks.get(i), rows)
        or (folders[i] / VALID_FROM_FILE).read_text() != valid_from(picks.get(i), i)
    ]
    return sorted({*behind, *(merged_iso3s ^ set(iso3s))})


def stage() -> None:
    """Write each layer when the build is newer, tile it, and write its metadata."""
    if not merge.current(BUILD / ADM0):
        raise RuntimeError(
            "merged layers don't match the current builds: run the build"
        )
    if behind := stale(ADM0):
        raise RuntimeError(f"builds behind their inputs, run the build: {behind}")
    record = BUILD / ADM0 / VERSION_FILE
    built_with = f" {record.read_text()}" if record.exists() else ""
    notes = f"Built with topo-tools{built_with}. Each location's picked source is cleaned, extended and edge-matched to a global ADM0 layer, coded to the COD-AB Specification, then tiled with tylertoo to zoom {TILE_MAX_ZOOM} with every feature kept at every zoom."
    write_yaml(
        GLOBAL / ".portolan" / "metadata.yaml",
        {
            "title": "Global COD-AB layers",
            "description": "Admin 1 to 4 polygons, label points and boundary lines for every location, built from each location's pick in the Boundaries Explorer and edge-matched with no gaps or overlaps. Each layer covers the world. The same layers cut by location are in iso3/.",
        },
    )
    write_yaml(
        ISO3 / ".portolan" / "metadata.yaml",
        {
            "title": "Global COD-AB layers by location",
            "description": "The global layers cut by ISO3 code, one collection per location.",
        },
    )
    write_yaml(
        SOURCE / ".portolan" / "metadata.yaml",
        {
            "title": "Source layers by location",
            "description": "Each location's picked source before edge-matching: cleaned and coded originals, and the same units extended. Locations with no pick have no folder.",
        },
    )
    for folder in (GLOBAL, ISO3, SOURCE):
        (folder / "TERMS.md").write_text(
            f"# Terms\n\nThe layers in `{folder.name}/` combine admin boundaries published by several producers, one per location, as picked in the Boundaries Explorer. {TERMS}\n"
        )
    con = connect(threads=PROD_THREADS)
    try:
        stage_global(con, notes)
        write_stats(con)
        stage_iso3(con, notes)
        stage_source(con, notes)
    finally:
        con.close()
