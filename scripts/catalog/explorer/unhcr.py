"""UNHCR admin 1-2 boundaries, fetched by object id from its ArcGIS feature services into a
resumable cache, each chunk checked against the ids it asked for."""

import os
import shutil
import sys
from pathlib import Path

from boundaries import DOWNLOADS, write_boundary
from common import connect
from httpx2 import HTTPError, Timeout
from shared.http import client
from tenacity import retry, stop_after_attempt, wait_exponential

LAYER = "https://gis.unhcr.org/arcgis/rest/services/core_v2/wrl_polbnd_adm{level}_a_unhcr/FeatureServer/0"
WHERE = "gis_status=14"
CACHE = DOWNLOADS / "unhcr"
TARGET_BYTES = 50 * 1024 * 1024
FIRST_CHUNK, MAX_CHUNK = 50, 500
TIMEOUT = Timeout(600, connect=30)
# Single UNHCR units reach 100 MB of GeoJSON, above GDAL's default per-feature limit.
os.environ["OGR_GEOJSON_MAX_OBJ_SIZE"] = "0"

TYPES = {
    "esriFieldTypeOID": "BIGINT",
    "esriFieldTypeSmallInteger": "INTEGER",
    "esriFieldTypeInteger": "INTEGER",
    "esriFieldTypeDouble": "DOUBLE",
    "esriFieldTypeSingle": "DOUBLE",
    "esriFieldTypeString": "VARCHAR",
    "esriFieldTypeGlobalID": "VARCHAR",
    "esriFieldTypeGUID": "VARCHAR",
    "esriFieldTypeDate": "TIMESTAMP",
}

retrying = retry(
    stop=stop_after_attempt(6), wait=wait_exponential(min=5, max=120), reraise=True
)


