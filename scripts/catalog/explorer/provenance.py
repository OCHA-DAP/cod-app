"""Per-source provenance (data provider, last update) per location. Run after every source download.
OCHA and FAO come from hand-maintained CSVs in data/provenance/; WFP and UNHCR from their own layers."""

from pathlib import Path

from common import connect, path_of
from shared.geoparquet import TABLE_OPTIONS

RAW_DIR = Path(__file__).parent / "data" / "provenance"
OUT = path_of("source_provenance")

con = connect()
con.execute(f"""
    CREATE TEMP TABLE wfp_country AS
        SELECT iso3,
            array_to_string(list_distinct(list(source)), '; ') AS provider,
            max(lst_update) AS source_updated
        FROM read_parquet('{path_of("wfp_adm1")}')
        GROUP BY iso3;

    -- A date shared by over 30% of countries is a bulk migration stamp, not a boundary update.
    CREATE TEMP TABLE wfp_baseline AS
        SELECT source_updated AS baseline_date
        FROM wfp_country
        GROUP BY source_updated
        HAVING count(*) > 0.3 * (SELECT count(*) FROM wfp_country)
        ORDER BY count(*) DESC
        LIMIT 1;

    CREATE TABLE provenance AS
        SELECT 'ocha' AS source, iso3, provider, source_updated::DATE AS source_updated
        FROM read_csv('{RAW_DIR / "ocha.csv"}', header=true)
    UNION ALL
        SELECT 'fao' AS source, iso3, provider, NULL::DATE AS source_updated
        FROM read_csv('{RAW_DIR / "fao.csv"}', header=true)
    UNION ALL
        SELECT 'wfp' AS source, iso3, provider,
            CASE WHEN source_updated IN (SELECT baseline_date FROM wfp_baseline)
                THEN NULL ELSE source_updated END AS source_updated
        FROM wfp_country
    UNION ALL
        SELECT 'unhcr' AS source, iso3,
            array_to_string(list_distinct(list(source)), '; ') AS provider,
            max(src_date) AS source_updated
        FROM read_parquet('{path_of("unhcr_adm1")}')
        GROUP BY iso3;

    COPY provenance TO '{OUT}' {TABLE_OPTIONS};
""")
con.close()
print(f"Wrote source provenance -> {OUT}")
