"""Per-source provenance (data provider, last update) per location. Run after every source download.
OCHA and FAO providers come from hand-maintained CSVs in data/provenance/, FAO dates from GAUL's
metadata spreadsheets; WFP, UNICEF, UNHCR and ERM from their own layers."""

from pathlib import Path

from cod_data.catalog.common import FAO_ACCESSED, PARTNERS, connect, path_of
from cod_data.shared.geoparquet import TABLE_OPTIONS

RAW_DIR = Path(__file__).parent / "data" / "provenance"
OUT = path_of("source_provenance")


def without_bulk_stamp(table: str) -> str:
    """table's rows, source_updated NULL where it is a bulk edit stamp shared by over 30% of locations."""
    return f"""
        SELECT iso3, provider,
            CASE WHEN source_updated = (
                SELECT source_updated FROM {table} GROUP BY 1
                HAVING count(*) > 0.3 * (SELECT count(*) FROM {table})
                ORDER BY count(*) DESC LIMIT 1
            ) THEN NULL ELSE source_updated END AS source_updated
        FROM {table}
    """


con = connect()
con.execute(f"""
    CREATE TEMP TABLE wfp_country AS
        SELECT iso3,
            array_to_string(list_sort(list_distinct(list(source))), '; ') AS provider,
            max(lst_update) AS source_updated
        FROM read_parquet('{path_of("wfp_adm1")}')
        GROUP BY iso3;

    CREATE TEMP TABLE unicef_country AS
        SELECT left(adm0_ucode, 3) AS iso3, '{PARTNERS["unicef"]["provider"]}' AS provider,
            max(start_date)::DATE AS source_updated
        FROM read_parquet('{path_of("unicef_adm1")}')
        GROUP BY 1;

    CREATE TABLE provenance AS
        SELECT 'ocha' AS source, iso3, provider, source_updated::DATE AS source_updated
        FROM read_csv('{RAW_DIR / "ocha.csv"}', header=true)
    UNION ALL
        SELECT 'fao' AS source, iso3, provider, a.accessed AS source_updated
        FROM read_csv('{RAW_DIR / "fao.csv"}', header=true)
        LEFT JOIN read_parquet('{FAO_ACCESSED}') a USING (iso3)
    UNION ALL
        SELECT 'wfp' AS source, * FROM ({without_bulk_stamp("wfp_country")})
    UNION ALL
        SELECT 'unicef' AS source, * FROM ({without_bulk_stamp("unicef_country")})
    UNION ALL
        SELECT 'unhcr' AS source, iso3,
            array_to_string(list_sort(list_distinct(list(source))), '; ') AS provider,
            max(src_date) AS source_updated
        FROM read_parquet('{path_of("unhcr_adm1")}')
        GROUP BY iso3
    UNION ALL
        SELECT 'erm' AS source, iso3,
            array_to_string(list_sort(list_distinct(list(src_name))), '; ') AS provider,
            max(src_date) AS source_updated
        FROM read_parquet('{path_of("erm_adm1")}')
        GROUP BY iso3;

    -- UNHCR fills unknown dates with spreadsheet placeholders (1899-12-30, 1900-01-01).
    COPY (
        SELECT * REPLACE (
            CASE WHEN source_updated > DATE '1900-01-01' THEN source_updated END AS source_updated
        ) FROM provenance
    ) TO '{OUT}' {TABLE_OPTIONS};
""")
con.close()
print(f"Wrote source provenance -> {OUT}")
