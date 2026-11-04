"""WFP admin 1-4 boundaries from its public GeoParquet downloads."""

from pathlib import Path

from boundaries import scratch_dir, write_boundary
from shared import http

URL = "https://data.earthobservation.vam.wfp.org/public-share/boundaries/ge_adm{level}.parquet"

with scratch_dir() as tmp:
    for level in (1, 2, 3, 4):
        file = Path(tmp) / f"wfp_adm{level}.parquet"
        http.download(URL.format(level=level), file)
        write_boundary(
            f"SELECT * EXCLUDE (shape), shape AS geometry FROM read_parquet('{file}')",
            f"wfp_adm{level}",
        )
        file.unlink()
