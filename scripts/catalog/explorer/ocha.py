"""OCHA admin 1-4 boundaries from COD-AB's per-location original layers on source.coop."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from boundaries import write_boundary
from common import COD_AB_BASE, COD_AB_CACHE, connect
from shared import http

ORIGINAL = f"{COD_AB_BASE}/original"
CACHE = COD_AB_CACHE / "original"
LEVELS = (1, 2, 3, 4)


def children(url: str) -> list[str]:
    return [
        link["href"] for link in http.get(url).json()["links"] if link["rel"] == "child"
    ]


def fetch(stem: str) -> Path:
    out = CACHE / f"{stem}.parquet"
    http.download(
        f"{ORIGINAL}/{stem[:3]}/latest/{stem}/{stem}.parquet", out, refresh=True
    )
    return out


def columns(level: int) -> list[str]:
    names = [
        f"adm{n}_{f}"
        for n in range(level + 1)
        for f in ("name", "name1", "name2", "name3", "pcode")
    ]
    return names + [
        "lang",
        "lang1",
        "lang2",
        "lang3",
        "valid_on",
        "valid_to",
        "version",
    ]


locations = [href.split("/")[1] for href in children(f"{ORIGINAL}/catalog.json")]
with ThreadPoolExecutor(8) as pool:
    layers = dict(
        zip(
            locations,
            pool.map(
                lambda iso3: children(f"{ORIGINAL}/{iso3}/latest/catalog.json"),
                locations,
            ),
        )
    )
    for level in LEVELS:
        stems = [
            f"{iso3}_admin{level}"
            for iso3, hrefs in layers.items()
            if f"./{iso3}_admin{level}/collection.json" in hrefs
        ]
        files = [str(f) for f in pool.map(fetch, stems)]
        source = f"read_parquet({files}, union_by_name = true, filename = true)"
        con = connect()
        present = {
            c for c, *_ in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
        }
        con.close()
        keep = ", ".join(f'"{c}"' for c in columns(level) if c in present)
        write_boundary(
            f"SELECT upper(parse_filename(filename)[:3]) AS iso3, {keep}, geometry FROM {source}",
            f"ocha_adm{level}",
        )
