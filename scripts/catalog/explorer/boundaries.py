"""Download and write partner boundary layers: GeoParquet 2.0 in OGC:CRS84, polygon and label tiles."""

import tempfile
from pathlib import Path

from common import connect, path_of, tile_labels, tile_parquet
from shared.geoparquet import write_geoparquet

DOWNLOADS = Path("tmp/catalog/downloads")


def column_sql(name: str, type_: str, *, dates: bool) -> str:
    col = f'"{name}"'
    if type_ == "BLOB":
        return f"hex({col}) AS {col}"
    if type_ == "UUID":
        return f"upper(replace({col}::VARCHAR, '-', '')) AS {col}"
    if dates and type_.startswith("TIMESTAMP"):
        return f"{col}::DATE AS {col}"
    return col


def write_boundary(
    select_sql: str,
    name: str,
    *,
    make_valid: bool = True,
    dates: bool = True,
    hover_id: bool = True,
    labels: bool = True,
) -> Path:
    """Write select_sql (its geometry column named geometry) as <name>.parquet, then its tiles."""
    out = path_of(name)
    db = DOWNLOADS / f"{name}.duckdb"
    db.parent.mkdir(parents=True, exist_ok=True)
    db.unlink(missing_ok=True)
    tmp = out.with_name(f".{name}.tmp.parquet")
    con = connect(db, memory_limit="4GB")
    try:
        # Staged on disk so hover_id can follow insertion order without a window over every row.
        con.execute("SET preserve_insertion_order = true")
        con.execute(f"CREATE TABLE raw AS {select_sql}")
        columns = con.execute("DESCRIBE raw").fetchall()
        # OGC_FID is the row id ST_Read adds for GDAL sources.
        skip = {"geometry", "geometry_bbox", "OGC_FID"} | (
            {"hover_id"} if hover_id else set()
        )
        cols = [
            column_sql(c, t, dates=dates)
            for c, t, *_ in columns
            if c not in skip and not (hover_id and c.startswith("hover_id_"))
        ]
        geom = "ST_MakeValid(geometry)" if make_valid else "geometry"
        extra = ", rowid + 1 AS hover_id" if hover_id else ""
        write_geoparquet(
            con,
            f"SELECT {', '.join(cols)}{extra}, {geom} AS geometry FROM raw",
            tmp,
        )
        tmp.replace(out)
    finally:
        con.close()
        db.unlink(missing_ok=True)
        tmp.unlink(missing_ok=True)
    tile_parquet(out, path_of(name, "pmtiles"), name)
    if labels:
        tile_labels(out, out.with_name(f"{name}_labels.pmtiles"), f"{name}_labels")
    print(f"Wrote {out}")
    return out


def scratch_dir() -> tempfile.TemporaryDirectory:
    """A temporary directory for downloads, removed on exit."""
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=DOWNLOADS)
