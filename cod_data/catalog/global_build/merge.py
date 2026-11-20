"""Merge each location's build into the global adm{n}_polygons, points and lines layers."""

import hashlib
from pathlib import Path

import duckdb
from packaging.version import Version

from cod_data.catalog.common import connect
from cod_data.catalog.global_build.config import (
    FINGERPRINT_FILE,
    GLOBAL_ROW_GROUP,
    MAX_LVL,
    PROD_THREADS,
    VALID_FROM_FILE,
    VERSION_FILE,
)
from cod_data.shared.geoparquet import HILBERT, write_geoparquet

LANG = ("lang", "lang1", "lang2", "lang3")
MERGE_FINGERPRINT = "merge_fingerprint.txt"
AREA = "ST_Area(ST_Transform(geometry, 'OGC:CRS84', 'EPSG:8857')) / 1e6"


def level_cols(n: int) -> list[str]:
    """schema.md's per-level fields, level n first, down to adm0."""
    return [
        f"adm{k}_{c}"
        for k in range(n, -1, -1)
        for c in ("pcode", "name", "name1", "name2", "name3", "type", "srcid")
    ]


SPEC_TAIL = [
    "version",
    "updated",
    "valid_from",
    "valid_to",
    *LANG,
    "area_sqkm",
    "level",
]
CONSTANT = ["version", "updated", "valid_from", "valid_to", *LANG]


def polygons_sql(work: Path, n: int) -> str:
    """Level-n polygons in schema.md's field order, deepest level first, with spec metadata."""
    cols = level_cols(n)
    valid_from = (work / VALID_FROM_FILE).read_text().strip()
    valid_from = f"DATE '{valid_from}'" if valid_from else "NULL::DATE"
    # Fill parts of one iso3 (AUS's islands) share a code, so they merge into one row.
    # Fill rows carry the ADM0 layer's English names. A location's lang{i} is set on all its
    # rows when any of its units has a name{i}.
    langs = [
        f"CASE WHEN coalesce({', '.join(f'adm{k}_name{i}' for k in range(1, n + 1))}) "
        f"IS NOT NULL THEN lang{i} END AS lang{i}"
        for i in (1, 2, 3)
    ]
    constant = ", ".join(f"max(lang{i}) OVER () AS lang{i}" for i in (1, 2, 3))
    return f"""
        SELECT * EXCLUDE (src_lvl, geometry) REPLACE ({constant}), {AREA} AS area_sqkm,
            least(coalesce(src_lvl::INT, 0), {n}) AS level, geometry
        FROM (
            SELECT {", ".join(cols)}, 1 AS version, NULL::DATE AS updated,
                {valid_from} AS valid_from, NULL::DATE AS valid_to,
                CASE WHEN src_lvl IS NULL THEN 'en' ELSE lang END AS lang, {", ".join(langs)},
                src_lvl, ST_Union_Agg(geometry) AS geometry
            FROM read_parquet('{work}/admin{n}.parquet') GROUP BY ALL
        )
    """


