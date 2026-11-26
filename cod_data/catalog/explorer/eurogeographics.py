"""EuroGeographics admin 1-4 boundaries: EuroRegionalMap (ERM_DIR) per country, EuroGlobalMap
(EGM_DIR) for BIH, GRL and SRB, each ingested from its GeoPackage and dissolved per level."""

import importlib.metadata
import json
import os
import re
import shutil
import sys
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import NamedTuple

import duckdb

from cod_data.catalog.common import connect, path_of
from cod_data.catalog.explorer.boundaries import write_boundary
from cod_data.catalog.explorer.dissolve import check_all, dissolved, quote, rows
from cod_data.catalog.global_build import extend
from cod_data.catalog.global_build.extend import clean_layer
from cod_data.shared.geoparquet import write_geoparquet

CACHE = Path("tmp/catalog/cache/eurogeographics")
LEVELS = (1, 2, 3, 4)
# Latin-script names, preferred when a unit has no name in the layer's first language.
LATIN = r"[\p{Latin}\p{Common}\p{Inherited}]+"
LICENSE = "EuroGeographics Open Data Licence 2024"

# ISO 639-2/B to the ISO 639-1 codes cod-ab uses; others keep their 3 letters.
LANGS = {
    "alb": "sq", "baq": "eu", "bos": "bs", "cat": "ca", "cze": "cs",
    "dan": "da", "dut": "nl", "eng": "en", "est": "et", "fao": "fo",
    "fin": "fi", "fre": "fr", "fry": "fy", "geo": "ka", "ger": "de",
    "gla": "gd", "gle": "ga", "gre": "el", "hrv": "hr", "ice": "is",
    "ita": "it", "kal": "kl", "lav": "lv", "lit": "lt", "mkd": "mk",
    "mlt": "mt", "nor": "no", "pol": "pl", "por": "pt", "roh": "rm",
    "rum": "ro", "slo": "sk", "slv": "sl", "spa": "es", "srp": "sr",
    "swe": "sv", "ukr": "uk", "val": "ca", "wel": "cy",
}  # fmt: skip


class Product(NamedTuple):
    """One EuroGeographics product and how its PolbndA maps to levels."""

    src: str
    src_grp: str
    root: Path
    gpkg: str
    shn: int
    taa_keep: tuple[int, ...]
    taa_coastal: int
    skip: dict[str, set[int]]
    merge: dict[str, str]
    split: dict[str, dict[str, tuple[str, str]]]
    extra: dict[str, tuple[str, str]]
    agencies: Callable[[Path, list[str]], list[str]]
    only: set[str] | None


_ORG = re.compile(r"<gmd:organisationName>\s*<gco:CharacterString>([^<]+)")


def _erm_agencies(root: Path, iccs: list[str]) -> list[str]:
    """Each ICC's mapping agency from its ERM country metadata XML."""
    found = []
    for icc in iccs:
        xml = next((root / "Metadata" / "Countries").glob(f"{icc}_ERM_*_Metadata.xml"))
        if org := _ORG.search(xml.read_text(encoding="utf-8")):
            found.append(org[1].strip())
    return found


# Copyright holder per ICC, from the EGM User Guide.
_EGM_AGENCIES = {
    "BA": "Federal Administration for Geodetic and Real Property Affairs",
    "GL": "Kort og Matrikelstyrelsen",
    "RS": "Republički geodetski zavod",
}

