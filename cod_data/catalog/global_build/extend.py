"""Extend and clean a pick's layers with topo-tools, caching extensions across builds."""

import hashlib
import shutil
from functools import cache
from importlib.metadata import version
from pathlib import Path

import duckdb
from topo_tools.api import edge_extend, topo_clean, topo_detect

from cod_data.catalog.common import connect
from cod_data.catalog.global_build.config import BUILD, THREADS

EXTENDED = BUILD / "extended"


@cache
def engine() -> str:
    con = connect()
    spatial = con.execute(
        "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'spatial'"
    ).fetchall()[0][0]
    con.close()
    return f"duckdb {duckdb.__version__} spatial {spatial} topo-tools {version('topo-tools')}"


def clean_layer(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    work: Path,
    kinds: str = "true",
    gap: str | None = None,
) -> Path:
    """path, or its topo_clean output when topo_detect finds defects matching kinds."""
    issues = work / f"{path.stem}_detect.parquet"
    topo_detect(path, issues, threads=THREADS, tmp_dir=work)
    found = f"SELECT count(*) FROM '{issues}' WHERE {kinds}"
    if not con.execute(found).fetchall()[0][0]:
        return path
    clean = work / f"{path.stem}_clean.parquet"
    topo_clean(
        path,
        clean,
        work / f"{path.stem}_clean_issues.parquet",
        maximum_gap_width=gap,
        threads=THREADS,
        tmp_dir=work,
    )
    return clean


def extend_layer(con: duckdb.DuckDBPyConnection, original: Path, work: Path) -> Path:
    """Extend original past its coastline, cleaned on defects; cached by its rows, engine versions and this module."""
    rows = con.execute(f"""
        SELECT md5(string_agg(h, '' ORDER BY h)) FROM (
            SELECT md5(t::VARCHAR) AS h
            FROM (SELECT * REPLACE (hex(ST_AsWKB(geometry)) AS geometry) FROM '{original}') t)
    """).fetchall()[0][0]
    digest = hashlib.sha256(
        (rows + engine()).encode() + Path(__file__).read_bytes()
    ).hexdigest()[:16]
    out = EXTENDED / f"{original.stem}-{digest}.parquet"
    if out.exists():
        return out
    EXTENDED.mkdir(parents=True, exist_ok=True)
    extended = work / f"{original.stem}_extended.parquet"
    edge_extend(original, extended, threads=THREADS, tmp_dir=work)
    shutil.move(clean_layer(con, extended, work), out)
    return out
