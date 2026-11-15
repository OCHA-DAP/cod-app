"""Map one source's layers for an iso3 to the staging schema: one row per deepest-level unit."""

from dataclasses import dataclass

import duckdb

from cod_data.catalog.common import BOUNDARY_SOURCES, junk_filter
from cod_data.catalog.global_build.config import EXPLORER, FULL_COVER


@dataclass(frozen=True)
class Columns:
    """SQL per level ({n} this level, {p} its parent) for one source's layers."""

    iso3: str
    id: str
    parent: str
    name: str
    srcid: str
    alts: tuple[str, ...] = ()
    type: str = "NULL"
    lang: bool = False


_ADM = Columns(
    "iso3",
    "adm{n}_pcode",
    "adm{p}_pcode",
    "adm{n}_name",
    "adm{n}_pcode",
    ("adm{n}_name1", "adm{n}_name2", "adm{n}_name3"),
)
# Alternate names without a declared language stay out (schema.md: name1 needs lang1).
COLUMNS = {
    "ocha": Columns(**{**_ADM.__dict__, "lang": True}),
    "erm": _ADM,
    "wfp": Columns("iso3", "adm{n}_id", "adm{p}_id", "adm{n}_name", "source_id"),
    "unicef": Columns(
        "left(adm0_ucode, 3)",
        "ucode",
        "adm{p}_ucode",
        "name",
        '"Source_ID"',
        type='"type"',
    ),
    "unhcr": Columns("iso3", "pcode", "adm{p}_pcode", "gis_name", "adm{n}_source_code"),
    "fao": Columns(
        '"ISO3_CODE"',
        '"GAUL{n}_CODE"',
        '"GAUL{p}_CODE"',
        '"GAUL{n}_NAME"',
        '"GAUL{n}_CODE"',
    ),
}
SOURCE_LEVELS = {s.name: s.levels for s in BOUNDARY_SOURCES}


def layer(source: str, n: int) -> str:
    return f"read_parquet('{EXPLORER / source / f'{source}_adm{n}' / f'{source}_adm{n}.parquet'}')"


def _sql(template: str, n: int) -> str:
    return template.replace("{n}", str(n)).replace("{p}", str(n - 1))


def units(source: str, n: int, iso3: str) -> str:
    """SQL of the source's level-n rows for iso3 in the unit schema, filler rows dropped."""
    c = COLUMNS[source]
    src = next(s for s in BOUNDARY_SOURCES if s.name == source)
    junk = junk_filter(src, n)
    where = f"{'AND' if junk else 'WHERE'} {c.iso3} = '{iso3}'"
    alts = [f"{_sql(a, n)}::VARCHAR AS name{i}" for i, a in enumerate(c.alts, 1)]
    alts += [f"NULL::VARCHAR AS name{i}" for i in range(len(c.alts) + 1, 4)]
    lang = (
        "lang, lang1, lang2, lang3"
        if c.lang
        else ", ".join(
            f"NULL::VARCHAR AS {x}" for x in ("lang", "lang1", "lang2", "lang3")
        )
    )
    parent = f"{_sql(c.parent, n)}::VARCHAR" if n > 1 else "NULL::VARCHAR"
    return f"""
        SELECT {_sql(c.id, n)}::VARCHAR AS id, {parent} AS parent,
            nullif(trim({_sql(c.name, n)}::VARCHAR), '') AS name, {", ".join(alts)},
            nullif(trim({_sql(c.srcid, n)}::VARCHAR), '') AS srcid,
            nullif(trim({_sql(c.type, n)}::VARCHAR), '') AS type, {lang}, geometry
        FROM {layer(source, n)} {junk} {where}
    """


def depth(con: duckdb.DuckDBPyConnection, source: str, iso3: str) -> int:
    """Deepest level with more units than the one above and FULL_COVER of level 1's area."""
    stats = {
        n: con.execute(
            f"SELECT count(DISTINCT id), coalesce(sum(ST_Area(geometry)), 0) FROM ({units(source, n, iso3)})"
        ).fetchall()[0]
        for n in SOURCE_LEVELS[source]
    }
    if not stats[1][0]:
        raise ValueError(f"{iso3}: {source} has no level-1 units")
    full = [
        n
        for n, (count, area) in stats.items()
        if count
        and area >= FULL_COVER * stats[1][1]
        and (n == 1 or count > stats[n - 1][0])
    ]
    return max(full)


def _key(alias: str) -> str:
    """Spec sort cascade as one text key: srcid, name, name1..3 (nulls last), then id."""
    parts = [
        f"(({alias}.{c}) IS NULL)::INT::VARCHAR || coalesce({alias}.{c}, '')"
        for c in ("srcid", "name", "name1", "name2", "name3")
    ]
    return " || chr(31) || ".join([*parts, f"{alias}.id"])


def stage_sql(source: str, iso3: str, lvl: int, adm0_name: str) -> str:
    """One row per level-lvl unit with every level's columns, adm{n}_pcode holding its sort key."""
    ctes = []
    for n in range(1, lvl + 1):
        geom = "ST_Union_Agg(geometry)" if n == lvl else "NULL::GEOMETRY"
        attrs = ", ".join(
            f"any_value({c}) AS {c}"
            for c in (
                "parent",
                "name",
                "name1",
                "name2",
                "name3",
                "srcid",
                "type",
                "lang",
                "lang1",
                "lang2",
                "lang3",
            )
        )
        ctes.append(
            f"u{n} AS (SELECT id, {attrs}, count(DISTINCT parent) AS parents, "
            f"{geom} AS geometry FROM ({units(source, n, iso3)}) GROUP BY id)"
        )
    joins = " ".join(
        f"LEFT JOIN u{n} ON u{n + 1}.parent = u{n}.id" for n in range(lvl - 1, 0, -1)
    )
    cols = [f"'{adm0_name.replace(chr(39), chr(39) * 2)}' AS adm0_name"]
    for n in range(1, lvl + 1):
        cols += [
            f"u{n}.name AS adm{n}_name",
            *(f"u{n}.name{i} AS adm{n}_name{i}" for i in (1, 2, 3)),
            f"{_key(f'u{n}')} AS adm{n}_pcode",
            f"u{n}.srcid AS adm{n}_srcid",
            f"u{n}.type AS adm{n}_type",
            f"u{n}.id AS _id{n}",
            f"u{n}.parents AS _parents{n}",
        ]
    cols += [f"u{lvl}.{x}" for x in ("lang", "lang1", "lang2", "lang3")]
    return f"""
        WITH {", ".join(ctes)}
        SELECT {", ".join(cols)}, {lvl} AS src_lvl, u{lvl}.geometry
        FROM u{lvl} {joins}
    """
