"""UNICEF admin 1-4 boundaries from the unicef_adm{1..4}.geojson exports in UNICEF_DIR (no public download)."""

import os
from pathlib import Path

from boundaries import write_boundary

UNICEF_DIR = Path(os.environ.get("UNICEF_DIR", "tmp/unicef"))
os.environ["OGR_ORGANIZE_POLYGONS"] = "ONLY_CCW"

for level in (1, 2, 3, 4):
    write_boundary(
        f"SELECT * EXCLUDE (geom), geom AS geometry FROM ST_Read('{UNICEF_DIR / f'unicef_adm{level}.geojson'}')",
        f"unicef_adm{level}",
        dates=False,
    )
