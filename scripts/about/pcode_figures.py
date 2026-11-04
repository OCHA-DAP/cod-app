"""Render the About page's Morafeno and P-code level maps and the Standards migration map as inline SVG."""

from pathlib import Path

import duckdb

OUT = Path(__file__).parents[2] / "src" / "lib" / "about"
OUT_STANDARDS = OUT.parent / "standards"
SRC = "https://data.source.coop/hdx/cod-ab/original"
BLUE, BLUE_LIGHTER, BLUE_DARK, GREY = "#009EDB", "#C5DFEF", "#004987", "#E6E6E6"
# The commune of Morafeno whose fokontany include one also called Morafeno.
COMMUNE = "MG34303152"

c = duckdb.connect()
c.sql("INSTALL spatial; LOAD spatial")


def load(name, path, cols, where, lon, lat, simplify=0):
    proj = f"'+proj=laea +lat_0={lat} +lon_0={lon}'"
    c.sql(f"""CREATE TABLE {name} AS SELECT {cols},
      ST_SimplifyPreserveTopology(ST_Transform(geometry, 'EPSG:4326', {proj}, always_xy := true), {simplify}) geom
      FROM '{SRC}/{path}' WHERE {where}""")


def bbox(sql):
    return c.sql(f"SELECT min(ST_XMin(geom)), min(ST_YMin(geom)), max(ST_XMax(geom)), max(ST_YMax(geom)) FROM ({sql})").fetchall()[0]


def mic(sql):
    return c.sql(f"SELECT ST_X(m.center), ST_Y(m.center) FROM (SELECT ST_MaximumInscribedCircle(geom, 50) m FROM ({sql}))").fetchall()


class Panel:
    """Projected geometry fitted to a pixel frame; overlays are drawn in pixels."""

    def __init__(self, box, width, height=None, pad=0.03):
        x0, y0, x1, y1 = box
        p = max(x1 - x0, y1 - y0) * pad
        vw, vh = x1 - x0 + 2 * p, y1 - y0 + 2 * p
        height = height or round(width * vh / vw)
        self.k = max(vw / width, vh / height)
        self.x0 = (x0 + x1) / 2 - width * self.k / 2
        self.y1 = (y0 + y1) / 2 + height * self.k / 2
        self.w, self.h = width, height
        self.maps, self.over = [], []

    def px(self, x, y):
        return (x - self.x0) / self.k, (self.y1 - y) / self.k

    def fill(self, sql, fill, stroke="#fff"):
        k = self.k
        px = f"ST_Affine(ST_SimplifyPreserveTopology(geom, {k}), {1 / k}, 0, 0, {1 / k}, {-self.x0 / k}, {-self.y1 / k})"
        d = " ".join(r[0] for r in c.sql(f"SELECT ST_AsSVG({px}, false, 1) FROM ({sql})").fetchall() if r[0])
        self.maps.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="0.6" stroke-linejoin="round"/>')

    def dots(self, pts, r, fill=BLUE):
        for x, y in pts:
            u, v = self.px(x, y)
            self.over.append(f'<circle cx="{u:.1f}" cy="{v:.1f}" r="{r}" fill="{fill}" stroke="#fff" stroke-width="1"/>')

    def label(self, x, y, code, name, dx=0, dy=0, anchor="middle"):
        u, v = self.px(x, y)
        halo = f'fill="{BLUE_DARK}" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="{anchor}"'
        self.over.append(f'<text x="{u + dx:.1f}" y="{v + dy:.1f}" font-size="15" font-weight="700" {halo}>{code}</text>'
                         f'<text x="{u + dx:.1f}" y="{v + dy + 14:.1f}" font-size="12" {halo}>{name}</text>')

    def body(self):
        return "".join(self.maps) + "".join(self.over)

    def svg(self):
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}">{self.body()}</svg>\n'


