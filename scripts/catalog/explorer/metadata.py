"""Write metadata.yaml, AGENTS.md and TERMS.md for the catalog root, explorer/ and tools/."""

from pathlib import Path

from common import (
    CATALOG,
    CONTACT,
    HOST,
    PARTNERS,
    SELF_PUBLISHED,
    public_url,
    write_yaml,
)

TEMPLATES = Path(__file__).parent / "agents"
CC_BY = {
    "license": "CC-BY-4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
}
PRODUCER_TERMS = {"license": "other", "license_url": "../../TERMS.md"}
OUTLINES = {
    "ungeodata_adm0": ("UN Geodata country outlines", "UN Geodata 1M country outlines"),
    "ungeodata_lines": (
        "UN Geodata boundary lines",
        "UN Geodata 1M international boundary lines and coastlines",
    ),
}
REFERENCE = {
    "m49": "UN M49 codes, names and regions for each country or area, from the UN Statistics Division.",
    "iso3166": "ISO 3166-2 subdivision counts per location, from Debian's iso-codes.",
    "plan_status": "Best humanitarian plan type ever recorded per location, from OCHA's HPC Tools.",
    "office_type": "OCHA office type per location: country office, regional office or humanitarian advisory team.",
    "mapbox_boundaries": "Mapbox Boundaries admin unit counts per location and level, from Mapbox's public Boundaries Explorer demo.",
    "source_stats": "Feature and vertex counts per source, location and level.",
    "source_provenance": "Provider and last-updated date per source and location.",
    "source_match": "Polygon match rate of each source against the team's selected source per location.",
    "source_comparison": "Stats, provenance, match rates, reference counts and team decisions, one row per location, source and level.",
    "country_bbox": "Antimeridian-aware map-fit bounding box per location.",
}
THIRD_PARTY_TABLES = {"m49", "iso3166", "mapbox_boundaries"}
OCHA = {"name": "OCHA", "roles": ["producer", "licensor"]}
REFERENCE_SOURCES = {
    "m49": (
        {
            "name": "UN Statistics Division",
            "roles": ["producer", "licensor"],
            "url": "https://unstats.un.org/",
        },
        "https://unstats.un.org/unsd/methodology/m49/overview/",
    ),
    "iso3166": (
        {
            "name": "Debian iso-codes",
            "roles": ["producer", "licensor"],
            "url": "https://salsa.debian.org/iso-codes-team/iso-codes",
        },
        "https://salsa.debian.org/iso-codes-team/iso-codes",
    ),
    "mapbox_boundaries": (
        {
            "name": "Mapbox",
            "roles": ["producer", "licensor"],
            "url": "https://www.mapbox.com/",
        },
        "https://demos.mapbox.com/boundaries-explorer/",
    ),
    "plan_status": ({**OCHA, "url": "https://hpc.tools/"}, "https://hpc.tools/"),
    "office_type": (OCHA, None),
}
UN_GEODATA = {
    "name": "United Nations Geospatial",
    "roles": ["producer", "licensor"],
    "url": "https://www.un.org/geospatial/",
}


def template(name: str) -> str:
    return (TEMPLATES / f"{name}.md").read_text().format(data=public_url())


def boundary(collection: Path) -> dict:
    name = collection.name
    if name in OUTLINES:
        title, what = OUTLINES[name]
        provider, extra, source = UN_GEODATA, "", None
    else:
        partner = PARTNERS[collection.parent.name]
        level = name.rsplit("adm", 1)[1]
        title = what = f"{partner['label']} admin {level}"
        url = {"url": partner["url"]} if partner["url"] else {}
        provider = {
            "name": partner["provider"],
            "roles": ["producer", "licensor"],
            **url,
        }
        source = partner.get("source_url")
        source = source.get(level) if isinstance(source, dict) else source
        extra = f", and label points at each unit's maximum inscribed circle in `{name}_labels.pmtiles`"
    return {
        "title": title,
        "description": f"{what} as GeoParquet, with polygon tiles{extra}.",
        "providers": [provider, HOST],
        **({"source_url": source} if source else {}),
        "processing_notes": "Reprojected to OGC:CRS84, made valid and clipped to ±180° longitude, then tiled with tylertoo to zoom 11 with every feature kept at every zoom. Every layer carries a `hover_id` row index for the map.",
        **PRODUCER_TERMS,
    }


def main() -> None:
    write_yaml(
        CATALOG / ".portolan" / "metadata.yaml",
        {
            "title": "COD site data",
            "description": "Data behind the CODs site: partner admin boundaries and reference tables for the Boundaries Explorer in explorer/, and sample inputs for the tools in tools/. Agents should start at [AGENTS.md](AGENTS.md).",
            "contact": CONTACT,
            **CC_BY,
            "providers": [HOST],
        },
    )
    (CATALOG / "AGENTS.md").write_text(template("root"))

    explorer = CATALOG / "explorer"
    write_yaml(
        explorer / ".portolan" / "metadata.yaml",
        {
            "title": "Boundaries Explorer data",
            "description": "Admin boundaries from OCHA and several partner sources, and the reference tables the Boundaries Explorer compares them with. Agents should start at [AGENTS.md](AGENTS.md).",
        },
    )
    (explorer / "AGENTS.md").write_text(template("explorer"))
    (explorer / "TERMS.md").write_text(template("terms"))
    for source in sorted(
        p for p in explorer.iterdir() if p.is_dir() and p.name != "reference"
    ):
        label = (
            PARTNERS[source.name]["label"] if source.name in PARTNERS else "UN Geodata"
        )
        write_yaml(
            source / ".portolan" / "metadata.yaml",
            {
                "title": label,
                "description": f"{label} boundary layers, one collection each.",
            },
        )
        for collection in sorted(
            p for p in source.iterdir() if p.is_dir() and p.name != ".portolan"
        ):
            write_yaml(collection / ".portolan" / "metadata.yaml", boundary(collection))

    reference = explorer / "reference"
    write_yaml(
        reference / ".portolan" / "metadata.yaml",
        {
            "title": "Reference tables",
            "description": "Per-location tables the Boundaries Explorer reads.",
        },
    )
    for table, description in REFERENCE.items():
        terms = PRODUCER_TERMS if table in THIRD_PARTY_TABLES else {}
        producer, source = REFERENCE_SOURCES.get(table, (None, None))
        write_yaml(
            reference / table / ".portolan" / "metadata.yaml",
            {
                "title": table.replace("_", " ").capitalize(),
                "description": description,
                "providers": [producer, HOST] if producer else SELF_PUBLISHED,
                **({"source_url": source} if source else {}),
                **terms,
            },
        )

    write_yaml(
        CATALOG / "tools" / ".portolan" / "metadata.yaml",
        {
            "title": "Tools sample data",
            "description": "Sample inputs for the site's tools and topo-tools, grouped by ISO3 code. Agents should start at [AGENTS.md](AGENTS.md).",
        },
    )


if __name__ == "__main__":
    main()
