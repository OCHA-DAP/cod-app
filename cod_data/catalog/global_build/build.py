"""Build global COD-AB layers from the team's source picks, edge-matched to one adm0-app ADM0 layer.

Run from the repo root: uv run -m cod_data.catalog.global_build.build --adm0 gaul [--only AFG,DEU]
"""

import argparse
import hashlib
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from importlib.metadata import version
from pathlib import Path

import duckdb
from topo_tools.api import (
    code_create,
    edge_extend,
    edge_mosaic,
    package,
    topo_clean,
    topo_detect,
)

from cod_data.catalog.common import DECISIONS, connect
from cod_data.catalog.global_build.adm0 import write_parents
from cod_data.catalog.global_build.config import (
    ADM0_LAYERS,
    BUILD,
    COD_AB_CATALOG,
    CODE_FIELD,
    GAP_WIDTH,
    MATCH_KEY,
    MAX_LVL,
    NAME_FIELD,
    PARTS,
    THREADS,
    VERSION_FILE,
    WORKERS,
)
from cod_data.catalog.global_build.conform import depth, stage_sql
from cod_data.shared.geoparquet import WORLD, write_geoparquet

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


def _punch(con: duckdb.DuckDBPyConnection, path: Path, work: Path) -> Path:
    """path with each unit that fully covers another (a missing hole) cut around it."""
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE punch AS
        WITH t AS (
            SELECT file_row_number AS rid, geometry, ST_XMin(geometry) AS x0,
                ST_YMin(geometry) AS y0, ST_XMax(geometry) AS x1, ST_YMax(geometry) AS y1
            FROM read_parquet('{path}', file_row_number = true)
        )
        SELECT a.rid, ST_Union_Agg(b.geometry) AS holes
        FROM t a JOIN t b
          ON a.rid <> b.rid AND b.x0 >= a.x0 AND b.x1 <= a.x1
         AND b.y0 >= a.y0 AND b.y1 <= a.y1 AND ST_Covers(a.geometry, b.geometry)
         AND NOT ST_Covers(b.geometry, a.geometry)
        GROUP BY 1
    """)
    if not con.execute("SELECT count(*) FROM punch").fetchall()[0][0]:
        return path
    out = work / f"{path.stem}_punched.parquet"
    write_geoparquet(
        con,
        f"""
        SELECT t.* EXCLUDE (rid, file_row_number) REPLACE (
            coalesce(ST_Difference(t.geometry, p.holes), t.geometry) AS geometry)
        FROM (SELECT file_row_number AS rid, *
              FROM read_parquet('{path}', file_row_number = true)) t
        LEFT JOIN punch p USING (rid)
    """,
        out,
    )
    return out


def _clean(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    work: Path,
    kinds: str = "true",
    gap: str | None = None,
) -> Path:
    """path, or its topo_clean output when topo_detect finds defects matching kinds."""
    issues = work / f"{path.stem}_detect.parquet"
    topo_detect(path, issues, threads=THREADS, tmp_dir=work)
    found = f"SELECT count(*) FROM '{issues}' WHERE {kinds}"
    if not con.execute(found).fetchall()[0][0]:
        return path
    clean = work / f"{path.stem}_clean.parquet"
    topo_clean(
        path,
        clean,
        work / f"{path.stem}_clean_issues.parquet",
        maximum_gap_width=gap,
        threads=THREADS,
        tmp_dir=work,
    )
    return clean


def _extend(con: duckdb.DuckDBPyConnection, original: Path, work: Path) -> Path:
    """Extend original past its coastline, cleaned on defects; cached by content and topo-tools version."""
    digest = hashlib.sha256(
        original.read_bytes() + version("topo-tools").encode()
    ).hexdigest()[:16]
    out = EXTENDED / f"{original.stem}-{digest}.parquet"
    if out.exists():
        return out
    EXTENDED.mkdir(parents=True, exist_ok=True)
    extended = work / f"{original.stem}_extended.parquet"
    edge_extend(original, extended, threads=THREADS, tmp_dir=work)
    shutil.move(_clean(con, extended, work), out)
    return out


def _cod_ab_path(iso3: str, lvl: int) -> Path:
    key = iso3.lower()
    name = f"{key}_admin{lvl}"
    return COD_AB_CATALOG / "extended" / key / "latest" / name / f"{name}.parquet"


def _cod_ab_extended(
    con: duckdb.DuckDBPyConnection,
    iso3: str,
    originals: list[Path],
    lvl: int,
    work: Path,
) -> list[Path]:
    """Each original with the cod-ab catalog's extended geometry, joined 1:1 by OCHA P-code."""
    src = _cod_ab_path(iso3, lvl)
    rows, codes = con.execute(
        f"SELECT count(*), count(DISTINCT adm{lvl}_pcode) FROM '{src}'"
    ).fetchall()[0]
    if rows != codes:
        raise ValueError(f"{iso3}: {src} has {rows} rows for {codes} P-codes")
    outs, matched = [], 0
    for o in originals:
        out = work / f"{o.stem}_extended.parquet"
        write_geoparquet(
            con,
            f"""
            SELECT o.* REPLACE (e.geometry AS geometry)
            FROM '{o}' o JOIN '{src}' e ON o.adm{lvl}_srcid = e.adm{lvl}_pcode
        """,
            out,
        )
        want, got = (
            con.execute(f"SELECT count(*) FROM '{p}'").fetchall()[0][0]
            for p in (o, out)
        )
        if want != got:
            raise ValueError(f"{iso3}: {want - got} units missing from {src}")
        matched += got
        outs.append(_clean(con, out, work))
    if matched != rows:
        raise ValueError(
            f"{iso3}: {rows - matched} units in {src} not in the OCHA layer"
        )
    return outs


