"""Build global COD-AB layers from the team's source picks, edge-matched to one adm0-app ADM0 layer.

Run from the repo root: uv run -m cod_data.catalog.global_build.build --adm0 gaul [--only AFG,DEU]
"""

import argparse
import hashlib
import shutil
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import duckdb
from topo_tools.api import (
    code_create,
    edge_extend,
    edge_mosaic,
    package,
    schema_fill,
    topo_clean,
    topo_detect,
)

from cod_data.catalog.common import DECISIONS, connect
from cod_data.catalog.global_build.adm0 import write_parents
from cod_data.catalog.global_build.config import (
    ADM0_LAYERS,
    BUILD,
    CODE_FIELD,
    MATCH_KEY,
    MAX_LVL,
    NAME_FIELD,
    PARTS,
    THREADS,
    WORKERS,
)
from cod_data.catalog.global_build.conform import depth, stage_sql
from cod_data.shared.geoparquet import write_geoparquet

LEVEL_COLS = ("name", "name1", "name2", "name3", "pcode", "srcid", "type")
LANG = ("lang", "lang1", "lang2", "lang3")
FILL = {"adm0_pcode": "adm0_pcode", "adm0_name": "adm0_name"}
EXTENDED = BUILD / "extended"
AREA = "ST_Area(ST_Transform(geometry, 'OGC:CRS84', 'EPSG:8857')) / 1e6"


def staged_columns() -> list[str]:
    """Every staged column, levels 0..MAX_LVL, in the order schema.md lists them."""
    cols = [f"adm{n}_{c}" for n in range(MAX_LVL + 1) for c in LEVEL_COLS]
    return [MATCH_KEY, *cols, *LANG, "src_lvl", "geometry"]


def _pad(
    con: duckdb.DuckDBPyConnection, src: Path, key: str, out: Path, where: str = "true"
) -> None:
    have = {r[0] for r in con.execute(f"DESCRIBE FROM '{src}'").fetchall()}
    cols = [
        f"'{key}' AS {c}"
        if c == MATCH_KEY
        else c
        if c in have
        else f"NULL::VARCHAR AS {c}"
        for c in staged_columns()
    ]
    write_geoparquet(con, f"SELECT {', '.join(cols)} FROM '{src}' WHERE {where}", out)


def _extend(con: duckdb.DuckDBPyConnection, original: Path, work: Path) -> Path:
    """Extend original past its coastline, topo_clean it on defects; cached by content."""
    digest = hashlib.sha256(original.read_bytes()).hexdigest()[:16]
    out = EXTENDED / f"{original.stem}-{digest}.parquet"
    if out.exists():
        return out
    EXTENDED.mkdir(parents=True, exist_ok=True)
    extended = work / f"{original.stem}_extended.parquet"
    edge_extend(original, extended, threads=THREADS, tmp_dir=work)
    issues = work / f"{original.stem}_detect.parquet"
    topo_detect(extended, issues, threads=THREADS, tmp_dir=work)
    if con.execute(f"SELECT count(*) FROM '{issues}'").fetchall()[0][0]:
        clean = work / f"{original.stem}_clean.parquet"
        topo_clean(
            extended,
            clean,
            work / f"{original.stem}_clean_issues.parquet",
            threads=THREADS,
            tmp_dir=work,
        )
        extended = clean
    shutil.move(extended, out)
    return out