def morafeno() -> None:
    load("mdg1", "mdg/latest/mdg_admin1/mdg_admin1.parquet", "adm1_pcode pcode", "true", 46.9, -18.8, 800)
    load("mdg4", "mdg/latest/mdg_admin4/mdg_admin4.parquet", "adm4_name name, adm3_pcode p3",
         f"adm4_name = 'Morafeno' OR adm3_pcode = '{COMMUNE}'", 46.9, -18.8)
    named = "SELECT geom FROM mdg4 WHERE name = 'Morafeno'"
    commune = f"SELECT geom FROM mdg4 WHERE p3 = '{COMMUNE}'"
    m = Panel(bbox("SELECT geom FROM mdg1"), 300, pad=0.02)
    m.fill("SELECT geom FROM mdg1", GREY)
    m.dots(mic(named), 2.8)
    cbox = bbox(commune)
    (bx0, by0), (bx1, by1) = m.px(cbox[0], cbox[3]), m.px(cbox[2], cbox[1])
    m.over.append(f'<rect x="{bx0:.1f}" y="{by0:.1f}" width="{bx1 - bx0:.1f}" height="{by1 - by0:.1f}" fill="none" stroke="{BLUE_DARK}" stroke-width="1.5"/>')

    z = Panel(cbox, 300, 300, pad=0.1)
    z.fill(f"{commune} AND name <> 'Morafeno'", GREY)
    z.fill(f"{commune} AND name = 'Morafeno'", BLUE)
    (u, v), = [z.px(*p) for p in mic(f"{commune} AND name = 'Morafeno'")]
    z.over.append(f'<text x="{u:.1f}" y="{v - 12:.1f}" text-anchor="middle" font-size="13" font-weight="700" fill="{BLUE_DARK}" '
                  f'stroke="#fff" stroke-width="3" paint-order="stroke">Morafeno</text>')

    W, H = 736, m.h
    zx, zy = W - z.w, H - z.h - 1
    lines = "".join(
        f'<line x1="{bx1:.1f}" y1="{y1:.1f}" x2="{zx}" y2="{y2:.1f}" stroke="{BLUE_DARK}" stroke-width="1"/>'
        for y1, y2 in [(by0, zy), (by1, zy + z.h)]
    )
    frame = f'<rect x="{zx}" y="{zy:.1f}" width="{z.w}" height="{z.h}" fill="#fff" stroke="{BLUE_DARK}" stroke-width="1.5"/>'
    zoom = f'<g transform="translate({zx} {zy:.1f})">{z.body()}</g>'
    (OUT / "morafeno.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">{lines}{m.body()}{frame}{zoom}</svg>\n'
    )


def pcode_levels() -> None:
    """One map per level from Madagascar down to the 1st arrondissement of Antananarivo."""
    load("mdg2", "mdg/latest/mdg_admin2/mdg_admin2.parquet", "adm2_pcode pcode", "adm1_pcode = 'MG11'", 46.9, -18.8, 20)
    region, capital = "SELECT geom FROM mdg1 WHERE pcode = 'MG11'", "SELECT geom FROM mdg2 WHERE pcode = 'MG11118'"
    country = bbox("SELECT geom FROM mdg1")
    city = "SELECT geom FROM mdg2 WHERE pcode BETWEEN 'MG11118' AND 'MG11123'"
    levels = [
        ("mdg", country, [("SELECT geom FROM mdg1", BLUE)]),
        ("mdg-011", country, [("SELECT geom FROM mdg1", GREY), (region, BLUE)]),
        ("mdg-011-118", bbox(city), [(city, GREY), (capital, BLUE)]),
    ]
    for key, box, layers in levels:
        p = Panel(box, 150, 110)
        for sql, fill in layers:
            p.fill(sql, fill)
        (OUT / f"pcode-{key}.svg").write_text(p.svg())


def migration() -> None:
    """Mali's admin 1 in 2021 and 2025: Bamako moves from ML09 to ML20, and ML09 goes to Taoudenni."""
    for v in ("v02", "v03"):
        load(f"mli_{v}", f"mli/{v}/mli_admin1/mli_admin1.parquet", "adm1_pcode pcode", "true", -2, 17, 1000)
    unit = "SELECT geom FROM mli_{} WHERE pcode = '{}'"
    for v, year, units in [("v02", 2021, [("ML06", "Tombouctou", BLUE)]),
                           ("v03", 2025, [("ML06", "Timbuktu", BLUE), ("ML09", "Taoudenni", BLUE_LIGHTER)])]:
        p = Panel(bbox("SELECT geom FROM mli_v03"), 360)
        p.fill(f"SELECT geom FROM mli_{v}", GREY)
        for code, name, fill in units:
            p.fill(unit.format(v, code), fill)
            p.label(*mic(unit.format(v, code))[0], code, name)
        bamako = "ML09" if v == "v02" else "ML20"
        pt = mic(unit.format(v, bamako))
        p.dots(pt, 4, BLUE_DARK)
        p.label(*pt[0], bamako, "Bamako", dx=8, dy=-4, anchor="start")
        (OUT_STANDARDS / f"pcode-reuse-{year}.svg").write_text(p.svg())


if __name__ == "__main__":
    morafeno()
    pcode_levels()
    migration()
