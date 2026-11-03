"""Per-country polygon match rate (IoU vs. the decisions sheet's preferred source).
Requires the source boundary parquet files to exist (run the source download scripts first)."""

import argparse
import sys
import tempfile
from pathlib import Path

import duckdb
from common import (
    BOUNDARY_SOURCES,
    boundary_parquet,
    connect,
    junk_filter,
    path_of,
    read_sheet_url,
)
from shared.geoparquet import TABLE_OPTIONS

MATCH_DB = Path("tmp/catalog/match.duckdb")

MATCH_QUERY = """
    WITH valid_units AS (
        SELECT source, level, unit_code, ST_MakeValid(geometry) AS geometry
        FROM units WHERE iso3 = ?
    ),
    candidate_sources AS (
        SELECT DISTINCT s.source, s.level
        FROM valid_units s
        WHERE s.source != ?
          AND EXISTS (
              SELECT 1 FROM valid_units p WHERE p.source = ? AND p.level = s.level
          )
    ),
    pairs AS (
        SELECT s.source, s.unit_code,
            MAX(
                ST_Area_Spheroid(ST_Intersection(s.geometry, p.geometry))
                / ST_Area_Spheroid(ST_Union(s.geometry, p.geometry))
            ) AS best_iou
        FROM valid_units s
        JOIN valid_units p ON p.level = s.level AND p.source = ?
        WHERE s.source != ? AND ST_Intersects(s.geometry, p.geometry)
        GROUP BY s.source, s.unit_code
    ),
    unit_status AS (
        SELECT s.unit_code, s.source, s.level,
            COALESCE(pr.best_iou, 0) >= ? AS is_matched
        FROM valid_units s
        JOIN candidate_sources cs ON cs.source = s.source AND cs.level = s.level
        LEFT JOIN pairs pr ON pr.source = s.source AND pr.unit_code = s.unit_code
    )
    SELECT source, level, ? AS iso3, ? AS preferred_source,
        SUM(is_matched::INT)::BIGINT AS matched_count,
        COALESCE(array_agg(unit_code) FILTER (WHERE NOT is_matched), []::VARCHAR[]) AS unmatched_codes
    FROM unit_status
    GROUP BY source, level
"""


def fetch_decisions(sheet_url: str) -> list[tuple[str, str]]:
    con = connect()
    con.execute("LOAD httpfs")
    rows = con.execute(
        f"""
        SELECT upper(trim(iso3)) AS iso3, lower(trim(selected_source)) AS preferred_source
        FROM read_csv('{sheet_url}', header=true)
        WHERE selected_source IS NOT NULL
          AND lower(trim(selected_source)) NOT IN ('', 'null')
        """
    ).fetchall()
    con.close()
    return [(iso3, preferred_source) for iso3, preferred_source in rows]


def build_units_sql(level: int) -> list[str]:
    parts = []
    for src in BOUNDARY_SOURCES:
        if level not in src.levels:
            continue
        file = boundary_parquet(f"{src.name}_adm{level}")
        if not file.exists():
            continue
        where_clause = junk_filter(src, level)
        # The map's promoteId field (adminTiles in src/lib/explorer/sources.ts): unique and non-null.
        code = (
            f"adm{level}_pcode" if src.name == "ocha" else "CAST(hover_id AS VARCHAR)"
        )
        parts.append(
            f"SELECT '{src.name}' AS source, {level} AS level, "
            f"substr({src.iso3_field}, 1, 3) AS iso3, "
            f"{code} AS unit_code, geometry "
            f"FROM read_parquet('{file}') {where_clause}"
        )
    return parts


