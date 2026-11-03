"""Flatten the per-source/level comparison data StatsComparisonTable shows in the UI into a
downloadable dataset. Must run after m49, iso3166, mapbox_boundaries, provenance, stats and match."""

from common import connect, path_of, read_sheet_url
from shared.geoparquet import TABLE_OPTIONS

OUT_PARQUET = path_of("source_comparison")

COMPARISON_QUERY = f"""
    SELECT
        s.iso3,
        m."Country or Area" AS country_name,
        s.source,
        s.level,
        s.feature_count,
        s.total_vertices,
        s.avg_vertices,
        s.edge_vertices,
        s.internal_vertices,
        p.provider,
        p.source_updated,
        CASE WHEN s.level = 1 THEN i.subdivision_count END AS iso3166_adm1_subdivision_count,
        mb.feature_count AS mapbox_feature_count,
        d.selected_source AS team_selected_source,
        TRY_CAST(d.accepted AS BOOLEAN) AS team_accepted,
        d.rationale AS team_rationale,
        d.last_updated AS team_last_updated,
        match.matched_count,
        CASE WHEN match.matched_count IS NOT NULL AND s.feature_count > 0
            THEN ROUND(100.0 * match.matched_count / s.feature_count, 1) END AS match_rate_pct
    FROM read_parquet('{path_of("source_stats")}') s
    JOIN read_parquet('{path_of("m49")}') m ON m."ISO-alpha3 Code" = s.iso3
    LEFT JOIN read_parquet('{path_of("source_provenance")}') p
        ON p.source = s.source AND p.iso3 = s.iso3
    LEFT JOIN read_parquet('{path_of("iso3166")}') i ON i.iso3 = s.iso3
    LEFT JOIN read_parquet('{path_of("mapbox_boundaries")}') mb
        ON mb.iso3 = s.iso3 AND mb.level = s.level
    LEFT JOIN decisions d ON d.iso3 = s.iso3
    LEFT JOIN read_parquet('{path_of("source_match")}') match
        ON match.source = s.source AND match.level = s.level AND match.iso3 = s.iso3
        AND match.preferred_source = d.selected_source
    ORDER BY s.iso3, s.level, s.source
"""


def main() -> None:
    con = connect()
    sheet_url = read_sheet_url()
    if sheet_url:
        con.execute("LOAD httpfs")
        # Sheet columns vary by submission, same defensive lookup decisions.ts does client-side.
        available = {
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM read_csv('{sheet_url}', header=true, all_varchar=true)"
            ).fetchall()
        }
        wanted = ["iso3", "selected_source", "accepted", "rationale", "last_updated"]
        select_cols = ", ".join(c if c in available else f"NULL AS {c}" for c in wanted)
        con.execute(
            f"CREATE TABLE decisions AS SELECT {select_cols} "
            f"FROM read_csv('{sheet_url}', header=true, all_varchar=true)"
        )
    else:
        print(
            "PUBLIC_DECISIONS_SHEET_URL not set, writing comparison data without team decisions"
        )
        con.execute(
            "CREATE TABLE decisions "
            "(iso3 VARCHAR, selected_source VARCHAR, accepted VARCHAR, "
            "rationale VARCHAR, last_updated VARCHAR)"
        )

    con.execute(f"CREATE TABLE comparison AS {COMPARISON_QUERY}")

    OUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY comparison TO '{OUT_PARQUET}' {TABLE_OPTIONS}")
    con.close()

    print(f"Wrote source comparison data → {OUT_PARQUET}")


if __name__ == "__main__":
    main()
