"""Build the site's portolan catalog in catalog/ and optionally push it to PORTOLAN_REMOTE."""

import argparse
import runpy
import sys
from datetime import UTC, datetime
from pathlib import Path

import fieldmaps_publish
from common import CATALOG, apply_titles, tile_parquet

HERE = Path(__file__).parent
EXPLORER = HERE / "explorer"
EXPLORER_STEPS = [
    "m49.py",
    "plan_status.py",
    "iso3166.py",
    "mapbox_boundaries.py",
    "office_type.py",
    "wfp.py",
    "unhcr.py",
    "ungeodata.py",
    "fao.py",
    "unicef.py",
    "ocha.py",
    "provenance.py",
    "stats.py",
    "match.py",
    "comparison.py",
    "bbox.py",
]
STEPS = [Path(s).stem for s in EXPLORER_STEPS] + ["tools"]
TOOLS = CATALOG / "tools"
CACHE = Path("tmp/catalog/cache")
DEMO_DATETIME = "2025-01-01"
SOURCES_DATETIME = "2025-01-01"


def run_explorer_step(script: str) -> None:
    path = EXPLORER / script
    sys.argv = [str(path)]
    runpy.run_path(str(path), run_name="__main__")


def build_tools(*, refetch: bool, detect: bool) -> None:
    from annotate_nld import annotate_catalog
    from build_demo import build as build_demo
    from build_nld import build as build_nld

    build_nld(TOOLS.resolve(), CACHE, refetch=refetch, detect_issues=detect)
    annotate_catalog(TOOLS.resolve(), CACHE, metadata_only=True)
    build_demo(TOOLS.resolve(), CACHE / "demo")


def collections(parent: Path) -> list[Path]:
    return sorted(
        p
        for p in parent.glob("*/*/")
        if not p.name.startswith(".") and not p.parent.name.startswith(".")
    )


def download_date(collection: Path) -> str:
    mtime = (collection / f"{collection.name}.parquet").stat().st_mtime
    return datetime.fromtimestamp(mtime, UTC).date().isoformat()


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
    fieldmaps_publish.add(CATALOG, rel, "--datetime", datetime_)


def add_all() -> None:
    for collection in collections(CATALOG / "explorer"):
        add(collection, download_date(collection))
    from build_nld import YEARS

    for year in YEARS:
        add(TOOLS / "nld" / str(year), f"{year}-01-01")
    for demo in sorted((TOOLS / "nld" / "demo").iterdir()):
        if (demo / ".portolan").is_dir():
            add(demo, DEMO_DATETIME)
    add(TOOLS / "sources", SOURCES_DATETIME)


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
    sys.path[:0] = [str(HERE / "tools"), str(EXPLORER)]

    steps = [] if args.skip_build else args.step or STEPS
    for script in EXPLORER_STEPS:
        if Path(script).stem in steps:
            run_explorer_step(script)
    if "tools" in steps:
        build_tools(refetch=args.refetch, detect=args.detect)

    from annotate_nld import annotate_catalog

    run_explorer_step("metadata.py")
    annotate_catalog(TOOLS.resolve(), CACHE, metadata_only=True)
    tile_tools(force=args.force_pmtiles)
    add_all()

    annotate_catalog(TOOLS.resolve(), CACHE)
    apply_titles(CATALOG)
    fieldmaps_publish.run(CATALOG, "readme")
    fieldmaps_publish.run(CATALOG, "check", "--fix", "--data-scope", "local")
    if args.push:
        fieldmaps_publish.push(CATALOG)


if __name__ == "__main__":
    main()
