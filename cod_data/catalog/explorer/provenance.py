"""Per-source provenance (data provider, source date) per location. Run after every source download.
OCHA and FAO providers come from hand-maintained CSVs in data/provenance/. Each date is the latest value
of the source's date field: OCHA valid_on, ERM src_date, UNHCR update_date, WFP source_date, UNICEF
start_date, FAO's "Accessed on" from GAUL's metadata spreadsheets, and World Bank's latest admin 2 P_DATE."""

from pathlib import Path

from cod_data.catalog.common import FAO_ACCESSED, PARTNERS, WB_DATES, connect, path_of
from cod_data.shared.geoparquet import TABLE_OPTIONS

RAW_DIR = Path(__file__).parent / "data" / "provenance"
OUT = path_of("source_provenance")


for dates, step in ((FAO_ACCESSED, "fao"), (WB_DATES, "wb")):
    if not dates.exists():
        raise FileNotFoundError(f"{dates} missing: run the {step} step first")
con = connect()
multi = con.execute(f"""
    SELECT iso3 FROM read_parquet('{path_of("ocha_adm1")}')
    GROUP BY iso3 HAVING count(DISTINCT valid_on) > 1
""").fetchall()
if multi:
    raise ValueError(
        f"OCHA locations with several valid_on dates: {[r[0] for r in multi]}"
    )
con.execute(f"""
    CREATE TABLE provenance AS
        SELECT 'ocha' AS source, iso3, provider, v.valid_on::DATE AS source_updated
        FROM read_csv('{RAW_DIR / "ocha.csv"}', header=true)
        LEFT JOIN (
            SELECT iso3, max(valid_on) AS valid_on FROM read_parquet('{path_of("ocha_adm1")}') GROUP BY iso3
        ) v USING (iso3)
    UNION ALL
        SELECT 'fao' AS source, iso3, provider, a.accessed AS source_updated
        FROM read_csv('{RAW_DIR / "fao.csv"}', header=true)
        LEFT JOIN read_parquet('{FAO_ACCESSED}') a USING (iso3)
    UNION ALL
        SELECT 'wfp' AS source, iso3,
            array_to_string(list_sort(list_distinct(list(source))), '; ') AS provider,
            max(source_date) AS source_updated
        FROM read_parquet('{path_of("wfp_adm1")}')
        GROUP BY iso3
    UNION ALL
        SELECT 'unicef' AS source, left(adm0_ucode, 3) AS iso3,
            '{PARTNERS["unicef"]["provider"]}' AS provider, max(start_date)::DATE AS source_updated
        FROM read_parquet('{path_of("unicef_adm1")}')
        GROUP BY 2
    UNION ALL
        SELECT 'unhcr' AS source, iso3,
            array_to_string(list_sort(list_distinct(list(source))), '; ') AS provider,
            max(update_date) AS source_updated
        FROM read_parquet('{path_of("unhcr_adm1")}')
        GROUP BY iso3
    UNION ALL
        SELECT 'wb' AS source, ISO_A3 AS iso3,
            '{PARTNERS["wb"]["provider"]}' AS provider, d.produced AS source_updated
        FROM (SELECT DISTINCT ISO_A3 FROM read_parquet('{path_of("wb_adm1")}'))
        LEFT JOIN read_parquet('{WB_DATES}') d ON d.iso3 = ISO_A3
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
