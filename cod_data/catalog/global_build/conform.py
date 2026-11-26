"""Map one source's layers for an iso3 to the staging schema: one row per deepest-level unit."""

from dataclasses import dataclass

import duckdb

from cod_data.catalog.common import BOUNDARY_SOURCES, junk_filter
from cod_data.catalog.global_build.config import (
    DEPTH,
    EXPLORER,
    FULL_COVER,
    PRIMARY_NAME1,
)


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
    # SQL for lang..lang3.
    langs: tuple[str, ...] = ("'en'", "NULL", "NULL", "NULL")
    # Key units by their id path from level 1 (rows carry every parent's id).
    chain: bool = False
    # Name for one of several filler units at a level (WFP UMI's islands sit in adm0_name).
    part: str = "NULL"


_ADM = Columns(
    "iso3",
    "adm{n}_pcode",
    "adm{p}_pcode",
    "adm{n}_name",
    "adm{n}_pcode",
    ("adm{n}_name1", "adm{n}_name2", "adm{n}_name3"),
)
# Alternate names without a declared language stay out (schema.md: name1 needs lang1).
_LANGS = ("lang", "lang1", "lang2", "lang3")
COLUMNS = {
    "ocha": Columns(**{**_ADM.__dict__, "langs": _LANGS}),
    "eurogeographics": Columns(**{**_ADM.__dict__, "langs": _LANGS}),
    "wfp": Columns(
        "iso3",
        "adm{n}_id",
        "adm{p}_id",
        "adm{n}_name",
        "source_id",
        chain=True,
        part="adm0_name",
    ),
    "unicef": Columns(
        "left(adm0_ucode, 3)",
        "ucode",
        "adm{p}_ucode",
        "name",
        '"Source_ID"',
        type='"type"',
    ),
    "unhcr": Columns("iso3", "pcode", "adm{p}_pcode", "gis_name", "adm{n}_source_code"),
    "wb": Columns(
        '"ISO_A3"', '"ADM{n}CD_c"', '"ADM{p}CD_c"', '"NAM_{n}"', '"ADM{n}CD_c"'
    ),
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
    rows = f"{layer(source, n)} WHERE {c.iso3} = '{iso3}'"
    junk = junk_filter(src, n).removeprefix("WHERE ")
    # Filler that is a level's only unit is the territory itself (WFP PRI's adm1), named as adm0.
    where = (
        f"WHERE {c.iso3} = '{iso3}' AND ({junk} OR NOT EXISTS (SELECT 1 FROM {rows} AND {junk}))"
        if junk
        else f"WHERE {c.iso3} = '{iso3}'"
    )
    name, alt_cols = c.name, list(c.alts)
    langs = list(c.langs)
    if iso3 in PRIMARY_NAME1:
        name, alt_cols[0] = alt_cols[0], name
        langs[0], langs[1] = langs[1], langs[0]
    alts = [f"{_sql(a, n)}::VARCHAR AS name{i}" for i, a in enumerate(alt_cols, 1)]
    alts += [f"NULL::VARCHAR AS name{i}" for i in range(len(alt_cols) + 1, 4)]
    lang = ", ".join(
        f"{v}::VARCHAR AS {x}"
        for v, x in zip(langs, ("lang", "lang1", "lang2", "lang3"), strict=True)
    )
    parent = f"{_sql(c.parent, n)}::VARCHAR" if n > 1 else "NULL::VARCHAR"
    uid = f"{_sql(c.id, n)}::VARCHAR"
    if c.chain:
        path = [f"{_sql(c.id, k)}::VARCHAR" for k in range(1, n + 1)]
        uid = f"concat_ws('/', {', '.join(path)})"
        parent = f"concat_ws('/', {', '.join(path[:-1])})" if n > 1 else parent
    return f"""
        SELECT {uid} AS id, {parent} AS parent,
            nullif(trim({_sql(name, n)}::VARCHAR), '') AS name, {", ".join(alts)},
            {f"NOT ({junk})" if junk else "false"} AS filler, {c.part}::VARCHAR AS part,
            nullif(trim({_sql(c.srcid, n)}::VARCHAR), '') AS srcid,
            nullif(trim({_sql(c.type, n)}::VARCHAR), '') AS type, {lang}, geometry
        FROM {layer(source, n)} {where}
    """


def depth(con: duckdb.DuckDBPyConnection, source: str, iso3: str) -> int:
    """Deepest level with more units than the one above and FULL_COVER of level 1's area."""
    if (iso3, source) in DEPTH:
        return DEPTH[iso3, source]
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
    """Spec sort cascade as one text key: srcid (digit-only by value), name, name1..3, nulls last, then id."""
    s = f"{alias}.srcid"
    # Digit-only first, then by digit count and value, so any length sorts numerically.
    value = f"coalesce(nullif(ltrim({s}, '0'), ''), '0')"
    padded = (
        f"CASE WHEN regexp_full_match({s}, '[0-9]+') "
        f"THEN '0' || lpad(length({value})::VARCHAR, 5, '0') || {value} ELSE '1' || {s} END"
    )
    parts = [
        f"(({v}) IS NULL)::INT::VARCHAR || coalesce({v}, '')"
        for v in (
            padded,
            *(f"{alias}.{c}" for c in ("name", "name1", "name2", "name3")),
        )
    ]
    return " || chr(31) || ".join([*parts, f"{alias}.id"])


def stage_sql(
    source: str, iso3: str, lvl: int, adm0_name: str, keep: str | None = None
) -> str:
    """One row per level-lvl unit (srcid in keep, if given) with every level's columns, sort key in adm{n}_pcode."""
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
                "filler",
            )
        )
        ctes.append(
            f"u{n} AS (SELECT id, {attrs}, count(DISTINCT parent) AS parents, "
            "CASE WHEN count(*) OVER () > 1 THEN nullif(trim(any_value(part)), '') END AS part, "
            f"{geom} AS geometry FROM ({units(source, n, iso3)}) GROUP BY id)"
        )
    joins = " ".join(
        f"LEFT JOIN u{n} ON u{n + 1}.parent = u{n}.id" for n in range(lvl - 1, 0, -1)
    )
    adm0 = f"'{adm0_name.replace(chr(39), chr(39) * 2)}'"
    # One lang{i} per row, nearest the leaf; a level's name{i} stays only if its own tag matches.
    langs = {
        i: f"coalesce({', '.join(f'u{k}.lang{i}' for k in range(lvl, 0, -1))})"
        for i in (1, 2, 3)
    }
    cols = [f"{adm0} AS adm0_name"]
    for n in range(1, lvl + 1):
        cols += [
            f"CASE WHEN u{n}.filler THEN coalesce(u{n}.part, {adm0}) ELSE u{n}.name END AS adm{n}_name",
            *(
                f"CASE WHEN u{n}.lang{i} = {langs[i]} THEN u{n}.name{i} END AS adm{n}_name{i}"
                for i in (1, 2, 3)
            ),
            f"{_key(f'u{n}')} AS adm{n}_pcode",
            f"u{n}.srcid AS adm{n}_srcid",
            f"u{n}.type AS adm{n}_type",
            f"u{n}.id AS _id{n}",
            f"u{n}.parents AS _parents{n}",
        ]
    cols += [f"u{lvl}.lang", *(f"{langs[i]} AS lang{i}" for i in (1, 2, 3))]
    return f"""
        WITH {", ".join(ctes)}
        SELECT {", ".join(cols)}, {lvl} AS src_lvl, u{lvl}.geometry
        FROM u{lvl} {joins} {f"WHERE u{lvl}.srcid IN ({keep})" if keep else ""}
    """
