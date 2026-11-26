"""geoBoundaries gbOpen admin 1-4 per location from its current release, each level as served."""

import json
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cod_data.catalog.common import COD_AB_CACHE, connect
from cod_data.catalog.explorer.boundaries import write_boundary
from cod_data.shared import http

API = "https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/"
CACHE = COD_AB_CACHE.parent / "geoboundaries"
META = CACHE / "meta.parquet"
LEVELS = range(1, 5)


def catalogue() -> list[dict]:
    """The current release's admin 1-4 boundaries, each with its snapshot and cached file path."""
    rows = []
    for r in http.get(API).json():
        n = int(r["boundaryType"].removeprefix("ADM"))
        if n not in LEVELS:
            continue
        snapshot = re.search(r"/snapshots/([0-9a-f]+)/", r["gjDownloadURL"]).group(1)
        rows.append(
            {
                **r,
                "level": n,
                "snapshot": snapshot,
                "path": str(CACHE / snapshot / f"{r['boundaryISO']}_ADM{n}.zip"),
            }
        )
    return rows


def fetch(row: dict) -> None:
    """Download the shapefile zip, which sits beside the listed GeoJSON and is a fraction of its size."""
    path = Path(row["path"])
    if not path.exists():
        http.download(row["gjDownloadURL"].removesuffix(".geojson") + ".zip", path)


def unmangle(name: str) -> str:
    """Undo UTF-8 read as cp1252 or Latin-1, repeatedly (CAN ADM3 has names encoded twice)."""
    while True:
        for codec in ("cp1252", "latin-1"):
            try:
                fixed = name.encode(codec).decode("utf-8")
                break
            except UnicodeError:
                continue
        else:
            return name
        if fixed == name:
            return name
        name = fixed


def stage(rows: list[dict]) -> None:
    """Write each level as served, with duplicate shapeIDs suffixed and mis-encoded names repaired."""
    con = connect()
    for n in LEVELS:
        reads = " UNION ALL ".join(
            f"SELECT '{r['boundaryISO']}' AS iso3, nullif(trim(shapeName), '') AS name, shapeID AS pcode, "
            f"ST_SetCRS(ST_CollectionExtract(ST_MakeValid(geom), 3), 'OGC:CRS84') AS geometry "
            f"FROM ST_Read('/vsizip/{r['path']}')"
            for r in rows
            if r["level"] == n
        )
        con.execute(f"""
            CREATE TABLE raw{n} AS
            SELECT iso3, name,
                pcode || CASE WHEN count(*) OVER (PARTITION BY iso3, pcode) > 1
                    THEN '-' || row_number() OVER (PARTITION BY iso3, pcode ORDER BY name, ST_AsWKB(geometry)) ELSE '' END AS pcode,
                geometry
            FROM ({reads})
        """)
    mangled = {
        name
        for n in LEVELS
        for (name,) in con.execute(
            f"SELECT DISTINCT name FROM raw{n} WHERE regexp_matches(name, '[ÃÂ]')"
        ).fetchall()
    }
    con.execute("CREATE TABLE fixes (bad VARCHAR, good VARCHAR)")
    con.executemany(
        "INSERT INTO fixes VALUES (?, ?)",
        [(m, f) for m in mangled if (f := unmangle(m)) != m],
    )
    print(
        f"Repaired {con.execute('SELECT count(*) FROM fixes').fetchall()[0][0]} mis-encoded names"
    )
    for n in LEVELS:
        path = CACHE / rows[0]["snapshot"] / f"adm{n}.parquet"
        con.execute(f"""
            COPY (
                SELECT r.iso3, r.iso3 AS adm0_pcode, coalesce(f.good, r.name) AS adm{n}_name,
                    r.pcode AS adm{n}_pcode, r.geometry
                FROM raw{n} r LEFT JOIN fixes f ON f.bad = r.name
                ORDER BY r.iso3, r.pcode
            ) TO '{path}' (FORMAT PARQUET)
        """)
        write_boundary(f"SELECT * FROM read_parquet('{path}')", f"geoboundaries_adm{n}")
        path.unlink()
    con.close()


def main() -> None:
    rows = catalogue()
    snapshots = {r["snapshot"] for r in rows}
    if len(snapshots) != 1:
        raise ValueError(f"geoBoundaries current spans several snapshots: {snapshots}")
    snapshot = snapshots.pop()
    print(f"geoBoundaries current snapshot {snapshot}: {len(rows)} files")
    for old in CACHE.glob("*/"):
        if old.name != snapshot:
            shutil.rmtree(old)
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(fetch, rows))
    listing = CACHE / "catalogue.json"
    listing.write_text(json.dumps(rows))
    connect().execute(f"""
        COPY (
            SELECT boundaryISO AS iso3, level, snapshot, boundaryLicense AS licence,
                boundarySource AS source, boundarySourceURL AS url,
                list_max(regexp_extract_all(boundaryYearRepresented, '(?:19|20)\\d\\d'))::INTEGER AS year,
                strptime(buildDate, '%b %d, %Y')::DATE AS built
            FROM read_json_auto('{listing}')
            ORDER BY iso3, level
        ) TO '{META}' (FORMAT PARQUET)
    """)
    stage(rows)


if __name__ == "__main__":
    main()
