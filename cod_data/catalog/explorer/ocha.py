"""OCHA admin 1-4 boundaries from COD-AB's per-location original layers on source.coop, plus the
legacy COD-AB layers in COD_AB_LEGACY_DIR (copied once from fieldmaps/subnational) for locations COD-AB lacks."""

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cod_data.catalog.common import (
    COD_AB_BASE,
    COD_AB_CACHE,
    COD_AB_COLLECTIONS,
    COD_AB_LEGACY_DIR,
    connect,
    csv_to_parquet,
)
from cod_data.catalog.explorer.boundaries import write_boundary
from cod_data.catalog.explorer.dissolve import check_all, dissolved, rows
from cod_data.shared import http

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


def collection(iso3: str, hrefs: list[str]) -> list:
    """iso3, licence, publisher (the producer role) and update date from its shallowest collection."""
    level = min(
        n for n in (0, *LEVELS) if f"./{iso3}_admin{n}/collection.json" in hrefs
    )
    c = http.get(f"{ORIGINAL}/{iso3}/latest/{iso3}_admin{level}/collection.json").json()
    producer = next(
        (p["name"] for p in c.get("providers", []) if "producer" in p.get("roles", [])),
        None,
    )
    return [
        iso3.upper(),
        c.get("license"),
        producer,
        (c.get("updated") or "")[:10] or None,
    ]


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
if not COD_AB_LEGACY_DIR.is_dir():
    sys.exit(
        f"{COD_AB_LEGACY_DIR} not found, set COD_AB_LEGACY_DIR to the legacy COD-AB copy"
    )
legacy = [
    v
    for k, v in sorted(rows(COD_AB_LEGACY_DIR, ["cod-ab-legacy"]).items())
    if k not in locations
]
check_all(legacy)
LEGACY_COLUMNS = (
    "lang, lang1, lang2, lang3, src_date AS valid_on, valid_to, version, src_name"
)
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
    csv_to_parquet(
        [
            ["iso3", "licence", "publisher", "updated"],
            *pool.map(lambda i: collection(i, layers[i]), layers),
        ],
        COD_AB_COLLECTIONS,
        "SELECT iso3, licence, publisher, updated::DATE AS updated FROM {csv}",
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
        current = f"SELECT upper(parse_filename(filename)[:3]) AS iso3, {keep}, NULL::VARCHAR AS src_name, geometry FROM {source}"
        if any(lvl >= level for _, lvl, *_ in legacy):
            current = f"({current}) UNION ALL BY NAME ({dissolved(legacy, level, LEGACY_COLUMNS)})"
        write_boundary(current, f"ocha_adm{level}")
