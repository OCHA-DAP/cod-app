"""Catalog paths and settings shared by the catalog scripts, run from the repo root."""

import csv
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import tylertoo
import yaml
from dotenv import load_dotenv
from shared.geoparquet import TABLE_OPTIONS

load_dotenv(".env")
CATALOG = Path(os.environ.get("CATALOG", "catalog"))
SOURCES = ("ocha", "wfp", "unicef", "unhcr", "fao", "ungeodata")
COD_AB_BASE = "https://data.source.coop/hdx/cod-ab"
COD_AB_CACHE = Path("tmp/catalog/cache/cod-ab")
DUCKDB_TMP = Path("tmp/catalog/duckdb-tmp")
TILE_MAX_ZOOM = 11
CONTACT = {"name": "HDX Data Systems Team", "email": "hdx@un.org"}
HOST = {
    "name": "OCHA Centre for Humanitarian Data",
    "roles": ["host"],
    "url": "https://github.com/OCHA-DAP/cod-site/issues",
}
SELF_PUBLISHED = [{**HOST, "roles": ["producer", "licensor", "host"]}]
# Boundary sources and their provider metadata.
PARTNERS = {
    "ocha": {
        "label": "OCHA",
        "provider": "OCHA",
        "url": None,
        "source_url": "https://data.humdata.org/dataset/cod-ab-global",
    },
    "wfp": {
        "label": "WFP",
        "provider": "World Food Programme (WFP)",
        "url": None,
    },
    "unicef": {
        "label": "UNICEF",
        "provider": "UNICEF",
        "url": None,
    },
    "unhcr": {
        "label": "UNHCR",
        "provider": "UNHCR",
        "url": None,
        "source_url": {
            "1": "https://data.humdata.org/dataset/first-level-administrative-divisions-admin1",
            "2": "https://data.humdata.org/dataset/second-level-administrative-divisions-admin2",
        },
    },
    "fao": {
        "label": "FAO",
        "provider": "FAO (GAUL 2025)",
        "url": "https://storage.googleapis.com/fao-maps-catalog-data/boundaries/",
        "source_url": "https://data.apps.fao.org/catalog/dataset/global-administrative-unit-layers-gaul-2025",
    },
}


@dataclass(frozen=True)
class BoundarySource:
    name: str
    iso3_field: str
    levels: list[int]
    junk_field: str | None = None  # may contain "{level}"
    junk_values: list[str] = field(default_factory=list)


# Filler units (lakes, "Under National Administration") left out of stats and matching; mirrors src/lib/explorer/sources.ts.
BOUNDARY_SOURCES = [
    BoundarySource("ocha", "iso3", [1, 2, 3, 4]),
    BoundarySource(
        "wfp",
        "iso3",
        [1, 2, 3, 4],
        "adm{level}_name",
        ["Under National Administration", "N/A", "Undefined"],
    ),
    BoundarySource(
        "unicef",
        "adm0_ucode",
        [1, 2, 3, 4],
        "name",
        ["Under National Administration", "Lake Tanganyika", "N/A", "Undefined"],
    ),
    BoundarySource("unhcr", "iso3", [1, 2]),
    BoundarySource(
        "fao",
        "ISO3_CODE",
        [1, 2],
        "GAUL{level}_NAME",
        ["Waterbody", "Undefined", "Administrative Unit Not Available"],
    ),
]


def junk_filter(src: BoundarySource, level: int) -> str:
    """SQL WHERE clause dropping src's filler units at level, or ''."""
    if not src.junk_field:
        return ""
    quoted = ", ".join("'" + v.replace("'", "''") + "'" for v in src.junk_values)
    return f"WHERE {src.junk_field.replace('{level}', str(level))} NOT IN ({quoted})"


def item_dir(name: str) -> Path:
    """explorer/<source>/<name>/ for boundary layers, explorer/reference/<name>/ for tables."""
    source = name.split("_", 1)[0]
    parent = source if source in SOURCES else "reference"
    path = CATALOG / "explorer" / parent / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def path_of(name: str, ext: str = "parquet") -> Path:
    return item_dir(name) / f"{name}.{ext}"


