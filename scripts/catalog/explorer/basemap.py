"""Base map country outlines and boundary lines from bnda_cty.parquet and bndl.parquet in BASEMAP_DIR
(no public download), kept to the columns the map reads. Only the tiles go in the catalog."""

import os
from pathlib import Path

from common import BASEMAP_BUILD, connect, path_of, tile_parquet
from shared.geoparquet import write_geoparquet

BASEMAP_DIR = Path(os.environ.get("BASEMAP_DIR", "tmp/basemap"))

# bdytyp 6 and 7 are subnational lines; the map filters bdytyp as text, promotes objectid and clicks on iso3cd.
for name, layer, columns, where in (
    ("basemap_adm0", "bnda_cty", "objectid, iso3cd", "true"),
    ("basemap_lines", "bndl", "bdytyp::VARCHAR AS bdytyp", "bdytyp NOT IN (6, 7)"),
):
    out = BASEMAP_BUILD / f"{name}.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    write_geoparquet(
        con,
        f"SELECT {columns}, geometry FROM read_parquet('{BASEMAP_DIR / f'{layer}.parquet'}') "
        f"WHERE {where} ORDER BY objectid",
        out,
    )
    con.close()
    tile_parquet(out, path_of(name, "pmtiles"), name)
    print(f"Wrote {out} and its tiles")
