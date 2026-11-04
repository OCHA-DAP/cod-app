"""FAO GAUL 2025 admin 1-2 boundaries from its zipped Shapefiles."""

import os
import zipfile
from pathlib import Path

from boundaries import scratch_dir, write_boundary
from shared import http

URL = "https://storage.googleapis.com/fao-maps-catalog-data/boundaries/GAUL_2025_L{level}.zip"
os.environ["OGR_ORGANIZE_POLYGONS"] = "ONLY_CCW"

with scratch_dir() as tmp:
    for level in (1, 2):
        zip_path = Path(tmp) / f"fao_l{level}.zip"
        http.download(URL.format(level=level), zip_path)
        with zipfile.ZipFile(zip_path) as z:
            shp = next(n for n in z.namelist() if n.endswith(".shp"))
        write_boundary(
            f"SELECT * EXCLUDE (geom), geom AS geometry FROM ST_Read('/vsizip/{zip_path}/{shp}') WHERE geom IS NOT NULL",
            f"fao_adm{level}",
        )
        zip_path.unlink()