def connect(
    db: Path | None = None, memory_limit: str = "2GB"
) -> duckdb.DuckDBPyConnection:
    """A DuckDB connection capped at DUCKDB_MEMORY_LIMIT (else memory_limit) that spills to DUCKDB_TMP."""
    DUCKDB_TMP.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db) if db else ":memory:")
    con.execute(
        f"SET memory_limit = '{os.environ.get('DUCKDB_MEMORY_LIMIT', memory_limit)}'; SET threads = 2; SET preserve_insertion_order = false; "
        f"SET temp_directory = '{DUCKDB_TMP}'; LOAD spatial"
    )
    return con


def csv_to_parquet(rows: list, out: Path, select: str = "SELECT * FROM {csv}") -> None:
    """Write rows (header first) to a temporary CSV, then COPY select over it ({csv}) to out."""
    out.parent.mkdir(parents=True, exist_ok=True)
    DUCKDB_TMP.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DUCKDB_TMP.parent) as tmp:
        path = Path(tmp) / "rows.csv"
        with path.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows(rows)
        con = connect()
        query = select.replace("{csv}", f"read_csv('{path}')")
        con.execute(f"COPY ({query}) TO '{out}' {TABLE_OPTIONS}")
        con.close()


def tile_parquet(parquet: Path, pmtiles: Path, layer: str) -> None:
    """Tile one GeoParquet with tylertoo, every feature at every zoom (COD-AB's settings)."""
    with tempfile.TemporaryDirectory(dir=DUCKDB_TMP.parent) as tmp:
        overview = Path(tmp) / "overview.parquet"
        tylertoo.overview(
            str(parquet),
            str(overview),
            max_zoom=TILE_MAX_ZOOM,
            density_drop=False,
            point_thinning=0.0,
            line_thinning=0,
            line_visibility=0,
            polygon_thinning=0,
            polygon_visibility=0,
            profile="bounded",
            spill_dir=tmp,
        )
        # The default 512 KB limit drops features silently from oversized tiles.
        tylertoo.export_pmtiles(
            str(overview),
            str(pmtiles),
            layer_name=layer,
            tile_size_limit=None,
            spill_dir=tmp,
        )


def tile_labels(parquet: Path, pmtiles: Path, layer: str) -> None:
    """Tile one label point per unit, at its maximum inscribed circle center."""
    with tempfile.TemporaryDirectory(dir=DUCKDB_TMP.parent) as tmp:
        points = Path(tmp) / "points.parquet"
        con = connect(memory_limit="4GB")
        con.execute(f"""
            COPY (
                SELECT * REPLACE (ST_MaximumInscribedCircle(geometry, 1e-6).center AS geometry)
                FROM read_parquet('{parquet}')
            ) TO '{points}' (FORMAT PARQUET, COMPRESSION ZSTD, GEOPARQUET_VERSION V2)
        """)
        con.close()
        tile_parquet(points, pmtiles, layer)


def public_url(*parts: str) -> str:
    """The HTTPS URL of a catalog path, from PORTOLAN_REMOTE (s3://<account>/<product>)."""
    product = os.environ["PORTOLAN_REMOTE"].removeprefix("s3://").strip("/")
    return "/".join(["https://data.source.coop", product, *parts])


def read_sheet_url() -> str | None:
    return os.environ.get("PUBLIC_DECISIONS_SHEET_URL") or None


def write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=1000)
    )


def apply_titles(catalog: Path) -> None:
    for metadata in catalog.rglob(".portolan/metadata.yaml"):
        fields = yaml.safe_load(metadata.read_text()) or {}
        for name in ("catalog.json", "collection.json"):
            stac_path = metadata.parent.parent / name
            if stac_path.exists() and {"title", "description"} <= fields.keys():
                stac = json.loads(stac_path.read_text())
                stac["title"], stac["description"] = (
                    fields["title"],
                    fields["description"],
                )
                stac_path.write_text(
                    json.dumps(stac, indent=2, ensure_ascii=False) + "\n"
                )
