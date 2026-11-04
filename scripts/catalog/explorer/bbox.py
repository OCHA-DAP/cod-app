"""Per-country fit bbox for the map's zoom-to-country, from UN Geodata's adm0 layer.
The longitude span is the complement of the largest gap between vertices, so it crosses 180 when shorter."""

import sys

from common import connect, path_of
from shared.geoparquet import TABLE_OPTIONS

IN = path_of("ungeodata_adm0")
OUT = path_of("country_bbox")

if not IN.exists():
    sys.exit(f"{IN} not found, run ungeodata.py first.")

con = connect()
# Latitudes come from the same vertex dump, so countries with several adm0 rows (GBR) stay one row.
con.execute(f"""
    COPY (
        WITH dumped AS (
            SELECT iso3cd AS iso3, (UNNEST(ST_Dump(ST_Points(geometry)))).geom AS pt
            FROM '{IN}'
        ),
        pts AS (
            SELECT DISTINCT iso3, ST_X(pt) AS lon, ST_Y(pt) AS lat FROM dumped
        ),
        lat_bounds AS (
            SELECT iso3, min(lat) AS ymin, max(lat) AS ymax FROM pts GROUP BY iso3
        ),
        sorted AS (
            SELECT iso3, lon,
                LEAD(lon) OVER (PARTITION BY iso3 ORDER BY lon) AS next_lon,
                FIRST_VALUE(lon) OVER (PARTITION BY iso3 ORDER BY lon) AS first_lon
            FROM pts
        ),
        gaps AS (
            SELECT iso3, lon, next_lon, first_lon,
                COALESCE(next_lon, first_lon + 360) - lon AS gap_size
            FROM sorted
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY iso3 ORDER BY gap_size DESC) AS rk
            FROM gaps
        ),
        fit_lon AS (
            SELECT iso3,
                CASE WHEN next_lon IS NULL THEN first_lon ELSE next_lon END AS xmin,
                CASE WHEN next_lon IS NULL THEN lon ELSE lon + 360 END AS xmax
            FROM ranked WHERE rk = 1
        )
        SELECT f.iso3, f.xmin, lb.ymin, f.xmax, lb.ymax
        FROM fit_lon f
        JOIN lat_bounds lb ON lb.iso3 = f.iso3
    ) TO '{OUT}' {TABLE_OPTIONS}
""")
con.close()
print(f"Wrote country fit bboxes -> {OUT}")
