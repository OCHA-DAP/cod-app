"""ADM0 parent rows for edge-mosaic from one adm0-app layer: one row per iso3, or per PARTS part."""

from pathlib import Path

import duckdb
from config import ADM0_CATALOG, ADM0_LAYERS, MATCH_KEY, PARTS, PARTS_LAYER
from shared.geoparquet import write_geoparquet


def write_parents(con: duckdb.DuckDBPyConnection, layer: str, out: Path) -> None:
    """Write MATCH_KEY, adm0_pcode, adm0_name and geometry."""
    file, iso3, name = ADM0_LAYERS[layer]
    src = ADM0_CATALOG / file
    parts = ADM0_CATALOG / PARTS_LAYER
    split = str(list(PARTS))
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE adm0 AS
        SELECT {iso3} AS iso3, {name} AS name, ST_Area(geometry) AS area, geometry
        FROM read_parquet('{src}');
        CREATE OR REPLACE TEMP TABLE pieces AS
        SELECT row_number() OVER () AS piece, *
        FROM (SELECT a.iso3, a.name, unnest(ST_Dump(a.geometry)).geom AS geometry
              FROM adm0 a WHERE list_contains({split}, a.iso3));
        CREATE OR REPLACE TEMP TABLE fm AS
        SELECT iso_3 AS iso3, adm0_src AS part, geometry FROM read_parquet('{parts}')
        WHERE list_contains({split}, iso_3);
        CREATE OR REPLACE TEMP TABLE hits AS
        SELECT p.piece, list(f.part) AS parts
        FROM pieces p LEFT JOIN fm f
          ON f.iso3 = p.iso3 AND ST_Intersects(f.geometry, p.geometry)
        GROUP BY p.piece;
        CREATE OR REPLACE TEMP TABLE piece_parts AS
        SELECT p.*, h.parts[1] AS part, 0.0 AS dist FROM pieces p JOIN hits h USING (piece)
        WHERE len(h.parts) = 1 AND h.parts[1] IS NOT NULL
        UNION ALL
        SELECT p.*, arg_max(f.part, ST_Area(ST_Intersection(f.geometry, p.geometry))), 0.0
        FROM pieces p JOIN hits h USING (piece) JOIN fm f ON list_contains(h.parts, f.part)
        WHERE len(h.parts) > 1 GROUP BY ALL
        UNION ALL
        SELECT p.*, arg_min(f.part, ST_Distance(f.geometry, p.geometry)),
            min(ST_Distance(f.geometry, p.geometry))
        FROM pieces p JOIN hits h USING (piece) JOIN fm f ON f.iso3 = p.iso3
        WHERE h.parts[1] IS NULL GROUP BY ALL
    """
    )
    # Pieces the FieldMaps parts don't touch go to the nearest part: report how far.
    for row in con.execute(
        "SELECT iso3, part, count(*), round(max(dist), 3) FROM piece_parts WHERE dist > 0 "
        "GROUP BY ALL ORDER BY ALL"
    ).fetchall():
        print(
            f"{layer}: {row[0]} {row[2]} pieces outside FieldMaps to {row[1]}, up to {row[3]} degrees"
        )
    write_geoparquet(
        con,
        f"""
        SELECT iso3 AS {MATCH_KEY}, iso3 AS adm0_pcode, arg_max(name, area) AS adm0_name,
            ST_Union_Agg(geometry) AS geometry
        FROM adm0 WHERE NOT list_contains({split}, iso3) GROUP BY iso3
        UNION ALL
        SELECT part, iso3, arg_max(name, ST_Area(geometry)), ST_Union_Agg(geometry)
        FROM piece_parts GROUP BY part, iso3
        ORDER BY 1
    """,
        out,
    )
