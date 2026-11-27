"""Per-source metadata for each location (producer, publisher, licence and its terms, notice, URL, dates, pick).
Run after every source download; valid_from is the latest value of each source's date field."""

from pathlib import Path

from cod_data.catalog.common import (
    COD_AB_COLLECTIONS,
    COD_AB_LEGACY_DIR,
    DECISIONS,
    FAO_ACCESSED,
    PARTNERS,
    WB_DATES,
    connect,
    path_of,
)
from cod_data.catalog.explorer.eurogeographics import CACHE as EG_CACHE
from cod_data.catalog.explorer.geoboundaries import META as GB_META
from cod_data.catalog.explorer.overture import BUCKET as OV_BUCKET
from cod_data.catalog.explorer.overture import META as OV_META
from cod_data.shared.geoparquet import TABLE_OPTIONS

RAW_DIR = Path(__file__).parent / "data" / "provenance"
OUT = path_of("source_metadata")
PARTNER_SOURCES = (
    "wfp",
    "unicef",
    "unhcr",
    "fao",
    "who",
    "wb",
    "geoboundaries",
    "overture",
)


def sidecars(root: Path) -> str:
    """The original-tier rows of every metadata sidecar under root."""
    return f"""(
        SELECT * FROM (
            SELECT unnest(rows, recursive := true)
            FROM read_json('{root}/*/*_metadata.json', union_by_name = true)
        ) WHERE tier = 'original'
    )"""


def partner(
    source: str, iso3: str, producer: str, valid_from: str, updated: str
) -> str:
    """Columns after (source, iso3) for a partner row, joined to the partner table as p."""
    return f"'{source}', {iso3}, {producer}, p.publisher, p.licence, p.url, {valid_from}, {updated}"