def check(con: duckdb.DuckDBPyConnection, path: Path, n: int) -> list[str]:
    """Raise on spec code violations; return report lines for softer gaps."""
    t = f"read_parquet('{path}')"
    hard = {
        "duplicate or null pcode": f"SELECT count(*) - count(DISTINCT adm{n}_pcode) + count(*) FILTER (adm{n}_pcode IS NULL) FROM {t}",
        "pcode format": f"SELECT count(*) FROM {t} WHERE NOT regexp_full_match(adm{n}_pcode, '[A-Z]{{3}}(\\.\\d{{3,}})*')",
        "pcode not under parent": " + ".join(
            f"(SELECT count(*) FROM {t} WHERE NOT coalesce(starts_with(adm{k}_pcode, adm{k - 1}_pcode || '.')"
            f" OR (level < {k} AND adm{k}_pcode = adm{k - 1}_pcode), false))"
            for k in range(1, n + 1)
        ),
        "name{i} without lang{i}": " + ".join(
            f"(SELECT count(*) FROM {t} WHERE lang{i} IS NULL AND "
            f"coalesce({', '.join(f'adm{k}_name{i}' for k in range(1, n + 1))}) IS NOT NULL)"
            for i in (1, 2, 3)
        ),
    }
    errors = {
        k: con.execute(q if q.startswith("SELECT") else f"SELECT {q}").fetchall()[0][0]
        for k, q in hard.items()
    }
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {t}").fetchall()]
    errors["fields not in schema.md order"] = int(
        cols != [*level_cols(n), *SPEC_TAIL, "geometry"]
    )
    errors["metadata not constant per location"] = con.execute(
        f"SELECT count(*) FROM (SELECT adm0_pcode FROM {t} GROUP BY 1 HAVING "
        + " OR ".join(
            f"count(DISTINCT {c}) + max(({c} IS NULL)::INT) > 1" for c in CONSTANT
        )
        + ")"
    ).fetchall()[0][0]
    errors["version not 1, or updated or valid_to set"] = con.execute(
        f"SELECT count(*) FROM {t} WHERE version <> 1 OR updated IS NOT NULL OR valid_to IS NOT NULL"
    ).fetchall()[0][0]
    if any(errors.values()):
        raise ValueError(f"{path}: {errors}")
    lang = con.execute(f"SELECT count(*) FROM {t} WHERE lang IS NULL").fetchall()[0][0]
    names = con.execute(
        f"SELECT count(*) FROM {t} WHERE "
        + " OR ".join(f"(adm{k}_name IS NULL AND level >= {k})" for k in range(n + 1))
    ).fetchall()[0][0]
    return [f"adm{n}: {lang} rows without lang, {names} rows with a null name"]


def outputs(out: Path) -> list[Path]:
    return [out / f"adm{n}_polygons.parquet" for n in range(1, MAX_LVL + 1)] + [
        out / f"{g}.parquet" for g in ("points", "lines")
    ]


def fingerprint(out: Path, iso3s: list[str]) -> str:
    """Hash of this module and each location's build fingerprint and valid_from."""
    h = hashlib.sha256(Path(__file__).read_bytes())
    for i in iso3s:
        folder = out / "iso3" / i.lower()
        for f in (FINGERPRINT_FILE, VALID_FROM_FILE):
            h.update(f"{i}/{f}:{(folder / f).read_text()}\n".encode())
    return h.hexdigest()


def merged(out: Path, iso3s: list[str]) -> bool:
    """Whether the merged layers exist and were merged from these builds by this code."""
    record = out / MERGE_FINGERPRINT
    return (
        all(p.exists() for p in outputs(out))
        and record.exists()
        and record.read_text() == fingerprint(out, iso3s)
    )


def merge(out: Path, iso3s: list[str]) -> list[str]:
    con = connect(threads=PROD_THREADS)
    report, staged = [], []
    for n in range(1, MAX_LVL + 1):
        dest = out / f".adm{n}_polygons.parquet"
        staged.append(dest)
        union = " UNION ALL BY NAME ".join(
            f"({polygons_sql(out / 'iso3' / i.lower(), n)})" for i in iso3s
        )
        write_geoparquet(
            con, f"SELECT * FROM ({union})", dest, f"adm{n}_pcode", GLOBAL_ROW_GROUP
        )
        report += check(con, dest, n)
    for geom, order in (("points", "pcode"), ("lines", HILBERT)):
        files = [str(out / "iso3" / i.lower() / f"{geom}.parquet") for i in iso3s]
        staged.append(out / f".{geom}.parquet")
        write_geoparquet(
            con,
            f"SELECT * FROM read_parquet({files}, union_by_name = true)",
            staged[-1],
            order,
            GLOBAL_ROW_GROUP,
        )
    con.close()
    built = [out / "iso3" / i.lower() / VERSION_FILE for i in iso3s]
    if all(v.exists() for v in built):
        versions = sorted({v.read_text() for v in built}, key=Version)
        staged.append(out / f".{VERSION_FILE}")
        staged[-1].write_text(", ".join(versions))
    # Replace the layers only once every one has passed check(), dropping the old
    # version record first so a crash leaves none rather than a wrong one.
    (out / VERSION_FILE).unlink(missing_ok=True)
    (out / MERGE_FINGERPRINT).unlink(missing_ok=True)
    for path in staged:
        path.replace(out / path.name.removeprefix("."))
    (out / MERGE_FINGERPRINT).write_text(fingerprint(out, iso3s))
    return report