ERM = Product(
    src="erm",
    src_grp="ERM",
    root=Path(os.environ.get("ERM_DIR", "tmp/eurogeographics/erm")),
    gpkg="data/FullEurope/FullEurope.gpkg",
    shn=5,
    # Kept area types: 1 main, 3 branch, 4 special, 5 coastal water, 7 inland water.
    taa_keep=(1, 3, 4, 5, 7),
    taa_coastal=5,
    # ERM orders (USE 2..6) left out, matching Mapbox Boundaries v4.7 levels.
    skip={
        "DE": {3, 5},
        "FR": {5},
        "GF": {5},
        "GP": {5},
        "MQ": {5},
        "RE": {5},
        "YT": {5},
        "GB": {5},
        "CY": {4},
        "FI": {2, 4},
        "IE": {2},
        "PT": {2},
    },
    # ICC folded into another country's layer.
    merge={"ND": "GB"},
    # ICC whose units under one adm1 code form another country: (iso2, name).
    split={"FI": {"FI72100000": ("AX", "Åland Islands")}},
    extra={},
    agencies=_erm_agencies,
    only=None,
)
EGM = Product(
    src="egm",
    src_grp="EGM",
    root=Path(os.environ.get("EGM_DIR", "tmp/eurogeographics/egm")),
    gpkg="DATA/FullEurope/EuroGlobalMap_*.gpkg",
    shn=4,
    # Kept area types: 2 main, 5 coastal water; 8 (in dispute) has no codes.
    taa_keep=(2, 5),
    taa_coastal=5,
    # RS: USE 2 codes only Vojvodina and Kosovo, USE 4 only a few cities.
    skip={"RS": {2, 4}},
    merge={"ND": "GB"},
    split={},
    # Serbia is only in the option layers; optionRS keeps Kosovo within Serbia.
    extra={"RS": ("PolbndA_optionRS", "EBM_NAM_optionRS")},
    agencies=lambda _root, iccs: [_EGM_AGENCIES[i] for i in iccs if i in _EGM_AGENCIES],
    only={"BA", "GL", "RS"},
)


def _gpkg(product: Product) -> Path:
    found = sorted(product.root.glob(product.gpkg))
    if len(found) != 1:
        sys.exit(f"{product.root}: expected one {product.gpkg}, found {found}")
    return found[0]


def _load(con: duckdb.DuckDBPyConnection, product: Product, gpkg: Path) -> None:
    """Load the kept PolbndA pieces as `k` and split EBM_NAM names as `nam`."""
    merge = " ".join(f"WHEN '{a}' THEN '{b}'" for a, b in product.merge.items())
    langs = " ".join(f"WHEN '{a}' THEN '{b}'" for a, b in LANGS.items())
    polys = ["PolbndA", *(p for p, _ in product.extra.values())]
    names = ["EBM_NAM", *(n for _, n in product.extra.values())]

    def read(layers: list[str]) -> str:
        return " UNION ALL BY NAME ".join(
            f"SELECT * FROM ST_Read('{gpkg}', layer = '{n}')" for n in layers
        )

    con.execute(f"CREATE OR REPLACE TABLE pa AS {read(polys)}")
    con.execute(f"""
        CREATE OR REPLACE TABLE k AS
        SELECT *, CASE ICC {merge} ELSE ICC END AS cc
        FROM pa
        WHERE TAA IN ({", ".join(map(str, product.taa_keep))})
          AND ICC NOT LIKE '%#%' AND ICC <> 'XX'
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE nam AS
        SELECT
            SHN AS code,
            string_split(NAMN, '#') AS names,
            list_transform(string_split(NLN, '#'), lambda x:
                CASE x {langs} WHEN 'UNK' THEN NULL ELSE x END) AS langs,
            NULLIF(left(effectiveDate::VARCHAR, 10), '1900-01-01')::DATE AS valid_from
        FROM ({read(names)})
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE cc_names AS
        SELECT EuroGeographics_Country_Code AS icc, name_english_short, name_national
        FROM ST_Read('{gpkg}', layer = 'CountryCodes')
    """)


def _orders(con: duckdb.DuckDBPyConnection, product: Product, cc: str) -> list[int]:
    """The USE orders of cc that hold codes and that skip keeps."""
    uses = range(2, product.shn + 2)
    present = con.execute(
        "SELECT "
        + ", ".join(f"bool_or(SHN{u - 1} <> 'UNK')" for u in uses)
        + " FROM k WHERE cc = ?",
        [cc],
    ).fetchall()[0]
    return [
        u
        for u, has in zip(uses, present, strict=True)
        if has and u not in product.skip.get(cc, set())
    ]