def main() -> None:
    for path, step in (
        (FAO_ACCESSED, "fao"),
        (WB_DATES, "wb"),
        (COD_AB_COLLECTIONS, "ocha"),
        (GB_META, "geoboundaries"),
        (OV_META, "overture"),
    ):
        if not path.exists():
            raise FileNotFoundError(f"{path} missing: run the {step} step first")
    con = connect()
    multi = con.execute(f"""
        SELECT iso3 FROM read_parquet('{path_of("ocha_adm1")}')
        GROUP BY iso3 HAVING count(DISTINCT valid_on) > 1
    """).fetchall()
    if multi:
        raise ValueError(
            f"OCHA locations with several valid_on dates: {[r[0] for r in multi]}"
        )
    con.execute("CREATE TABLE partner (source VARCHAR, provider VARCHAR, url VARCHAR)")
    con.executemany(
        "INSERT INTO partner VALUES (?, ?, ?)",
        [
            (
                s,
                PARTNERS[s]["provider"],
                u.get("1")
                if isinstance(u := PARTNERS[s].get("source_url"), dict)
                else u,
            )
            for s in PARTNER_SOURCES
        ],
    )
    con.execute(f"""
        CREATE TABLE licences AS
            SELECT * FROM read_csv('{RAW_DIR / "licences.csv"}', header = true, all_varchar = true);
        CREATE TABLE partners AS
            SELECT p.*, l.publisher, l.licence FROM partner p LEFT JOIN licences l USING (source);
        CREATE TABLE ocha AS
            SELECT iso3, coalesce(c.provider, v.src_name) AS producer,
                v.valid_on::DATE AS valid_from, v.src_name IS NOT NULL AS legacy
            FROM read_csv('{RAW_DIR / "ocha.csv"}', header = true) c
            FULL JOIN (
                SELECT iso3, max(valid_on) AS valid_on, any_value(src_name) AS src_name
                FROM read_parquet('{path_of("ocha_adm1")}') GROUP BY iso3
            ) v USING (iso3);
        CREATE TABLE metadata AS
            SELECT 'ocha' AS source, o.iso3, o.producer,
                CASE WHEN o.legacy THEN l.src_name1 ELSE c.publisher END AS publisher,
                CASE WHEN o.legacy THEN replace(l.src_lic,
                    'Creative Commons Attribution for Intergovernmental Organisations', 'CC-BY-3.0-IGO')
                    ELSE c.licence END AS licence,
                CASE WHEN o.legacy THEN l.src_url
                    ELSE 'https://data.humdata.org/dataset/cod-ab-' || lower(o.iso3) END AS url,
                o.valid_from,
                CASE WHEN o.legacy THEN l.src_update::DATE ELSE c.updated END AS updated
            FROM ocha o
            LEFT JOIN read_parquet('{COD_AB_COLLECTIONS}') c USING (iso3)
            LEFT JOIN {sidecars(COD_AB_LEGACY_DIR)} l USING (iso3)
        UNION ALL
            SELECT 'eurogeographics', e.iso3, e.producer, s.src_name1, s.src_lic,
                '{PARTNERS["eurogeographics"]["source_url"]}', e.valid_from, NULL::DATE
            FROM (
                SELECT iso3, array_to_string(list_sort(list_distinct(list(src_name))), '; ') AS producer,
                    max(src_date) AS valid_from
                FROM read_parquet('{path_of("eurogeographics_adm1")}') GROUP BY iso3
            ) e
            LEFT JOIN {sidecars(EG_CACHE)} s USING (iso3)
        UNION ALL
            -- Each location's deepest level; geoBoundaries gives only the year it represents.
            SELECT 'geoboundaries', g.iso3, g.source, p.publisher, coalesce(l.licence, g.licence),
                g.url, make_date(g.year, 1, 1), g.built
            FROM (
                SELECT * FROM read_parquet('{GB_META}')
                QUALIFY row_number() OVER (PARTITION BY iso3 ORDER BY level DESC) = 1
            ) g
            LEFT JOIN read_csv('{RAW_DIR / "geoboundaries_licences.csv"}', header = true, all_varchar = true) l
                ON l.boundaryLicense = g.licence
            JOIN partners p ON p.source = 'geoboundaries'
        UNION ALL
            -- Overture gives no date the data represents, only its release date.
            SELECT 'overture', o.iso3, o.datasets, p.publisher, p.licence,
                's3://{OV_BUCKET}/release/' || o.release || '/theme=divisions/', NULL::DATE,
                strptime(split_part(o.release, '.', 1), '%Y-%m-%d')::DATE
            FROM read_parquet('{OV_META}') o
            JOIN partners p ON p.source = 'overture'
        UNION ALL
            SELECT {partner("fao", "f.iso3", "f.provider", "a.accessed", "NULL::DATE")}
            FROM read_csv('{RAW_DIR / "fao.csv"}', header = true) f
            LEFT JOIN read_parquet('{FAO_ACCESSED}') a USING (iso3)
            JOIN partners p ON p.source = 'fao'
        UNION ALL
            SELECT {partner("wfp", "w.iso3", "w.producer", "w.valid_from", "w.updated")}
            FROM (
                SELECT iso3, array_to_string(list_sort(list_distinct(list(source))), '; ') AS producer,
                    max(source_date) AS valid_from, max(lst_update) AS updated
                FROM read_parquet('{path_of("wfp_adm1")}') GROUP BY iso3
            ) w
            JOIN partners p ON p.source = 'wfp'
        UNION ALL
            SELECT {partner("unicef", "u.iso3", "p.provider", "u.valid_from", "NULL::DATE")}
            FROM (
                SELECT left(adm0_ucode, 3) AS iso3, max(start_date)::DATE AS valid_from
                FROM read_parquet('{path_of("unicef_adm1")}') GROUP BY 1
            ) u
            JOIN partners p ON p.source = 'unicef'
        UNION ALL
            SELECT {partner("unhcr", "h.iso3", "h.producer", "h.updated", "h.updated")}
            FROM (
                SELECT iso3, array_to_string(list_sort(list_distinct(list(source))), '; ') AS producer,
                    max(update_date) AS updated
                FROM read_parquet('{path_of("unhcr_adm1")}') GROUP BY iso3
            ) h
            JOIN partners p ON p.source = 'unhcr'
        UNION ALL
            -- WHO dates most units 2000-01-01, its start-of-record placeholder.
            SELECT {partner("who", "w.iso3", "p.provider", "w.valid_from", "NULL::DATE")}
            FROM (
                SELECT ISO_3_CODE AS iso3,
                    max(STARTDATE::DATE) FILTER (WHERE STARTDATE::DATE > DATE '2000-01-01') AS valid_from
                FROM read_parquet('{path_of("who_adm1")}') GROUP BY 1
            ) w
            JOIN partners p ON p.source = 'who'
        UNION ALL
            SELECT {partner("wb", "b.iso3", "p.provider", "d.produced", "NULL::DATE")}
            FROM (SELECT DISTINCT ISO_A3 AS iso3 FROM read_parquet('{path_of("wb_adm1")}')) b
            LEFT JOIN read_parquet('{WB_DATES}') d USING (iso3)
            JOIN partners p ON p.source = 'wb';

        -- UNHCR fills unknown dates with spreadsheet placeholders (1899-12-30, 1900-01-01).
        COPY (
            SELECT m.source, m.iso3, m.producer, m.publisher, m.licence, t.licence_url, l.notice, m.url,
                CASE WHEN m.valid_from > DATE '1900-01-01' THEN m.valid_from END AS valid_from,
                CASE WHEN m.updated > DATE '1900-01-01' THEN m.updated END AS updated,
                coalesce(d.selected_source = m.source, false) AS picked
            FROM metadata m
            LEFT JOIN read_csv('{RAW_DIR / "licence_terms.csv"}', header = true, all_varchar = true) t
                USING (licence)
            LEFT JOIN licences l ON l.source = m.source
            LEFT JOIN {DECISIONS} d ON d.iso3 = m.iso3
            ORDER BY m.source, m.iso3
        ) TO '{OUT}' {TABLE_OPTIONS};
    """)
    con.close()
    print(f"Wrote source metadata -> {OUT}")


if __name__ == "__main__":
    main()
