"""FAO GAUL 2025 admin 1-2 boundaries from its zipped Shapefiles, and the date FAO accessed each location's source."""

import os
import zipfile
from pathlib import Path

from cod_data.catalog.common import FAO_ACCESSED, connect
from cod_data.catalog.explorer.boundaries import scratch_dir, write_boundary
from cod_data.shared import http
from cod_data.shared.geoparquet import TABLE_OPTIONS

URL = "https://storage.googleapis.com/fao-maps-catalog-data/boundaries/GAUL_2025_L{level}.zip"
os.environ["OGR_ORGANIZE_POLYGONS"] = "ONLY_CCW"
# Citations end "[Accessed on 6 January 2026]", some with the month abbreviated.
ACCESSED = r"""try_strptime(regexp_extract(COLUMNS('Full citation.*'), 'Accessed on ([^\]]+)\]', 1),
    ['%d %B %Y', '%d %b %Y'])::DATE"""

with scratch_dir() as tmp:
    sheets = []
    for level in (1, 2):
        zip_path = Path(tmp) / f"fao_l{level}.zip"
        http.download(URL.format(level=level), zip_path)
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            shp = next(n for n in names if n.endswith(".shp"))
            sheet = next(n for n in names if n.endswith("_Metadata.xlsx"))
            sheets.append(z.extract(sheet, tmp))
        write_boundary(
            f"SELECT * EXCLUDE (geom), geom AS geometry FROM ST_Read('/vsizip/{zip_path}/{shp}') WHERE geom IS NOT NULL",
            f"fao_adm{level}",
        )
        zip_path.unlink()
    FAO_ACCESSED.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.execute("INSTALL excel; LOAD excel")
    union = " UNION ALL ".join(
        f"SELECT \"ISO3\" AS iso3, {ACCESSED} AS accessed FROM read_xlsx('{s}')"
        for s in sheets
    )
    con.execute(
        f"COPY (SELECT iso3, max(accessed) AS accessed FROM ({union}) GROUP BY iso3) "
        f"TO '{FAO_ACCESSED}' {TABLE_OPTIONS}"
    )
    con.close()
