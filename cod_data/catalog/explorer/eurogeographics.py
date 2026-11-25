"""EuroGeographics EuroRegionalMap and EuroGlobalMap admin 1-4 boundaries, dissolved per
level from the original-tier ERM and EGM layers in a local fieldmaps/subnational checkout."""

import sys

from cod_data.catalog.explorer.boundaries import write_boundary
from cod_data.catalog.explorer.subnational import (
    ARCHIVE,
    SOURCE,
    check_all,
    dissolved,
    rows,
)

SRCS = ["erm", "egm"]
LEVELS = (1, 2, 3, 4)


def layers() -> list[tuple[str, int, str, str]]:
    """The catalog's ERM and EGM layers, then the archive's for keys the catalog sources elsewhere."""
    if not SOURCE.is_dir():
        sys.exit(f"{SOURCE} not found, set SUBNATIONAL_CATALOG")
    found = rows(SOURCE, SRCS)
    if not found:
        sys.exit(f"no {' or '.join(SRCS)} layers in {SOURCE}")
    for src in SRCS:
        if (ARCHIVE / src).is_dir():
            found = rows(ARCHIVE / src, SRCS) | found
    return [found[k] for k in sorted(found)]


def main() -> None:
    sources = layers()
    check_all(sources)
    for level in LEVELS:
        write_boundary(
            dissolved(sources, level, "src_name, src_date"),
            f"eurogeographics_adm{level}",
        )


if __name__ == "__main__":
    main()