def _pieces(
    con: duckdb.DuckDBPyConnection, product: Product, cc: str, orders: list[int]
) -> None:
    """Build table `p` of pieces with codes c0..c{lvl}, gaps filled from the parent.

    Land gaps join the longest-border sibling, else the nearest; water needs leaf codes.
    """
    lvl = len(orders)
    coastal = product.taa_coastal
    raw = ", ".join(
        f"NULLIF(SHN{u - 1}, 'UNK') AS c{i}" for i, u in enumerate(orders, 1)
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE p AS
        SELECT row_number() OVER () AS pid, NULLIF(SHN0, 'UNK') AS c0, {raw}, geom
        FROM k WHERE cc = ? AND TAA <> {coastal}
    """,
        [cc],
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE p5 AS
        SELECT NULLIF(SHN{orders[-1] - 1}, 'UNK') AS c{lvl}, geom
        FROM k WHERE cc = ? AND TAA = {coastal}
    """,
        [cc],
    )
    for i in range(1, lvl + 1):
        con.execute(f"""
            UPDATE p SET c{i} = c{i - 1}
            WHERE c{i} IS NULL AND c{i - 1} NOT IN (
                SELECT c{i - 1} FROM p WHERE c{i} IS NOT NULL
            )
        """)
        deeper = ", ".join(f"c{j} = n.c{j}" for j in range(i, lvl + 1))
        con.execute(f"""
            UPDATE p SET {deeper}
            FROM (
                SELECT f.pid, arg_max(
                    n.pid, ST_Length(ST_Intersection(f.geom, n.geom))
                ) AS nid
                FROM p f JOIN p n
                  ON f.c{i} IS NULL AND n.c{i} IS NOT NULL
                 AND f.c{i - 1} = n.c{i - 1} AND ST_Intersects(f.geom, n.geom)
                GROUP BY f.pid
            ) AS a, p AS n
            WHERE p.pid = a.pid AND n.pid = a.nid
        """)
        con.execute(f"""
            UPDATE p SET {deeper}
            FROM (
                SELECT f.pid, arg_min(n.pid, ST_Distance(f.geom, n.geom)) AS nid
                FROM p f JOIN p n
                  ON f.c{i} IS NULL AND n.c{i} IS NOT NULL
                 AND f.c{i - 1} = n.c{i - 1}
                GROUP BY f.pid
            ) AS a, p AS n
            WHERE p.pid = a.pid AND n.pid = a.nid
        """)
        dropped = con.execute(
            f"DELETE FROM p WHERE c{i} IS NULL RETURNING pid"
        ).fetchall()
        if dropped:
            print(f"{cc}: dropped {len(dropped)} untouched level-{i} fragments")
    upper = ", ".join(f"u.c{j}" for j in range(lvl))
    con.execute(f"""
        INSERT INTO p
        SELECT (SELECT max(pid) FROM p) + row_number() OVER (),
            {upper}, w.c{lvl}, w.geom
        FROM p5 w
        JOIN (SELECT DISTINCT {", ".join(f"c{j}" for j in range(lvl + 1))} FROM p) u
          ON u.c{lvl} = w.c{lvl}
    """)


def _check(con: duckdb.DuckDBPyConnection, cc: str, lvl: int) -> None:
    """Exit unless every piece has a country code, nests cleanly, and has names."""
    if con.execute("SELECT count(*) FROM p WHERE c0 IS NULL").fetchall()[0][0]:
        sys.exit(f"{cc}: pieces with no country code")
    for i in range(1, lvl + 1):
        bad = con.execute(
            f"SELECT c{i} FROM p GROUP BY c{i} "
            f"HAVING count(DISTINCT c{i - 1}) > 1 LIMIT 5"
        ).fetchall()
        if bad:
            sys.exit(f"{cc}: level {i} units with several parents: {bad}")
    union = " UNION ".join(f"SELECT c{i} AS code FROM p" for i in range(1, lvl + 1))
    missing = con.execute(
        f"SELECT code FROM ({union}) WHERE code NOT IN (SELECT code FROM nam) LIMIT 5"
    ).fetchall()
    if missing:
        sys.exit(f"{cc}: codes with no EBM_NAM name: {missing}")