def _stage(
    con: duckdb.DuckDBPyConnection, iso3: str, source: str, parents: Path, work: Path
) -> list[Path]:
    """Write the pick's coded original per match key; return the originals."""
    lvl = depth(con, source, iso3)
    name = con.execute(
        f"SELECT arg_max(adm0_name, ST_Area(geometry)) FROM '{parents}'"
    ).fetchall()[0][0]
    raw = work / "raw.parquet"
    write_geoparquet(con, stage_sql(source, iso3, lvl, name), raw)
    checks = " OR ".join(
        f"_id{n} IS NULL OR _parents{n} > 1" for n in range(1, lvl + 1)
    )
    bad = con.execute(f"SELECT count(*) FROM '{raw}' WHERE {checks}").fetchall()[0][0]
    if bad:
        raise ValueError(
            f"{iso3}: {bad} {source} units with a missing or second parent"
        )
    seed = work / "seed.parquet"
    drop = ", ".join(f"_id{n}, _parents{n}" for n in range(1, lvl + 1))
    write_geoparquet(con, f"SELECT * EXCLUDE ({drop}) FROM '{raw}'", seed)
    coded = work / "coded.parquet"
    code_create(
        seed,
        coded,
        work / "code_issues.parquet",
        root_code=iso3,
        delimiter=".",
        min_width=3,
        name_field=NAME_FIELD,
        code_field=CODE_FIELD,
        threads=THREADS,
        tmp_dir=work,
    )
    if iso3 not in PARTS:
        original = work / f"{iso3.lower()}.parquet"
        _pad(con, coded, iso3, original)
        return [original]
    originals = []
    for part in PARTS[iso3]:
        original = work / f"{part.lower()}.parquet"
        inside = (
            f"ST_Within((ST_MaximumInscribedCircle(geometry, 1e-6)).center, "
            f"(SELECT geometry FROM '{parents}' WHERE {MATCH_KEY} = '{part}'))"
        )
        _pad(con, coded, part, original, inside)
        originals.append(original)
    total = con.execute(f"SELECT count(*) FROM '{coded}'").fetchall()[0][0]
    split = sum(
        con.execute(f"SELECT count(*) FROM '{o}'").fetchall()[0][0] for o in originals
    )
    if split != total:
        raise ValueError(
            f"{iso3}: {total - split} units outside the PARTS parts {PARTS[iso3]}"
        )
    return originals


def job(
    iso3: str, source: str | None, parents_all: Path, out: Path
) -> tuple[str, float, int]:
    t0 = time.perf_counter()
    work = out / "iso3" / iso3.lower()
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    con = connect()
    con.execute(f"SET threads = {THREADS}")
    parents = work / "parent.parquet"
    write_geoparquet(
        con, f"SELECT * FROM '{parents_all}' WHERE adm0_pcode = '{iso3}'", parents
    )
    filled = work / "filled.parquet"
    lvl = 0
    if source:
        originals = _stage(con, iso3, source, parents, work)
        lvl = con.execute(f"SELECT max(src_lvl) FROM '{originals[0]}'").fetchall()[0][0]
        inputs = [_extend(con, o, work) for o in originals]
        edge_mosaic(
            input_paths=inputs,
            overlay_path=parents,
            output_path=filled,
            issues_path=work / "mosaic_issues.parquet",
            original_paths=originals,
            match_column=MATCH_KEY,
            merge=True,
            overlay_include=[MATCH_KEY],
            input_exclude=[MATCH_KEY],
            fill=FILL,
            clean=False,
            fill_schema=True,
            name_field=NAME_FIELD,
            code_field=CODE_FIELD,
            threads=THREADS,
            tmp_dir=work,
        )
    else:
        rows = work / "rows.parquet"
        cols = [
            f"{FILL[c]} AS {c}"
            if c in FILL
            else c
            if c in (MATCH_KEY, "geometry")
            else f"NULL::VARCHAR AS {c}"
            for c in staged_columns()
        ]
        write_geoparquet(con, f"SELECT {', '.join(cols)} FROM '{parents}'", rows)
        schema_fill(
            rows,
            filled,
            name_field=NAME_FIELD,
            code_field=CODE_FIELD,
            threads=THREADS,
            tmp_dir=work,
        )
    package(
        filled,
        work / "{x}.parquet",
        name_field=NAME_FIELD,
        code_field=CODE_FIELD,
        min_level=1,
        clean=False,
        block=False,
        threads=THREADS,
        tmp_dir=work,
    )
    con.close()
    return iso3, time.perf_counter() - t0, lvl


def polygons_sql(work: Path, n: int, valid_from: str) -> str:
    """Level-n polygons in schema.md's field order, with spec metadata."""
    cols = [
        f"adm{k}_{c}"
        for k in range(n + 1)
        for c in ("pcode", "name", "name1", "name2", "name3", "type", "srcid")
    ]
    return f"""
        SELECT {", ".join(cols)}, 1 AS version, NULL::DATE AS updated,
            DATE '{valid_from}' AS valid_from, NULL::DATE AS valid_to, {", ".join(LANG)},
            {AREA} AS area_sqkm, least(coalesce(src_lvl::INT, 0), {n}) AS level, geometry
        FROM read_parquet('{work}/admin{n}.parquet')
    """


