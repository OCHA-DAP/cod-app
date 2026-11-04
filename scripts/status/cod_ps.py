import csv
import re
import tempfile
from pathlib import Path

import duckdb
from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
GIS = OUTPUT_DIR / "gis.csv"
OUTPUT = OUTPUT_DIR / "cod_ps.csv"
LEVELS = OUTPUT_DIR / "levels.csv"

CKAN = "https://data.humdata.org/api/3/action"
PREFIX = "cod-ps-"
LEVEL_RE = re.compile(r"adm(?:in)?[ _-]?(\d)(?!\d)", re.IGNORECASE)
PCODE_COL_RE = re.compile(r"^adm(?:in)?_?(\d)_?pcode$", re.IGNORECASE)


def ckan(action: str, **params) -> dict:
    return http.get(f"{CKAN}/{action}", params=params).json()["result"]


def download(url: str, dest: Path) -> Path:
    http.download(url, dest)
    return dest


def csv_resources(dataset: dict) -> dict[str, str]:
    return {
        r["name"]: r["url"]
        for r in dataset.get("resources", [])
        if r.get("format", "").upper() == "CSV"
    }


def start_year(dataset_date: str | None) -> int | None:
    m = re.search(r"(\d{4})-\d{2}-\d{2}", dataset_date or "")
    return int(m.group(1)) if m else None


def country_pcodes(path: Path) -> set[tuple[int, str, str | None]]:
    # Per-country files vary in encoding and line endings, so csv over DuckDB.
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    lines = text.splitlines()
    dialect = csv.Sniffer().sniff(lines[0] if lines else "", delimiters=",;\t")
    rows = csv.DictReader(lines, dialect=dialect)
    cols = {
        int(m.group(1)): c
        for c in rows.fieldnames or []
        if (m := PCODE_COL_RE.match(c.strip()))
    }
    return {
        (
            level,
            v.strip(),
            parent.strip() if (parent := row.get(cols.get(level - 1, ""))) else None,
        )
        for row in rows
        for level, c in cols.items()
        if (v := row.get(c)) and v.strip() and not v.startswith("#")
    }


def parent_share(table: str) -> str:
    # Share of level n-1 units with children at level n: below 100 means the
    # level covers only part of the country (between full and max depth).
    return f"""
        WITH c AS (SELECT DISTINCT iso3, lvl, pcode, parent FROM {table} WHERE pcode IS NOT NULL),
        units AS (SELECT iso3, lvl, count(DISTINCT pcode) AS n FROM c GROUP BY 1, 2)
        SELECT c.iso3, c.lvl AS level, u.n AS units,
               coalesce(least(round(100.0 * count(DISTINCT c.parent) / p.n, 1), 100), 100)
                   AS parent_share
        FROM c
        JOIN units u ON u.iso3 = c.iso3 AND u.lvl = c.lvl
        LEFT JOIN units p ON p.iso3 = c.iso3 AND p.lvl = c.lvl - 1
        WHERE c.lvl >= 1
        GROUP BY c.iso3, c.lvl, u.n, p.n
        ORDER BY 1, 2
    """


def read_csv(path: Path) -> str:
    # Explicit quote: auto-detect picks no quoting on the global admin3 file.
    return f"read_csv('{path}', all_varchar=true, quote='\"', header=true)"


def country_datasets() -> dict[str, dict]:
    found = ckan("package_search", q=f"name:{PREFIX}*", rows=1000)["results"]
    return {
        d["name"][len(PREFIX) :].upper(): d
        for d in found
        if len(d["name"]) == len(PREFIX) + 3 and d["name"][len(PREFIX) :].isalpha()
    }


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cod_ps_") as tmp:
        run(Path(tmp))


