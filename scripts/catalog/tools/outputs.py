"""Write catalog outputs only when their rows change, so `portolan add` leaves unchanged files alone."""

import json
from pathlib import Path

import duckdb
from shared.geoparquet import write_geoparquet


def same_rows(new: Path, old: Path, *, ordered: bool = False) -> bool:
    """Check that `old` has every column of `new` with the same rows (in the same order if `ordered`), ignoring extra columns."""
    con = connect()
    columns = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{new}')").fetchall()
    old_columns = {
        name: kind
        for name, kind, *_ in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{old}')"
        ).fetchall()
    }
    if any(old_columns.get(name) != kind for name, kind, *_ in columns):
        return False
    select = ", ".join(
        f"ST_AsWKB({name}) AS {name}" if kind.startswith("GEOMETRY") else name
        for name, kind, *_ in columns
    )
    if ordered:
        select += ", file_row_number"
    options = ", file_row_number = true" if ordered else ""
    a, b = (f"SELECT {select} FROM read_parquet('{p}'{options})" for p in (new, old))
    differ = con.execute(
        f"SELECT count(*) FROM (({a} EXCEPT ALL {b}) UNION ALL ({b} EXCEPT ALL {a}))"
    ).fetchall()[0][0]
    return differ == 0


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("LOAD spatial")
    con.execute("SET geometry_always_xy = true")
    return con


def write_parquet(
    con: duckdb.DuckDBPyConnection, query: str, out: Path, *, ordered: bool = False
) -> bool:
    """Write `query` to `out` as OGC:CRS84 GeoParquet 2.0 unless `out` already holds the same rows. Returns True when written."""
    out.parent.mkdir(parents=True, exist_ok=True)
    new = out.with_name(f"{out.stem}.new.parquet")
    write_geoparquet(
        con,
        f"SELECT * REPLACE (ST_Transform(geometry, 'OGC:CRS84') AS geometry) FROM ({query})",
        new,
    )
    if out.exists() and same_rows(new, out, ordered=ordered):
        new.unlink()
        return False
    new.replace(out)
    return True


def read_state(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def write_state(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
