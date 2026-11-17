"""Stage each built global layer set in catalog/global/<adm0>/ as one collection per layer, with tiles."""

import shutil
from pathlib import Path

from cod_data.catalog.common import (
    CATALOG,
    HOST,
    PRODUCER_TERMS,
    TILE_MAX_ZOOM,
    tile_parquet,
    write_yaml,
)
from cod_data.catalog.global_build.config import BUILD, VERSION_FILE

GLOBAL = CATALOG / "global"
# ADM0 layers whose global build the catalog publishes.
PUBLISH = ("improved",)
LAYERS = {
    **{f"adm{n}": f"adm{n}_polygons" for n in range(1, 5)},
    "points": "points",
    "lines": "lines",
}
DESCRIPTIONS = {
    **{
        f"adm{n}": (
            f"Global admin {n}",
            f"Admin {n} units for every location as GeoParquet, with polygon tiles. A location with fewer levels repeats its deepest units here.",
        )
        for n in range(1, 5)
    },
    "points": (
        "Global label points",
        "One label point per unit and level, at the center of the unit's maximum inscribed circle, as GeoParquet with point tiles.",
    ),
    "lines": (
        "Global boundary lines",
        "Shared and exterior boundary lines between units, each with the units on either side, as GeoParquet with line tiles.",
    ),
}
PROVIDER = {**HOST, "roles": ["producer", "processor", "host"]}


def built() -> list[str]:
    """ADM0 layers in PUBLISH with a merged build in tmp/global/."""
    return [
        a
        for a in PUBLISH
        if all((BUILD / a / f"{s}.parquet").exists() for s in LAYERS.values())
    ]


def newer(path: Path, than: Path) -> bool:
    return path.exists() and path.stat().st_mtime >= than.stat().st_mtime


def stage(adm0: str) -> None:
    """Copy each layer in when the build is newer, tile it, and write its metadata."""
    record = BUILD / adm0 / VERSION_FILE
    built_with = f" {record.read_text()}" if record.exists() else ""
    write_yaml(
        GLOBAL / ".portolan" / "metadata.yaml",
        {
            "title": "Global COD-AB layers",
            "description": "Global admin boundary layers built from each location's pick in the Boundaries Explorer, one catalog per ADM0 layer they are edge-matched to.",
        },
    )
    (GLOBAL / "TERMS.md").write_text(
        "# Terms\n\nThe layers in `global/` combine admin boundaries published by several producers, one per location, as picked in the Boundaries Explorer. Each producer's terms of use apply to its locations. Check them before reusing the data.\n"
    )
    write_yaml(
        GLOBAL / adm0 / ".portolan" / "metadata.yaml",
        {
            "title": f"Global COD-AB, {adm0} ADM0",
            "description": f"Admin 1 to 4 polygons, label points and boundary lines for every location, edge-matched to the {adm0} ADM0 layer, with no gaps or overlaps.",
        },
    )
    for layer, source in LAYERS.items():
        name = f"{adm0}_{layer}"
        collection = GLOBAL / adm0 / name
        collection.mkdir(parents=True, exist_ok=True)
        src, parquet = (
            BUILD / adm0 / f"{source}.parquet",
            collection / f"{name}.parquet",
        )
        pmtiles = parquet.with_suffix(".pmtiles")
        # Hidden copies move in only once whole, tiles first, so a failed run redoes them.
        staged = parquet if newer(parquet, src) else collection / f".{name}.parquet"
        if staged != parquet:
            shutil.copy2(src, staged)
        if staged != parquet or not newer(pmtiles, parquet):
            tiles = collection / f".{name}.pmtiles"
            tile_parquet(staged, tiles, name)
            tiles.replace(pmtiles)
        staged.replace(parquet)
        title, description = DESCRIPTIONS[layer]
        write_yaml(
            collection / ".portolan" / "metadata.yaml",
            {
                "title": title,
                "description": description,
                "providers": [PROVIDER],
                "processing_notes": f"Built with topo-tools{built_with}. Each location's picked source is cleaned, extended and edge-matched to the {adm0} ADM0 layer, coded to the COD-AB Specification, then tiled with tylertoo to zoom {TILE_MAX_ZOOM} with every feature kept at every zoom.",
                **PRODUCER_TERMS,
            },
        )