def _stage(
    con: duckdb.DuckDBPyConnection, iso3: str, source: str, parents: Path, work: Path
) -> list[Path]:
    """Write the pick's coded original per match key; return the originals."""
    lvl = depth(con, source, iso3)
    if source == "ocha":
        # The cod-ab catalog extends only the levels clean enough to use.
        lvl = max(n for n in range(1, lvl + 1) if _cod_ab_path(iso3, n).exists())
    name = con.execute(
        f"SELECT arg_max(adm0_name, ST_Area(geometry)) FROM '{parents}'"
    ).fetchall()[0][0]
    raw = work / "raw.parquet"
    keep = None
    if source == "ocha":
        # Units the cod-ab catalog leaves out of its extended layer (e.g. Abyei) are dropped.
        keep = f"SELECT adm{lvl}_pcode FROM '{_cod_ab_path(iso3, lvl)}'"
    write_geoparquet(con, stage_sql(source, iso3, lvl, name, keep), raw)
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
    # Unit to part by interior point; points off every part (coastal slivers) by overlap, else nearest.
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE unit_part AS
        WITH u AS (
            SELECT adm{lvl}_pcode AS pcode, geometry,
                (ST_MaximumInscribedCircle(geometry, 1e-6)).center AS pt
            FROM '{coded}'
        ), hit AS (
            SELECT u.pcode, any_value(p.{MATCH_KEY}) AS part
            FROM u JOIN '{parents}' p ON ST_Within(u.pt, p.geometry) GROUP BY 1
        )
        SELECT * FROM hit
        UNION ALL
        SELECT u.pcode, coalesce(
            arg_max(p.{MATCH_KEY}, ST_Area(ST_Intersection(u.geometry, p.geometry)))
                FILTER (ST_Intersects(u.geometry, p.geometry)),
            arg_min(p.{MATCH_KEY}, ST_Distance(u.geometry, p.geometry)))
        FROM u, '{parents}' p WHERE u.pcode NOT IN (SELECT pcode FROM hit) GROUP BY 1
    """)
    stray = con.execute(
        f"SELECT part, count(*) FROM unit_part WHERE NOT list_contains({PARTS[iso3]}, part) "
        "GROUP BY 1"
    ).fetchall()
    if stray:
        raise ValueError(f"{iso3}: units in parts outside {PARTS[iso3]}: {stray}")
    originals = []
    for part in PARTS[iso3]:
        original = work / f"{part.lower()}.parquet"
        inside = (
            f"adm{lvl}_pcode IN (SELECT pcode FROM unit_part WHERE part = '{part}')"
        )
        _pad(con, coded, part, original, inside)
        originals.append(original)
    return originals


def _copy_adm0(con: duckdb.DuckDBPyConnection, parents: Path, work: Path) -> None:
    """Write package's outputs for a location with no subnational units: every level is its ADM0."""
    adm0 = f"""
        SELECT min({MATCH_KEY}) AS {MATCH_KEY}, adm0_pcode, adm0_name,
            ST_Union_Agg(geometry) AS geometry
        FROM '{parents}' GROUP BY adm0_pcode, adm0_name
    """
    for n in range(1, MAX_LVL + 1):
        cols = [
            f"adm0_{c} AS adm{k}_{c}"
            if c in ("name", "pcode")
            else f"NULL::VARCHAR AS adm{k}_{c}"
            for k in range(n + 1)
            for c in LEVEL_COLS
        ]
        lang = [f"NULL::VARCHAR AS {c}" for c in (*LANG, "src_lvl")]
        select = ["geometry", MATCH_KEY, *cols, *lang, "0 AS adm_lvl"]
        write_geoparquet(
            con, f"SELECT {', '.join(select)} FROM ({adm0})", work / f"admin{n}.parquet"
        )
    point = [
        f"adm0_{c} AS {c}" if c in ("name", "pcode") else f"NULL::VARCHAR AS {c}"
        for c in LEVEL_COLS
    ]
    write_geoparquet(
        con,
        f"""WITH p AS MATERIALIZED (
            SELECT *, (ST_MaximumInscribedCircle(geometry)).center AS center FROM ({adm0})
        )
        SELECT center AS geometry, {", ".join(point)}, n::INTEGER AS adm_lvl
        FROM p, range(1, {MAX_LVL + 1}) AS r(n)""",
        work / "points.parquet",
    )
    sides = [f"NULL::VARCHAR AS {s}_{c}" for s in ("a", "b") for c in LEVEL_COLS]
    write_geoparquet(
        con,
        f"SELECT NULL::GEOMETRY AS geometry, {', '.join(sides)}, 0 AS adm_lvl WHERE false",
        work / "lines.parquet",
    )