def _names(con: duckdb.DuckDBPyConnection, lvl: int) -> tuple[list, date | None]:
    """Build `un`, one name per layer language for every unit in `pt`, and return the
    languages (ranked by units named in them, at most 4) and the latest name date."""
    codes = " UNION ".join(f"SELECT c{i} FROM pt" for i in range(1, lvl + 1))
    con.execute(f"""
        CREATE OR REPLACE TABLE un_pairs AS
        SELECT code, i, names[i] AS name, langs[i] AS lang
        FROM (
            SELECT code, names, langs, unnest(generate_series(1, len(names))) AS i
            FROM nam WHERE code IN ({codes})
        )
    """)
    langs, valid_from = con.execute(f"""
        SELECT
            (SELECT list(lang ORDER BY n DESC, lang)[1:4] FROM (
                SELECT lang, count(DISTINCT code) AS n FROM un_pairs
                WHERE lang IS NOT NULL GROUP BY lang
            )),
            (SELECT max(valid_from) FROM nam WHERE code IN ({codes}))
    """).fetchall()[0]
    langs = [*(langs or []), None, None, None, None][:4]
    first = "min_by(name, i) FILTER (lang = ${})"
    con.execute(
        f"""
        CREATE OR REPLACE TABLE un AS
        SELECT code,
            coalesce(
                {first.format(1)},
                min_by(name, i) FILTER (regexp_full_match(name, '{LATIN}'))
            ) AS n0,
            {first.format(2)} AS n1, {first.format(3)} AS n2, {first.format(4)} AS n3
        FROM un_pairs GROUP BY code
    """,
        langs,
    )
    return langs, valid_from


def _write(
    con: duckdb.DuckDBPyConnection,
    product: Product,
    icc: str,
    iso3: str,
    adm0: tuple,
    lvl: int,
    agencies: list[str],
) -> None:
    """Dissolve `pt` per leaf into CACHE/<key>/, cleaned, with its metadata sidecar."""
    langs, valid_from = _names(con, lvl)
    key = iso3.lower()
    out = CACHE / key
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    group = ", ".join(f"c{i}" for i in range(1, lvl + 1))
    levels = ", ".join(
        f"n{i}.n0 AS adm{i}_name, n{i}.n1 AS adm{i}_name1, "
        f"n{i}.n2 AS adm{i}_name2, n{i}.n3 AS adm{i}_name3, d.c{i} AS adm{i}_pcode"
        for i in range(lvl, 0, -1)
    )
    joins = " ".join(f"JOIN un n{i} ON n{i}.code = d.c{i}" for i in range(1, lvl + 1))
    adm0_names = ", ".join(
        f"{quote(v)}::VARCHAR AS adm0_{c}"
        for v, c in zip(
            (*adm0, None, None), ("name", "name1", "name2", "name3"), strict=True
        )
    )
    lang_cols = ", ".join(
        f"{quote(v)}::VARCHAR AS lang{s}"
        for v, s in zip(langs, ("", "1", "2", "3"), strict=True)
    )
    raw = work / f"{key}_raw.parquet"
    write_geoparquet(
        con,
        f"""
        WITH d AS (
            SELECT {group}, ST_Transform(
                ST_MakeValid(ST_Union_Agg(geom)), 'EPSG:4258', 'EPSG:4326', true
            ) AS geometry
            FROM pt GROUP BY {group}
        )
        SELECT {levels}, {adm0_names}, '{icc}' AS adm0_pcode, {lang_cols},
            '{iso3}' AS iso3, d.geometry
        FROM d {joins}
        """,
        raw,
    )
    # Cleaned at ingest: EGM BIH and SRB overlap and leave gaps, and ERM has small gaps.
    shutil.move(clean_layer(con, raw, work), out / f"{key}_original.parquet")
    shutil.rmtree(work)
    meta = {
        "key": key,
        "tier": "original",
        "iso3": iso3,
        "src": product.src,
        "src_lvl": lvl,
        "src_date": valid_from.isoformat() if valid_from else None,
        "src_name": "; ".join(agencies) or None,
        "src_name1": "EuroGeographics",
        "src_lic": LICENSE,
        "src_grp": product.src_grp,
    }
    (out / f"{key}_metadata.json").write_text(json.dumps({"rows": [meta]}, indent=2))