def run_level(
    level: int, threshold: float, decisions: list[tuple[str, str]]
) -> list[tuple[str, int, str, str, int, list[str]]]:
    units_sqls = build_units_sql(level)
    if not units_sqls:
        print(
            f"[level {level}] no source parquet files found, skipping", file=sys.stderr
        )
        return []

    MATCH_DB.unlink(missing_ok=True)
    con = connect(MATCH_DB)
    con.execute("SET geometry_always_xy = true")
    # One source per insert, only the locations being matched, to keep each insert small.
    wanted = ", ".join(sorted({f"'{iso3}'" for iso3, _ in decisions}))
    for i, units_sql in enumerate(units_sqls):
        verb = "CREATE TABLE units AS" if i == 0 else "INSERT INTO units"
        con.execute(f"{verb} SELECT * FROM ({units_sql}) WHERE iso3 IN ({wanted})")
    con.execute("CREATE INDEX idx_units_iso3 ON units(iso3)")

    results: list[tuple[str, int, str, str, int, list[str]]] = []
    total = len(decisions)
    for i, (iso3, preferred_source) in enumerate(decisions, start=1):
        print(
            f"[level {level}] [{i}/{total}] {iso3} (preferred: {preferred_source})",
            file=sys.stderr,
        )
        try:
            rows = con.execute(
                MATCH_QUERY,
                [
                    iso3,
                    preferred_source,
                    preferred_source,
                    preferred_source,
                    preferred_source,
                    threshold,
                    iso3,
                    preferred_source,
                ],
            ).fetchall()
        except duckdb.Error as e:
            print(
                f"[level {level}] [{i}/{total}] {iso3}: query failed, skipping: {e}",
                file=sys.stderr,
            )
            continue
        results.extend(rows)

    con.close()
    MATCH_DB.unlink(missing_ok=True)
    return results


def write_output(
    rows: list[tuple[str, int, str, str, int, list[str]]], output: Path
) -> None:
    con = connect()
    con.execute(
        "CREATE TABLE new_rows (source VARCHAR, level INTEGER, iso3 VARCHAR, "
        "preferred_source VARCHAR, matched_count BIGINT, unmatched_codes VARCHAR[])"
    )
    con.executemany("INSERT INTO new_rows VALUES (?, ?, ?, ?, ?, ?)", rows)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=output.parent, suffix=".parquet", delete=False
    ) as f:
        tmp_path = Path(f.name)

    if output.exists():
        select_sql = f"""
            SELECT source, level, iso3, preferred_source, matched_count, unmatched_codes
            FROM (
                SELECT *, 0 AS priority FROM new_rows
                UNION ALL
                SELECT *, 1 AS priority FROM read_parquet('{output}')
            )
            QUALIFY ROW_NUMBER() OVER (PARTITION BY source, level, iso3 ORDER BY priority) = 1
        """
    else:
        select_sql = "SELECT source, level, iso3, preferred_source, matched_count, unmatched_codes FROM new_rows"

    con.execute(f"COPY ( {select_sql} ) TO '{tmp_path}' {TABLE_OPTIONS}")
    con.close()
    tmp_path.replace(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--levels", nargs="+", type=int, default=[1, 2, 3, 4])
    parser.add_argument("--threshold", type=float, default=0.9)
    parser.add_argument("--output", type=Path, default=path_of("source_match"))
    parser.add_argument("--iso3", nargs="+", help="Only these locations")
    args = parser.parse_args()

    sheet_url = read_sheet_url()
    if not sheet_url:
        print(
            "PUBLIC_DECISIONS_SHEET_URL not set in .env, skipping match-rate computation.",
            file=sys.stderr,
        )
        return

    decisions = fetch_decisions(sheet_url)
    if args.iso3:
        wanted = {i.upper() for i in args.iso3}
        decisions = [d for d in decisions if d[0] in wanted]

    # One level at a time: each loads every source's polygons for that level.
    all_rows = [
        row
        for level in args.levels
        for row in run_level(level, args.threshold, decisions)
    ]

    if not all_rows:
        print(
            "No match-rate rows computed, leaving existing output untouched.",
            file=sys.stderr,
        )
        return

    write_output(all_rows, args.output)
    print(
        f"Wrote {len(all_rows)} source match-rate rows for levels {args.levels} -> {args.output}"
    )


if __name__ == "__main__":
    main()
