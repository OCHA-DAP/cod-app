"""Render the About page's COD-PS admin 2 choropleths. Needs resvg and cwebp on PATH."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb
from shared import http

ROOT = Path(__file__).parents[2]
OUT_IMG = ROOT / "public" / "about"
OUT_JSON = ROOT / "src" / "lib" / "about" / "populationMaps.json"
AB = "https://data.source.coop/hdx/cod-ab/global/admin2/admin2.parquet"
PS_DATASET = "https://data.humdata.org/api/3/action/package_show?id=cod-ps-global"
PS_RESOURCE = "cod_population_admin2.csv"
# Every admin 2 unit has full age and sex figures, and no disputed areas.
COUNTRIES = {"COL": "Colombia", "ZWE": "Zimbabwe", "NAM": "Namibia"}
RAMP = ["#E3EDF6", "#C5DFEF", "#64BDEA", "#009EDB", "#0074B7", "#004987", "#002E6E"]
# Diverging around 100: OCHA orange for more females, UN blue for more males.
DIVERGING = ["#C15025", "#F9A870", "#FEDCBD", "#F2F2F2", "#C5DFEF", "#64BDEA", "#0074B7"]
NO_MATCH = "#D9D9D9"
LONG_SIDE = 1600
UNDER60 = [f"T_{a:02d}_{a + 4:02d}" for a in range(0, 60, 5)]
METRICS = [
    ("density", "Population density", "people per km², average over each unit", "t / area_km2", [10, 25, 50, 100, 300, 1500], RAMP),
    ("under5", "Children under age 5", "% of population", "100 * t_00_04 / t", [6, 8, 10, 12, 14, 16], RAMP),
    ("over60", "Aged 60 or over", "% of population", "100 * (t - under60) / t", [5, 8, 10, 15, 20, 25], RAMP),
    ("sexratio", "Males per 100 females", "males per 100 females, all ages", "100 * m / f", [90, 95, 98, 102, 105, 110], DIVERGING),
]


def labels(breaks: list[int]) -> list[str]:
    return [f"under {breaks[0]:,}"] + [f"{a:,} to {b:,}" for a, b in zip(breaks, breaks[1:])] + [f"{breaks[-1]:,} and over"]


def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    ps_csv = Path(sys.argv[1]) if len(sys.argv) > 1 else tmp / PS_RESOURCE
    if not ps_csv.exists():
        resources = http.get(PS_DATASET).json()["result"]["resources"]
        http.download(next(r["url"] for r in resources if r["name"] == PS_RESOURCE), ps_csv)

    c = duckdb.connect()
    c.sql("INSTALL spatial; LOAD spatial")
    under60 = ", ".join(f"'{g}'" for g in UNDER60)
    c.sql(f"""CREATE TABLE raw AS SELECT ADM2_PCODE pcode, Reference_year yr, Population_group grp, Population pop
      FROM read_csv('{ps_csv}') WHERE Population_group IN ('T_TL', 'M_TL', 'F_TL', {under60})""")
    c.sql(f"""CREATE TABLE ps AS
      WITH latest AS (SELECT pcode, max(yr) yr FROM raw WHERE grp = 'T_TL' GROUP BY 1)
      SELECT pcode, any_value(yr) yr,
        sum(pop) FILTER (grp = 'T_TL') t, sum(pop) FILTER (grp = 'M_TL') m, sum(pop) FILTER (grp = 'F_TL') f,
        sum(pop) FILTER (grp = 'T_00_04') t_00_04,
        CASE WHEN count(*) FILTER (grp IN ({under60})) = {len(UNDER60)} THEN sum(pop) FILTER (grp IN ({under60})) END under60
      FROM raw JOIN latest USING (pcode, yr) GROUP BY 1""")
    isos = ", ".join(f"'{i}'" for i in COUNTRIES)
    c.sql(f"CREATE TABLE ab AS SELECT iso3, adm2_pcode pcode, geometry FROM '{AB}' WHERE iso3 IN ({isos})")

    OUT_IMG.mkdir(parents=True, exist_ok=True)
    countries = []
    for iso3, name in COUNTRIES.items():
        lon, lat = c.sql(f"SELECT ST_X(c), ST_Y(c) FROM (SELECT ST_Centroid(ST_Extent_Agg(geometry)) c FROM ab WHERE iso3 = '{iso3}')").fetchall()[0]
        c.sql(f"""CREATE OR REPLACE TABLE g AS SELECT pcode,
            ST_Transform(geometry, 'EPSG:4326', '+proj=laea +lat_0={lat:.2f} +lon_0={lon:.2f}', always_xy := true) geom
          FROM ab WHERE iso3 = '{iso3}'""")
        xmin, ymin, xmax, ymax = c.sql(
            f"SELECT min(ST_XMin(geom)), min(ST_YMin(geom)), max(ST_XMax(geom)), max(ST_YMax(geom)) FROM g"
        ).fetchall()[0]
        span = max(xmax - xmin, ymax - ymin)
        pad = span * 0.02
        view_w, view_h = xmax - xmin + 2 * pad, ymax - ymin + 2 * pad
        scale = LONG_SIDE / max(view_w, view_h)
        width, height = round(view_w * scale), round(view_h * scale)
        c.sql(f"""CREATE OR REPLACE TABLE m AS SELECT ps.*, ST_Area(geom) / 1e6 area_km2,
            ST_SimplifyPreserveTopology(geom, {0.5 / scale}) geom
          FROM g LEFT JOIN ps USING (pcode) WHERE NOT ST_IsEmpty(geom)""")
        view = f"{xmin - pad:.0f} {-ymax - pad:.0f} {view_w:.0f} {view_h:.0f}"
        for key, _, _, expr, breaks, ramp in METRICS:
            cases = " ".join(f"WHEN v < {b} THEN {i}" for i, b in enumerate(breaks))
            rows = c.sql(f"""SELECT CASE WHEN v IS NULL THEN -1 {cases} ELSE {len(breaks)} END cls, string_agg(svg, ' ')
              FROM (SELECT {expr} v, ST_AsSVG(geom, false, 0) svg FROM m) GROUP BY 1 ORDER BY 1""").fetchall()
            paths = "\n".join(f'<path fill="{NO_MATCH if k < 0 else ramp[k]}" d="{d}"/>' for k, d in rows)
            svg = tmp / f"{iso3}-{key}.svg"
            svg.write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" stroke="#fff" '
                f'stroke-width="{1 / scale:.0f}" stroke-linejoin="round">\n{paths}\n</svg>\n'
            )
            png = tmp / f"{iso3}-{key}.png"
            subprocess.run(["resvg", "-w", str(width), svg, png], check=True)
            out = OUT_IMG / f"population-{iso3.lower()}-{key}.webp"
            subprocess.run(["cwebp", "-quiet", "-q", "82", png, "-o", out], check=True)
        units, with_pop, year = c.sql("SELECT count(*), count(t), max(yr) FROM m").fetchall()[0]
        countries.append({"iso3": iso3, "name": name, "width": width, "height": height, "units": units, "matched": with_pop, "year": year})
        print(f"{name}: {with_pop}/{units} admin 2 units matched, reference year {year}")

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        "noMatch": NO_MATCH,
        "metrics": [{"key": k, "title": t, "unit": u, "labels": labels(b), "ramp": r} for k, t, u, _, b, r in METRICS],
        "countries": countries,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
