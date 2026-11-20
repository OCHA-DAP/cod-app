"""Build the site's portolan catalog in catalog/ and optionally push it to PORTOLAN_REMOTE."""

import argparse
import re
import runpy
import sys
from datetime import UTC, datetime
from pathlib import Path

from cod_data.catalog import source_publish
from cod_data.catalog.common import CATALOG, apply_titles, tile_parquet

HERE = Path(__file__).parent
EXPLORER = HERE / "explorer"
EXPLORER_STEPS = [
    "m49",
    "plan_status",
    "iso3166",
    "mapbox_boundaries",
    "office_type",
    "wfp",
    "unhcr",
    "basemap",
    "fao",
    "unicef",
    "erm",
    "ocha",
    "provenance",
    "stats",
    "match",
    "comparison",
    "bbox",
]
STEPS = [*EXPLORER_STEPS, "tools", "global"]
TOOLS = CATALOG / "tools"
CACHE = Path("tmp/catalog/cache")
DEMO_DATETIME = "2025-01-01"
SOURCES_DATETIME = "2025-01-01"


def run_explorer_step(step: str) -> None:
    module = f"cod_data.catalog.explorer.{step}"
    sys.argv = [module]
    runpy.run_module(module, run_name="__main__", alter_sys=True)


def build_tools(*, refetch: bool, detect: bool) -> None:
    from cod_data.catalog.tools.annotate_nld import annotate_catalog
    from cod_data.catalog.tools.build_demo import build as build_demo
    from cod_data.catalog.tools.build_nld import build as build_nld

    build_nld(TOOLS.resolve(), CACHE, refetch=refetch, detect_issues=detect)
    annotate_catalog(TOOLS.resolve(), CACHE, metadata_only=True)
    build_demo(TOOLS.resolve(), CACHE / "demo")


def collections(parent: Path) -> list[Path]:
    return sorted(
        p
        for p in parent.glob("*/*/")
        if not p.name.startswith(".") and not p.parent.name.startswith(".")
    )


def file_date(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC).date().isoformat()


def download_date(collection: Path) -> str:
    return file_date(collection / f"{collection.name}.parquet")


def tile_tools(*, force: bool) -> None:
    """Tile each tools parquet as <stem>.pmtiles, layer <stem>, when missing or older."""
    for parquet in sorted(TOOLS.rglob("*.parquet")):
        if ".portolan" in parquet.parts:
            continue
        pmtiles = parquet.with_suffix(".pmtiles")
        if (
            force
            or not pmtiles.exists()
            or pmtiles.stat().st_mtime < parquet.stat().st_mtime
        ):
            tile_parquet(parquet, pmtiles, parquet.stem)


def add(collection: Path, datetime_: str) -> None:
    rel = collection.relative_to(CATALOG).as_posix()
    source_publish.add(CATALOG, rel, "--datetime", datetime_)


def add_all() -> None:
    # portolan won't register the tiles-only base map, which the push uploads anyway.
    for collection in collections(CATALOG / "explorer"):
        if (collection / f"{collection.name}.parquet").exists():
            add(collection, download_date(collection))
    from cod_data.catalog.tools.build_nld import YEARS

    for year in YEARS:
        add(TOOLS / "nld" / str(year), f"{year}-01-01")
    for demo in sorted((TOOLS / "nld" / "demo").iterdir()):
        if (demo / ".portolan").is_dir():
            add(demo, DEMO_DATETIME)
    add(TOOLS / "sources", SOURCES_DATETIME)
    from cod_data.catalog.global_build.publish import GLOBAL, ISO3

    for collection in [*sorted(GLOBAL.glob("adm*-*/")), *sorted(ISO3.glob("[a-z]*/"))]:
        parquet = next(collection.glob("adm[1-4]_*.parquet"), None)
        if parquet:
            add(collection, file_date(parquet))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--step",
        action="append",
        choices=STEPS,
        help="Run only these build steps (repeatable). Default: every step.",
    )
    parser.add_argument(
        "--skip-build", action="store_true", help="Only register, check and push"
    )
    parser.add_argument(
        "--refetch", action="store_true", help="Re-download the NLD GeoPackages"
    )
    parser.add_argument(
        "--detect", action="store_true", help="Add topo-detect counts to NLD"
    )
    parser.add_argument(
        "--force-pmtiles", action="store_true", help="Rebuild the tools tiles"
    )
    parser.add_argument("--push", action="store_true", help="Push to PORTOLAN_REMOTE")
    args = parser.parse_args()

    steps = [] if args.skip_build else args.step or STEPS
    for step in EXPLORER_STEPS:
        if step in steps:
            run_explorer_step(step)
    if "tools" in steps:
        build_tools(refetch=args.refetch, detect=args.detect)
    if "global" in steps:
        from cod_data.catalog.global_build import publish

        if publish.built():
            publish.stage()
        else:
            print(f"global: no merged build for {publish.ADM0}, skipping it")

    from cod_data.catalog.tools.annotate_nld import annotate_catalog

    run_explorer_step("metadata")
    annotate_catalog(TOOLS.resolve(), CACHE, metadata_only=True)
    tile_tools(force=args.force_pmtiles)
    add_all()

    annotate_catalog(TOOLS.resolve(), CACHE)
    apply_titles(CATALOG)
    source_publish.run(CATALOG, "readme")
    check = source_publish.run(
        CATALOG, "check", "--fix", "--data-scope", "local", strict=False
    )
    # Global polygons keep P-code order, which PTL-DAT-006 flags in large files.
    if errors := [
        e
        for e in check["errors"]
        if not (
            e.get("type") == "PTL-DAT-006"
            and re.search(r"asset 'adm\d_polygons'", e.get("message", ""))
        )
    ]:
        raise RuntimeError(f"portolan check failed: {errors}")
    if args.push:
        source_publish.push(CATALOG)


if __name__ == "__main__":
    main()