def check(con: duckdb.DuckDBPyConnection, path: Path, n: int) -> list[str]:
    """Raise on spec code violations; return report lines for softer gaps."""
    t = f"read_parquet('{path}')"
    hard = {
        "duplicate or null pcode": f"SELECT count(*) - count(DISTINCT adm{n}_pcode) + count(*) FILTER (adm{n}_pcode IS NULL) FROM {t}",
        "pcode format": f"SELECT count(*) FROM {t} WHERE NOT regexp_full_match(adm{n}_pcode, '[A-Z]{{3}}(\\.\\d{{3,}})*')",
        "pcode not under parent": " + ".join(
            f"(SELECT count(*) FROM {t} WHERE NOT starts_with(adm{k}_pcode, adm{k - 1}_pcode))"
            for k in range(1, n + 1)
        ),
        "null name": f"SELECT count(*) FROM {t} WHERE "
        + " OR ".join(f"adm{k}_name IS NULL" for k in range(n + 1)),
    }
    errors = {
        k: con.execute(q if q.startswith("SELECT") else f"SELECT {q}").fetchall()[0][0]
        for k, q in hard.items()
    }
    if any(errors.values()):
        raise ValueError(f"{path}: {errors}")
    srcid = (
        con.execute(
            f"SELECT count(*) FROM {t} WHERE "
            + " OR ".join(f"length(adm{k}_srcid) > 20" for k in range(1, n + 1))
        ).fetchall()[0][0]
        if n
        else 0
    )
    lang = con.execute(f"SELECT count(*) FROM {t} WHERE lang IS NULL").fetchall()[0][0]
    return [
        f"adm{n}: {srcid} rows with an srcid over 20 characters, {lang} rows without lang"
    ]


def merge(out: Path, iso3s: list[str]) -> list[str]:
    valid_from = date.today().isoformat()
    con = connect()
    report = []
    for n in range(1, MAX_LVL + 1):
        dest = out / f"adm{n}_polygons.parquet"
        union = " UNION ALL BY NAME ".join(
            f"({polygons_sql(out / 'iso3' / i.lower(), n, valid_from)})" for i in iso3s
        )
        write_geoparquet(con, f"SELECT * FROM ({union}) ORDER BY adm{n}_pcode", dest)
        report += check(con, dest, n)
    for geom in ("points", "lines"):
        files = [str(out / "iso3" / i.lower() / f"{geom}.parquet") for i in iso3s]
        write_geoparquet(
            con,
            f"SELECT * FROM read_parquet({files}, union_by_name = true)",
            out / f"{geom}.parquet",
        )
    con.close()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adm0", choices=ADM0_LAYERS, required=True)
    parser.add_argument("--only", help="Comma-separated iso3s")
    args = parser.parse_args()
    out = BUILD / args.adm0
    out.mkdir(parents=True, exist_ok=True)
    con = connect()
    parents = out / "parents.parquet"
    write_parents(con, args.adm0, parents)
    picks = dict(
        con.execute(f"SELECT iso3, selected_source FROM {DECISIONS}").fetchall()
    )
    iso3s = [
        r[0]
        for r in con.execute(
            f"SELECT DISTINCT adm0_pcode FROM '{parents}' ORDER BY 1"
        ).fetchall()
    ]
    con.close()
    if args.only:
        only = args.only.upper().split(",")
        iso3s = [i for i in iso3s if i in only]
        print("not in this ADM0 layer:", sorted(set(only) - set(iso3s)))
    print(
        "picks without an ADM0 row:",
        sorted(set(picks) - set(iso3s)) if not args.only else "-",
    )
    with ProcessPoolExecutor(WORKERS) as pool:
        jobs = {
            pool.submit(
                job, i, (picks.get(i) if picks.get(i) != "none" else None), parents, out
            ): i
            for i in iso3s
        }
        for done, fut in enumerate(as_completed(jobs), 1):
            iso3, secs, lvl = fut.result()
            print(
                f"{iso3} ({picks.get(iso3)}, adm{lvl}) {secs:.0f}s ({done}/{len(jobs)})",
                flush=True,
            )
    for line in merge(out, iso3s):
        print(line)


if __name__ == "__main__":
    main()
