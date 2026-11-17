"""Base map country outlines and boundary lines from bnda_cty.parquet and bndl.parquet in BASEMAP_DIR
(no public download), kept to the columns the map reads. Only the tiles go in the catalog."""

import os
from pathlib import Path

from cod_data.catalog.common import BASEMAP_BUILD, connect, path_of, tile_parquet
from cod_data.shared.geoparquet import write_geoparquet

BASEMAP_DIR = Path(os.environ.get("BASEMAP_DIR", "tmp/basemap"))

# The map draws bdytyp 1-4, 8, 9 and 99 (as text), promotes objectid and clicks on iso3cd.
for name, layer, columns, where in (
    ("basemap_adm0", "bnda_cty", "objectid, iso3cd", "true"),
    (
        "basemap_lines",
        "bndl",
        "bdytyp::VARCHAR AS bdytyp",
        "bdytyp IN (1, 2, 3, 4, 8, 9, 99)",
    ),
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
