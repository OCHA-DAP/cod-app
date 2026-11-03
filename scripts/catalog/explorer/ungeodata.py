"""UN Geodata 1M country outlines and lines from bnda_cty.parquet and bndl.parquet in UNGEODATA_DIR (no public download)."""

import os
from pathlib import Path

from boundaries import write_boundary

UNGEODATA_DIR = Path(os.environ.get("UNGEODATA_DIR", "tmp/ungeodata"))

# bdytyp 6 and 7 are subnational lines. The map promotes objectid, so no hover_id.
for name, layer, where in (
    ("ungeodata_adm0", "bnda_cty", "true"),
    ("ungeodata_lines", "bndl", "bdytyp NOT IN (6, 7)"),
):
    write_boundary(
        f"SELECT * FROM read_parquet('{UNGEODATA_DIR / f'{layer}.parquet'}') WHERE {where} ORDER BY objectid",
        name,
        make_valid=False,
        dates=False,
        hover_id=False,
        labels=False,
    )
