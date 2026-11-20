"""World Bank Official Boundaries admin 1-2 from its GeoParquet files, and each location's latest unit production date."""

import csv
import io
from pathlib import Path

from cod_data.catalog.common import WB_DATES, connect, path_of
from cod_data.catalog.explorer.boundaries import scratch_dir, write_boundary
from cod_data.shared import http
from cod_data.shared.geoparquet import TABLE_OPTIONS

FILES = "https://datacatalogfiles.worldbank.org/ddh-published/0038272"
# The Parquet resource's index of file links; its path carries the dataset version.
INDEX = f"{FILES}/3/DR0096331/DR0096331.csv"
ATTRIBUTES = f"{FILES}/DR0095374/WB_GAD_adm2_additional_columns.csv"

links = {
    r["file_name"]: r["download_link"]
    for r in csv.DictReader(io.StringIO(http.get(INDEX).text))
}
with scratch_dir() as tmp:
    for level in (1, 2):
        path = Path(tmp) / f"wb_adm{level}.parquet"
        http.download(
            links[f"World Bank Official Boundaries - Admin {level}.parquet"], path
        )
        write_boundary(f"SELECT * FROM read_parquet('{path}')", f"wb_adm{level}")
        path.unlink()
    attributes = Path(tmp) / "wb_adm2_attributes.csv"
    http.download(ATTRIBUTES, attributes)
    WB_DATES.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.execute(f"""
        COPY (
            SELECT b.ISO_A3 AS iso3, max(coalesce(
                try_cast(a.P_DATE AS DATE), make_date(try_cast(a.P_DATE AS INTEGER), 1, 1)
            )) AS produced
            FROM read_parquet('{path_of("wb_adm2")}') b
            JOIN read_csv('{attributes}', all_varchar=true) a USING (ADM2CD_c)
            GROUP BY 1
        ) TO '{WB_DATES}' {TABLE_OPTIONS}
    """)
    con.close()
