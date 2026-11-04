"""Per-source, per-level feature and vertex counts per location, from the boundary parquets.
Run after every source download."""

import sys
from pathlib import Path

from common import BOUNDARY_SOURCES, connect, junk_filter, path_of
from shared.geoparquet import TABLE_OPTIONS

OUT = path_of("source_stats")
BATCH_VERTICES = 20_000_000
STATS_DB = Path("tmp/catalog/stats.duckdb")

BASE = """
    CREATE OR REPLACE TEMP TABLE base AS
    SELECT iso3,
        COUNT(*)::BIGINT AS feature_count,
        SUM(ST_NPoints(geometry))::BIGINT AS total_vertices,
        AVG(ST_NPoints(geometry)) AS avg_vertices
    FROM units GROUP BY iso3
"""

# A vertex touched by one polygon is on the outer edge, by 2+ on a shared internal boundary.
# Rounding to ~1cm absorbs float noise; a group-by needs no valid topology, unlike a dissolve.
EDGES = """
    INSERT INTO edges
    SELECT iso3,
        SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END)::BIGINT AS edge_vertices,
        SUM(CASE WHEN n > 1 THEN n ELSE 0 END)::BIGINT AS internal_vertices
    FROM (
        SELECT iso3, ROUND(ST_X(pt), 7) AS x, ROUND(ST_Y(pt), 7) AS y, COUNT(*) AS n
        FROM (
            SELECT iso3, UNNEST(ST_Dump(ST_Points(geometry))).geom AS pt
            FROM units WHERE iso3 IN ({iso3s})
        )
        GROUP BY ALL
    )
    GROUP BY iso3
"""


def batches(con) -> list[list[str]]:
    """Locations grouped so each batch holds at most about BATCH_VERTICES vertices."""
    out, batch, size = [], [], 0
    for iso3, n in con.execute(
        "SELECT iso3, total_vertices FROM base WHERE iso3 IS NOT NULL ORDER BY iso3"
    ).fetchall():
        if batch and size + n > BATCH_VERTICES:
            out.append(batch)
            batch, size = [], 0
        batch.append(iso3)
        size += n
    return out + [batch] if batch else out


STATS_DB.unlink(missing_ok=True)
con = connect(STATS_DB, memory_limit="4GB")
con.execute(
    "CREATE TABLE stats (source VARCHAR, level INTEGER, iso3 VARCHAR, feature_count BIGINT, "
    "total_vertices BIGINT, avg_vertices DOUBLE, edge_vertices BIGINT, internal_vertices BIGINT)"
)
created = False
for src in BOUNDARY_SOURCES:
    for level in src.levels:
        file = path_of(f"{src.name}_adm{level}")
        if not file.exists():
            continue
        print(f"{src.name} adm{level}", file=sys.stderr)
        con.execute(f"""
            CREATE OR REPLACE TABLE units AS
            SELECT substr({src.iso3_field}, 1, 3) AS iso3, geometry
            FROM read_parquet('{file}') {junk_filter(src, level)}
            ORDER BY iso3
        """)
        con.execute(BASE)
        con.execute(
            "CREATE OR REPLACE TEMP TABLE edges "
            "(iso3 VARCHAR, edge_vertices BIGINT, internal_vertices BIGINT)"
        )
        for batch in batches(con):
            con.execute(EDGES.format(iso3s=", ".join(f"'{i}'" for i in batch)))
        con.execute(f"""
            INSERT INTO stats
            SELECT '{src.name}', {level}, base.iso3, base.feature_count, base.total_vertices,
                base.avg_vertices, edges.edge_vertices, edges.internal_vertices
            FROM base JOIN edges ON base.iso3 = edges.iso3
        """)
        created = True

if not created:
    sys.exit("No source parquet files found, run the source download scripts first.")
con.execute(f"COPY stats TO '{OUT}' {TABLE_OPTIONS}")
con.close()
STATS_DB.unlink(missing_ok=True)
print(f"Wrote source comparison stats -> {OUT}")