def run(tmp: Path) -> None:
    with open(GIS, encoding="utf-8-sig") as f:
        gis = {r["iso3"] for r in csv.DictReader(f)}
    con = duckdb.connect()
    con.execute("CREATE TABLE gis (iso3 VARCHAR)")
    con.executemany("INSERT INTO gis VALUES (?)", [[iso3] for iso3 in gis])

    global_ps = csv_resources(ckan("package_show", id="cod-ps-global"))
    for level in range(5):
        name = f"cod_population_admin{level}.csv"
        download(global_ps[name], tmp / name)
    pcodes = csv_resources(ckan("package_show", id="global-pcodes"))
    download(pcodes["global_pcodes.csv"], tmp / "global_pcodes.csv")

    con.execute(f"""
        CREATE TABLE ab AS
        SELECT Location AS iso3, "Admin Level"::INT AS lvl, "P-Code" AS pcode,
               "Parent P-Code" AS parent
        FROM {read_csv(tmp / "global_pcodes.csv")}
        WHERE Location IN (SELECT iso3 FROM gis)
    """)
    years = " UNION ALL ".join(
        f"SELECT ISO3, Reference_year FROM {read_csv(tmp / f'cod_population_admin{level}.csv')}"
        for level in range(5)
    )
    con.execute(f"""
        CREATE TABLE global_year AS
        SELECT ISO3 AS iso3, max(TRY_CAST(Reference_year AS INT)) AS year
        FROM ({years})
        WHERE ISO3 IN (SELECT iso3 FROM gis)
        GROUP BY 1
    """)
    con.execute(
        "CREATE TABLE ps (iso3 VARCHAR, lvl INT, pcode VARCHAR, parent VARCHAR)"
    )
    for level in range(5):
        pcode = f"ADM{level}_PCODE" if level else "NULL"
        parent = f"ADM{level - 1}_PCODE" if level > 1 else "NULL"
        con.execute(f"""
            INSERT INTO ps
            SELECT DISTINCT ISO3, {level}, {pcode}, {parent}
            FROM {read_csv(tmp / f"cod_population_admin{level}.csv")}
            WHERE ISO3 IN (SELECT iso3 FROM gis)
        """)

    global_iso3 = {r[0] for r in con.execute("SELECT DISTINCT iso3 FROM ps").fetchall()}
    global_years = dict(con.execute("SELECT iso3, year FROM global_year").fetchall())

    datasets = {k: v for k, v in country_datasets().items() if k in gis}
    country_years: dict[str, int | None] = {}
    for iso3, dataset in sorted(datasets.items()):
        year = start_year(dataset.get("dataset_date"))
        newer = year is not None and year > (global_years.get(iso3) or 0)
        if iso3 in global_iso3 and not newer:
            continue
        by_level = {
            int(m.group(1)): url
            for name, url in csv_resources(dataset).items()
            if (m := LEVEL_RE.search(name))
        }
        deepest = max(by_level, default=None)
        found = []
        if deepest is not None:
            path = download(by_level[deepest], tmp / f"{iso3}_adm{deepest}.csv")
            found = [(iso3, *row) for row in country_pcodes(path)]
        # Keep the global level and p-codes unless the country file replaces them.
        if iso3 in global_iso3 and not found:
            continue
        country_years[iso3] = year
        con.execute("DELETE FROM ps WHERE iso3 = ?", [iso3])
        con.execute("INSERT INTO ps VALUES (?, ?, NULL, NULL)", [iso3, deepest])
        if found:
            con.executemany("INSERT INTO ps VALUES (?, ?, ?, ?)", found)

    con.execute("CREATE TABLE country_year (iso3 VARCHAR, year INT)")
    if country_years:
        con.executemany(
            "INSERT INTO country_year VALUES (?, ?)", list(country_years.items())
        )

    con.execute(f"""
        COPY (
            SELECT iso3, iso3 IN ({",".join(f"'{i}'" for i in datasets) or "NULL"}) AS on_hdx,
                   CASE WHEN any_value(cy.iso3) IS NULL THEN 'global' ELSE 'country' END
                       AS source,
                   coalesce(any_value(cy.year), any_value(gy.year)) AS reference_year,
                   max(p.lvl) AS admin_level
            FROM ps p
            LEFT JOIN country_year cy USING (iso3)
            LEFT JOIN global_year gy USING (iso3)
            GROUP BY iso3
            ORDER BY iso3
        ) TO '{OUTPUT}' (HEADER)
    """)
    print(f"COD-PS countries written to {OUTPUT}")

    # Per level: AB units and parent share, PS p-codes and parent share, and
    # p-codes present in both.
    con.execute(f"""
        COPY (
            WITH a AS ({parent_share("ab")}),
            p AS ({parent_share("ps")}),
            matched AS (
                SELECT p.iso3, p.lvl AS level, count(*) AS matched
                FROM (SELECT DISTINCT iso3, lvl, pcode FROM ps WHERE pcode IS NOT NULL) p
                JOIN ab USING (iso3, lvl, pcode)
                GROUP BY 1, 2
            )
            SELECT iso3, level, a.units AS ab_units, a.parent_share AS ab_share,
                   p.units AS ps_units, p.parent_share AS ps_share,
                   CASE WHEN p.units IS NOT NULL THEN coalesce(m.matched, 0) END AS matched
            FROM a FULL JOIN p USING (iso3, level)
            LEFT JOIN matched m USING (iso3, level)
            ORDER BY iso3, level
        ) TO '{LEVELS}' (HEADER)
    """)
    print(f"Per-level COD-AB and COD-PS stats written to {LEVELS}")


main()