def job(
    iso3: str, source: str | None, parents_all: Path, out: Path
) -> tuple[str, float, int]:
    """Build one location in a hidden folder, replacing its last build only on success."""
    final = out / "iso3" / iso3.lower()
    work = final.with_name(f".{final.name}")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    result = _build(iso3, source, parents_all, work)
    (work / VERSION_FILE).write_text(version("topo-tools"))
    shutil.rmtree(final, ignore_errors=True)
    work.rename(final)
    return result


def _build(
    iso3: str, source: str | None, parents_all: Path, work: Path
) -> tuple[str, float, int]:
    t0 = time.perf_counter()
    con = connect()
    con.execute(f"SET threads = {THREADS}")
    parents = work / "parent.parquet"
    write_geoparquet(
        con, f"SELECT * FROM '{parents_all}' WHERE adm0_pcode = '{iso3}'", parents
    )
    filled = work / "filled.parquet"
    lvl = 0
    if source:
        # Partner sources can overlap or leave gaps, which edge_extend rejects.
        originals = [
            _clean(
                con,
                _punch(con, o, work),
                work,
                "kind IN ('overlap', 'gap')",
                GAP_WIDTH.get(iso3),
            )
            for o in _stage(con, iso3, source, parents, work)
        ]
        lvl = con.execute(f"SELECT max(src_lvl) FROM '{originals[0]}'").fetchall()[0][0]
        inputs = (
            _cod_ab_extended(con, iso3, originals, lvl, work)
            if source == "ocha"
            else [_extend(con, o, work) for o in originals]
        )
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
        _copy_adm0(con, parents, work)
        con.close()
        return iso3, time.perf_counter() - t0, lvl
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
    # Fill parts of one iso3 (AUS's islands) share a code, so they merge into one row.
    # Fill rows carry the ADM0 layer's English names; lang{i} only where this layer has a name{i}.
    langs = [
        f"CASE WHEN coalesce({', '.join(f'adm{k}_name{i}' for k in range(1, n + 1))}) "
        f"IS NOT NULL THEN lang{i} END AS lang{i}"
        for i in (1, 2, 3)
    ]
    return f"""
        SELECT * EXCLUDE (src_lvl, geometry), {AREA} AS area_sqkm,
            least(coalesce(src_lvl::INT, 0), {n}) AS level, geometry
        FROM (
            SELECT {", ".join(cols)}, 1 AS version, NULL::DATE AS updated,
                DATE '{valid_from}' AS valid_from, NULL::DATE AS valid_to,
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
        "name{i} and lang{i} disagree": " + ".join(
            f"(SELECT count(*) FROM {t} WHERE (lang{i} IS NULL) = "
            f"(coalesce({', '.join(f'adm{k}_name{i}' for k in range(1, n + 1))}) IS NOT NULL))"
            for i in (1, 2, 3)
        ),
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
    names = con.execute(
        f"SELECT count(*) FROM {t} WHERE "
        + " OR ".join(f"(adm{k}_name IS NULL AND level >= {k})" for k in range(n + 1))
    ).fetchall()[0][0]
    return [
        (
            f"adm{n}: {srcid} rows with an srcid over 20 characters, "
            f"{lang} rows without lang, {names} rows with a null name"
        )
    ]


# Spatial order lets a reader skip row groups outside its area.
HILBERT = f"ST_Hilbert(geometry, ST_Extent({WORLD}))"


def merge(out: Path, iso3s: list[str]) -> list[str]:
    valid_from = date.today().isoformat()
    con = connect()
    report, staged = [], []
    for n in range(1, MAX_LVL + 1):
        dest = out / f".adm{n}_polygons.parquet"
        staged.append(dest)
        union = " UNION ALL BY NAME ".join(
            f"({polygons_sql(out / 'iso3' / i.lower(), n, valid_from)})" for i in iso3s
        )
        write_geoparquet(con, f"SELECT * FROM ({union})", dest, f"adm{n}_pcode")
        report += check(con, dest, n)
    for geom in ("points", "lines"):
        files = [str(out / "iso3" / i.lower() / f"{geom}.parquet") for i in iso3s]
        staged.append(out / f".{geom}.parquet")
        write_geoparquet(
            con,
            f"SELECT * FROM read_parquet({files}, union_by_name = true)",
            staged[-1],
            HILBERT,
        )
    con.close()
    # Replace the layers only once every one has passed check().
    for path in staged:
        path.replace(out / path.name.removeprefix("."))
    built = [out / "iso3" / i.lower() / VERSION_FILE for i in iso3s]
    (out / VERSION_FILE).unlink(missing_ok=True)
    if all(v.exists() for v in built):
        versions = sorted({v.read_text() for v in built})
        (out / VERSION_FILE).write_text(", ".join(versions))
    return report


def same_parent(parents: Path, built: Path, iso3: str) -> bool:
    """Whether the build in built was edge-matched to the current ADM0 rows of iso3."""
    wkb = "SELECT * REPLACE (ST_AsWKB(geometry) AS geometry) FROM read_parquet"
    con = connect()
    a = f"{wkb}('{parents}') WHERE adm0_pcode = '{iso3}'"
    b = f"{wkb}('{built / 'parent.parquet'}')"
    diff = con.execute(
        f"SELECT count(*) FROM (({a} EXCEPT ALL {b}) UNION ALL ({b} EXCEPT ALL {a}))"
    ).fetchall()[0][0]
    con.close()
    return diff == 0


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
    iso3s = all_iso3s = [
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
        failed = {}
        for done, fut in enumerate(as_completed(jobs), 1):
            try:
                iso3, secs, lvl = fut.result()
            except Exception as e:  # noqa: BLE001 (one bad source must not stop the rest)
                iso3 = jobs[fut]
                failed[iso3] = f"{type(e).__name__}: {e}"
                print(f"{iso3} FAILED ({done}/{len(jobs)}): {failed[iso3]}")
                continue
            print(
                f"{iso3} ({picks.get(iso3)}, adm{lvl}) {secs:.0f}s ({done}/{len(jobs)})",
                flush=True,
            )
    files = ("admin1.parquet", "points.parquet", "lines.parquet")

    def is_built(iso3: str) -> bool:
        return all((out / "iso3" / iso3.lower() / f).exists() for f in files)

    # In this process, so a crashed worker that broke the pool still gets its fill.
    for iso3 in failed:
        if is_built(iso3) and same_parent(parents, out / "iso3" / iso3.lower(), iso3):
            failed[iso3] += "; kept the last build"
            continue
        try:
            job(iso3, None, parents, out)
            failed[iso3] += "; ADM0 fill"
        except Exception as e:  # noqa: BLE001 (report every location before exiting)
            failed[iso3] += f"; ADM0 fill also failed: {type(e).__name__}: {e}"
    for iso3, error in failed.items():
        print(f"failed {picks.get(iso3)} build: {iso3} {error}")
    built = [i for i in all_iso3s if is_built(i)]
    print("not built yet, left out of the merge:", sorted(set(all_iso3s) - set(built)))
    for line in merge(out, built):
        print(line)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
