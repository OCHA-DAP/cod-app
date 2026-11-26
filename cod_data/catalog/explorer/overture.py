"""Overture Maps divisions admin 1-3 per location from its latest release, as served."""

import re
import shutil

from cod_data.catalog.common import COD_AB_CACHE, connect, path_of
from cod_data.catalog.explorer.boundaries import write_boundary
from cod_data.shared import http

BUCKET = "overturemaps-us-west-2"
CACHE = COD_AB_CACHE.parent / "overture"
META = CACHE / "meta.parquet"
SUBTYPES = ("country", "dependency", "region", "county", "localadmin")
LEVELS = range(1, 4)


def latest_release() -> str:
    """The newest release folder in the public bucket."""
    listing = http.get(
        f"https://{BUCKET}.s3.amazonaws.com/",
        params={"list-type": "2", "prefix": "release/", "delimiter": "/"},
    ).text
    return max(re.findall(r"<Prefix>release/([0-9-]+\.\d+)/</Prefix>", listing))


def fetch(release: str) -> None:
    """Copy the release's admin divisions and their land areas, unless already cached."""
    folder = CACHE / release
    divisions, areas = folder / "divisions.parquet", folder / "areas.parquet"
    if divisions.exists() and areas.exists():
        return
    folder.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.execute("LOAD httpfs; SET s3_region = 'us-west-2'")
    theme = f"s3://{BUCKET}/release/{release}/theme=divisions"
    subtypes = ", ".join(f"'{s}'" for s in SUBTYPES)
    for out, query in (
        (
            divisions,
            f"SELECT id, country, subtype, parent_division_id FROM read_parquet('{theme}/type=division/*') WHERE subtype IN ({subtypes})",
        ),
        (
            areas,
            f"SELECT division_id, names.primary AS name, sources, geometry FROM read_parquet('{theme}/type=division_area/*') WHERE subtype IN ({subtypes}) AND class = 'land'",
        ),
    ):
        part = out.with_suffix(".part")
        con.execute(f"COPY ({query}) TO '{part}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        part.replace(out)
    con.close()


def stage(release: str) -> None:
    """Write each level by depth under its country or dependency, and per-location metadata."""
    folder = CACHE / release
    META.unlink(missing_ok=True)
    con = connect()
    con.execute(f"""
        CREATE TABLE level AS
        WITH RECURSIVE t(id, root, level) AS (
            SELECT id, id, 0 FROM '{folder / "divisions.parquet"}'
            WHERE subtype IN ('country', 'dependency')
            UNION ALL
            SELECT d.id, t.root, t.level + 1
            FROM '{folder / "divisions.parquet"}' d JOIN t ON d.parent_division_id = t.id
            WHERE d.subtype NOT IN ('country', 'dependency') AND t.level < 10
        )
        SELECT t.id, t.level, coalesce(m."ISO-alpha3 Code", CASE r.country WHEN 'XK' THEN 'XKX' WHEN 'TW' THEN 'TWN' END) AS iso3
        FROM t
        JOIN '{folder / "divisions.parquet"}' r ON r.id = t.root
        LEFT JOIN '{path_of("m49")}' m ON m."ISO-alpha2 Code" = r.country
    """)
    skipped = con.execute(f"""
        SELECT count(*) FROM '{folder / "divisions.parquet"}' d LEFT JOIN level l USING (id)
        WHERE l.id IS NULL OR (l.level > 0 AND l.iso3 IS NULL)
    """).fetchall()[0][0]
    print(f"Left out {skipped} units with no country or no ISO3 (X-coded areas, CP)")
    con.execute(f"""
        CREATE TABLE units AS
        SELECT l.iso3, l.level, a.division_id, a.name, a.sources, a.geometry
        FROM '{folder / "areas.parquet"}' a JOIN level l ON l.id = a.division_id
        WHERE l.iso3 IS NOT NULL AND l.level > 0
    """)
    con.execute(f"""
        COPY (
            SELECT iso3, '{release}' AS release,
                array_to_string(list_sort(list_distinct(flatten(list(list_transform(sources, lambda s: s.dataset))))), '; ') AS datasets
            FROM units GROUP BY iso3 ORDER BY iso3
        ) TO '{META}' (FORMAT PARQUET)
    """)
    for n in LEVELS:
        path = folder / f"adm{n}.parquet"
        con.execute(f"""
            COPY (
                SELECT iso3, iso3 AS adm0_pcode, name AS adm{n}_name, division_id AS adm{n}_pcode,
                    ST_SetCRS(geometry, 'OGC:CRS84') AS geometry
                FROM units WHERE level = {n} ORDER BY iso3, division_id
            ) TO '{path}' (FORMAT PARQUET)
        """)
        write_boundary(f"SELECT * FROM read_parquet('{path}')", f"overture_adm{n}")
        path.unlink()
    con.close()


def main() -> None:
    release = latest_release()
    print(f"Overture release {release}")
    fetch(release)
    for old in CACHE.glob("*/"):
        if old.name != release:
            shutil.rmtree(old)
    stage(release)


if __name__ == "__main__":
    main()