@retrying
def get_json(url: str, **params) -> dict:
    r = client.post(url, data={"f": "json", **params}, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    # ArcGIS reports failures as HTTP 200 with an error body.
    if "error" in data:
        raise RuntimeError(f"{url}: {data['error']}")
    return data


def object_ids(level: int) -> list[int]:
    data = get_json(
        f"{LAYER.format(level=level)}/query", where=WHERE, returnIdsOnly="true"
    )
    return sorted(data["objectIds"])


def fields(level: int) -> dict[str, str]:
    layer = get_json(LAYER.format(level=level))
    unknown = {f["type"] for f in layer["fields"]} - TYPES.keys()
    if unknown:
        sys.exit(f"unhcr_adm{level}: unmapped field types {unknown}")
    return {f["name"]: TYPES[f["type"]] for f in layer["fields"]}


def column(name: str, type_: str, present: set[str]) -> str:
    col = f'"{name}"'
    if name not in present:
        return f"NULL::{type_} AS {col}"
    if type_ == "TIMESTAMP":
        return f"make_timestamp({col}::BIGINT * 1000) AS {col}"
    return f"{col}::{type_} AS {col}"


def fetch_chunk(level: int, ids: list[int], cols: dict[str, str], out: Path) -> int:
    """Download ids as GeoJSON, check them, and write them to out as parquet; returns bytes."""
    raw = out.with_suffix(".geojson.part")
    params = {
        "objectIds": ",".join(map(str, ids)),
        "outFields": "*",
        "outSR": 4326,
        "f": "geojson",
    }
    with client.stream(
        "POST", f"{LAYER.format(level=level)}/query", data=params, timeout=TIMEOUT
    ) as r:
        r.raise_for_status()
        with raw.open("wb") as f:
            for block in r.iter_bytes(1 << 20):
                f.write(block)
    size = raw.stat().st_size
    try:
        head = raw.read_bytes()[:500] if size < 100_000 else b""
        if b'"error"' in head or b"exceededTransferLimit" in head:
            raise RuntimeError(f"unhcr_adm{level} {ids[0]}..{ids[-1]}: {head!r}")
        convert(raw, ids, cols, out)
    finally:
        raw.unlink(missing_ok=True)
    return size


def convert(raw: Path, ids: list[int], cols: dict[str, str], out: Path) -> None:
    """Write the GeoJSON chunk raw to out with the layer's types, if it holds exactly ids."""
    part = out.with_suffix(".parquet.part")
    con = connect()
    try:
        present = {
            r[0]
            for r in con.execute(f"DESCRIBE SELECT * FROM ST_Read('{raw}')").fetchall()
        }
        select = ", ".join(column(n, t, present) for n, t in cols.items())
        con.execute(
            f"CREATE TABLE chunk AS SELECT {select}, geom FROM ST_Read('{raw}')"
        )
        got, nulls = con.execute(
            "SELECT list(objectid ORDER BY objectid), count(*) FILTER (geom IS NULL) FROM chunk"
        ).fetchone()
        if got != ids:
            raise RuntimeError(
                f"{out.name}: asked {len(ids)} ids, got {len(got or [])}"
            )
        if nulls:
            raise RuntimeError(f"{out.name}: {nulls} null geometries")
        con.execute(f"COPY chunk TO '{part}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    finally:
        con.close()
    part.replace(out)


def cached_ids(cache: Path) -> set[int]:
    files = sorted(cache.glob("[0-9]*.parquet"))
    if not files:
        return set()
    con = connect()
    rows = con.execute(
        f"SELECT objectid FROM read_parquet({[str(f) for f in files]})"
    ).fetchall()
    con.close()
    return {r[0] for r in rows}


def download(level: int, ids: list[int], cols: dict[str, str], cache: Path) -> None:
    todo = sorted(set(ids) - cached_ids(cache))
    done, size, ceiling = len(ids) - len(todo), FIRST_CHUNK, MAX_CHUNK
    print(f"unhcr_adm{level}: {done}/{len(ids)} cached", file=sys.stderr)
    while todo:
        chunk = todo[:size]
        out = cache / f"{chunk[0]:06d}_{chunk[-1]:06d}.parquet"
        # The server fails on chunks above a size it doesn't publish, so split at once and
        # cap later chunks there; only single ids get the full retries.
        fetch = retrying(fetch_chunk) if len(chunk) == 1 else fetch_chunk
        try:
            nbytes = fetch(level, chunk, cols, out)
        except (HTTPError, RuntimeError, OSError) as e:
            if len(chunk) == 1:
                raise RuntimeError(
                    f"unhcr_adm{level}: id {chunk[0]} keeps failing"
                ) from e
            size = ceiling = max(1, len(chunk) // 2)
            print(
                f"unhcr_adm{level}: chunk failed ({e}), retrying {size} ids",
                file=sys.stderr,
            )
            continue
        todo, done = todo[len(chunk) :], done + len(chunk)
        fit = int(len(chunk) * TARGET_BYTES / max(nbytes, 1))
        ceiling = min(MAX_CHUNK, ceiling + max(1, ceiling // 10))
        size = max(1, min(fit, size * 2, ceiling))
        print(
            f"unhcr_adm{level}: {done}/{len(ids)} ({len(chunk)} ids, {nbytes / 1e6:.0f} MB)",
            file=sys.stderr,
        )


def write_level(level: int) -> None:
    name = f"unhcr_adm{level}"
    cache = CACHE / f"adm{level}"
    cache.mkdir(parents=True, exist_ok=True)
    cols = fields(level)
    ids = object_ids(level)
    download(level, ids, cols, cache)
    now = object_ids(level)
    if now != ids:
        added, removed = sorted(set(now) - set(ids)), sorted(set(ids) - set(now))
        sys.exit(
            f"{name}: ids changed during download (+{added[:20]} -{removed[:20]}), rerun"
        )
    con = connect()
    con.execute(f"CREATE TABLE ids AS SELECT unnest({ids}) AS objectid")
    con.execute(f"COPY ids TO '{cache / 'ids.parquet'}' (FORMAT PARQUET)")
    con.close()
    files = [str(f) for f in sorted(cache.glob("[0-9]*.parquet"))]
    select = f"""
        SELECT * EXCLUDE (geom), geom AS geometry FROM read_parquet({files})
        WHERE objectid IN (SELECT objectid FROM read_parquet('{cache / "ids.parquet"}'))
        ORDER BY objectid
    """
    con = connect()
    n, distinct = con.execute(
        f"SELECT count(*), count(DISTINCT objectid) FROM ({select})"
    ).fetchone()
    con.close()
    if n != len(ids) or distinct != len(ids):
        sys.exit(
            f"{name}: cache has {n} rows, {distinct} ids, server reports {len(ids)}"
        )
    out = write_boundary(select, name)
    con = connect()
    rows = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    con.close()
    if rows != len(ids):
        sys.exit(f"{out}: {rows} rows, server reports {len(ids)}")
    shutil.rmtree(cache)


if __name__ == "__main__":
    for level in (1, 2):
        write_level(level)