def ingest(product: Product, iso3: dict[str, str]) -> None:
    """Rewrite product's CACHE layers unless they are newer than every input and were
    cleaned with the installed topo-tools."""
    gpkg = _gpkg(product)
    stamp = CACHE / f".{product.src}.done"
    inputs = [
        gpkg,
        Path(__file__),
        Path(extend.__file__),
        path_of("iso3166"),
        *product.root.glob("Metadata/Countries/*.xml"),
    ]
    newest = max(p.stat().st_mtime for p in inputs)
    tools = importlib.metadata.version("topo-tools")
    if stamp.exists() and stamp.stat().st_mtime > newest and stamp.read_text() == tools:
        return
    for key in rows(CACHE, [product.src]):
        shutil.rmtree(CACHE / key)
    con = connect()
    _load(con, product, gpkg)
    countries = [
        r[0] for r in con.execute("SELECT DISTINCT cc FROM k ORDER BY cc").fetchall()
    ]
    for cc in countries:
        if product.only is not None and cc not in product.only:
            continue
        orders = _orders(con, product, cc)
        lvl = len(orders)
        if lvl == 0:
            print(f"{product.src} {cc}: no subnational orders, skipping")
            continue
        if lvl > max(LEVELS):
            sys.exit(f"{cc}: {lvl} orders {orders} exceed {max(LEVELS)}, add a skip")
        _pieces(con, product, cc, orders)
        _check(con, cc, lvl)
        adm0 = con.execute(
            "SELECT name_english_short, name_national FROM cc_names WHERE icc = ?", [cc]
        ).fetchall()
        split = product.split.get(cc, {})
        parts = [
            (
                cc,
                adm0[0] if adm0 else (None, None),
                "NOT list_contains(?::VARCHAR[], c1)",
                [*split],
            )
        ]
        parts += [(i, (n, None), "c1 = ?", code) for code, (i, n) in split.items()]
        merged = [cc, *(a for a, b in product.merge.items() if b == cc)]
        agencies = product.agencies(product.root, merged)
        for icc, names, where, arg in parts:
            if icc not in iso3:
                sys.exit(f"{product.src} {icc}: no iso3 in iso3166")
            con.execute(
                f"CREATE OR REPLACE TABLE pt AS SELECT * FROM p WHERE {where}", [arg]
            )
            _write(con, product, icc, iso3[icc], names, lvl, agencies)
            print(f"{product.src} {icc}: orders {orders}")
    con.close()
    stamp.write_text(tools)


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    con = connect()
    iso3 = dict(
        con.execute(f"SELECT iso2, iso3 FROM '{path_of('iso3166')}'").fetchall()
    )
    con.close()
    for product in (ERM, EGM):
        ingest(product, iso3)
    if both := rows(CACHE, [ERM.src]).keys() & rows(CACHE, [EGM.src]).keys():
        sys.exit(f"EGM locations also in ERM: {sorted(both)}")
    found = rows(CACHE, [ERM.src, EGM.src])
    sources = [found[k] for k in sorted(found)]
    check_all(sources)
    for level in LEVELS:
        write_boundary(
            dissolved(sources, level, "lang, lang1, lang2, lang3, src_name, src_date"),
            f"eurogeographics_adm{level}",
        )


if __name__ == "__main__":
    main()
