"""Parquet write options and the GeoParquet chokepoint: V2, OGC:CRS84, ZSTD 15, within ±180/±90."""

from pathlib import Path

import duckdb

CRS = "OGC:CRS84"
TABLE_OPTIONS = "(FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 15)"
GEO_OPTIONS = (
    "(FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 15, GEOPARQUET_VERSION V2)"
)
WORLD = "ST_MakeEnvelope(-180, -90, 180, 90)"


def world_clip(col: str = "geometry") -> str:
    """SQL clipping col to the world, only for rows past it, keeping dimension and multi-ness."""
    return f"""CASE
        WHEN ST_IsEmpty({col}) OR (
            ST_XMin({col}) >= -180 AND ST_XMax({col}) <= 180
            AND ST_YMin({col}) >= -90 AND ST_YMax({col}) <= 90
        ) THEN {col}
        WHEN NOT ST_Intersects({col}, {WORLD})
        THEN error('geometry lies entirely outside the world bounds')
        ELSE (SELECT CASE WHEN starts_with(ST_GeometryType({col})::VARCHAR, 'MULTI')
            THEN ST_Multi(g) ELSE g END
            FROM (SELECT ST_CollectionExtract(ST_Intersection(
                ST_MakeValid({col}), {WORLD}), ST_Dimension({col}) + 1) AS g))
        END"""


def write_geoparquet(con: duckdb.DuckDBPyConnection, query: str, out: Path) -> None:
    """COPY query (geometry column named geometry) to out, world-clipped in CRS84, then check it."""
    con.execute(f"""
        COPY (SELECT * REPLACE (ST_SetCRS({world_clip()}, '{CRS}') AS geometry) FROM ({query}))
        TO '{out}' {GEO_OPTIONS}
    """)
    n, crs, xmin, ymin, xmax, ymax = con.execute(f"""
        SELECT count(*), any_value(ST_CRS(geometry)), min(ST_XMin(geometry)),
            min(ST_YMin(geometry)), max(ST_XMax(geometry)), max(ST_YMax(geometry))
        FROM read_parquet('{out}')
    """).fetchall()[0]
    if n and (crs != CRS or xmin < -180 or ymin < -90 or xmax > 180 or ymax > 90):
        raise ValueError(f"{out.name}: CRS {crs}, bbox {xmin, ymin, xmax, ymax}")
