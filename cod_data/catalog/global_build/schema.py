"""The COD-AB field schema, read from the Specification's JSON Schema."""

import json
import re
from functools import cache
from pathlib import Path

SCHEMA_JSON = Path("src/lib/standards/schema.json")


@cache
def _schema() -> dict:
    return json.loads(SCHEMA_JSON.read_text())


def _family(pattern: str) -> str:
    """'^adm\\d_pcode$' -> 'pcode'."""
    return pattern.removeprefix("^adm\\d_").removesuffix("$")


def level_fields() -> list[str]:
    return [_family(p) for p in _schema()["patternProperties"]]


def tail() -> list[str]:
    """The fields after the per-level ones, in order."""
    return list(_schema()["properties"])


def level_cols(n: int) -> list[str]:
    """The per-level fields, level n first, down to adm0."""
    return [f"adm{k}_{c}" for k in range(n, -1, -1) for c in level_fields()]


def spec(col: str) -> dict:
    s = _schema()
    if col in s["properties"]:
        return s["properties"][col]
    family = col.split("_", 1)[1]
    return next(v for k, v in s["patternProperties"].items() if _family(k) == family)


def not_null(col: str) -> bool:
    t = spec(col)["type"]
    return "null" not in ([t] if isinstance(t, str) else t)


def description(col: str) -> str | None:
    """col's description, with {N} filled in for adm{N}_ fields; a bare family (pcode) keeps {N}."""
    s = _schema()
    if col in s["properties"]:
        return s["properties"][col]["description"]
    level, family = (
        (col[3], col[5:]) if re.fullmatch(r"adm\d_.+", col) else ("{N}", col)
    )
    if family not in level_fields():
        return None
    return spec(f"adm0_{family}")["description"].replace("{N}", level)
