"""EuroGeographics EuroRegionalMap admin 1-4 boundaries, dissolved per level from the
original-tier ERM layers in a local fieldmaps/subnational checkout: its catalog
(SUBNATIONAL_CATALOG), plus its archive for ERM locations the catalog sources elsewhere."""

import os
import sys
from pathlib import Path

from cod_data.catalog.common import connect
from cod_data.catalog.explorer.boundaries import write_boundary

CATALOG = Path(
    os.environ.get("SUBNATIONAL_CATALOG", "../../fieldmaps/subnational/catalog")
)
SOURCE = CATALOG / "source"
ARCHIVE = CATALOG.parent / "archive" / "erm"
LEVELS = (1, 2, 3, 4)
NAMES = ("name", "name1", "name2", "name3", "pcode")


def erm_rows(root: Path) -> dict[str, tuple[str, int, str, str]]:
    """key -> (path, src_lvl, src_name, src_date) of each ERM original layer under root."""
    con = connect()
    rows = con.execute(f"""
        SELECT key, src_lvl, src_name, src_date::VARCHAR
        FROM (
            SELECT unnest(rows, recursive := true)
            FROM read_json('{root}/*/*_metadata.json', union_by_name = true)
        )
        WHERE src = 'erm' AND tier = 'original'
    """).fetchall()
    con.close()
    return {k: (str(root / k / f"{k}_original.parquet"), *rest) for k, *rest in rows}


def layers() -> list[tuple[str, int, str, str]]:
    """The catalog's ERM layers, then the archive's for keys the catalog sources elsewhere."""
    if not SOURCE.is_dir():
        sys.exit(f"{SOURCE} not found, set SUBNATIONAL_CATALOG")
    found = erm_rows(SOURCE)
    if not found:
        sys.exit(f"no erm layers in {SOURCE}")
    if ARCHIVE.is_dir():
        found = erm_rows(ARCHIVE) | found
    return [found[k] for k in sorted(found)]


def check(con, path: str, lvl: int) -> None:
    """Exit unless path has one row per deepest pcode, and each pcode one set of the
    name and parent columns the dissolve groups by."""
    rows, units = con.execute(
        f"SELECT count(*), count(DISTINCT adm{lvl}_pcode) FROM '{path}'"
    ).fetchall()[0]
    if rows != units:
        sys.exit(f"{path}: {rows} rows, {units} distinct adm{lvl}_pcode")
    columns = {r[0] for r in con.execute(f"DESCRIBE FROM '{path}'").fetchall()}
    for k in range(1, lvl + 1):
        keys = [f"adm{n}_{f}" for n in range(k, -1, -1) for f in NAMES]
        group = ", ".join(c for c in keys if c in columns)
        split = con.execute(f"""
            SELECT count(*) FROM (
                SELECT adm{k}_pcode FROM '{path}' GROUP BY 1
                HAVING count(DISTINCT ({group})) > 1
            )
        """).fetchall()[0][0]
        if split:
            sys.exit(
                f"{path}: {split} adm{k}_pcode values with several names or parents"
            )


def quote(value: str | None) -> str:
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def main() -> None:
    sources = layers()
    con = connect()
    for path, lvl, *_ in sources:
        check(con, path, lvl)
    con.close()

    for level in LEVELS:
        parts = [
            f"SELECT *, {quote(name)} AS src_name, {quote(date)}::DATE AS src_date "
            f"FROM read_parquet('{path}')"
            for path, lvl, name, date in sources
            if lvl >= level
        ]
        keys = ", ".join(f"adm{n}_{f}" for n in range(level, -1, -1) for f in NAMES)
        write_boundary(
            f"""
            SELECT iso3, {keys}, src_name, src_date,
                ST_CoverageUnion_Agg(geometry) AS geometry
            FROM ({" UNION ALL BY NAME ".join(parts)})
            GROUP BY ALL
            ORDER BY iso3, adm{level}_pcode
            """,
            f"erm_adm{level}",
        )


if __name__ == "__main__":
    main()
