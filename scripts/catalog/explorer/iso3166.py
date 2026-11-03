#!/usr/bin/env python3
"""Fetch ISO 3166-2 subdivision counts from Debian's iso-codes project.

ISO's own Online Browsing Platform (iso.org/obp) has no public API and blocks
scraping, but Debian's iso-codes package — the same source pycountry uses —
publishes a JSON mirror of the standard's subdivision codes. Counting entries
per country reproduces the "how many subdivisions does ISO list" figure a
person would otherwise read off the OBP UI by hand.

Requires m49.parquet (run m49.py first).
"""

from collections import Counter

from common import csv_to_parquet, path_of
from shared import http

URL = (
    "https://salsa.debian.org/iso-codes-team/iso-codes/-/raw/main/data/iso_3166-2.json"
)
M49_PARQUET = path_of("m49")
OUT_PARQUET = path_of("iso3166")

# Salsa's Anubis bot-check challenges a browser User-Agent but passes httpx2's script-like default.
subdivisions = http.get(URL).json()["3166-2"]

counts = Counter(entry["code"][:2] for entry in subdivisions)

csv_to_parquet(
    [["iso2", "subdivision_count"], *sorted(counts.items())],
    OUT_PARQUET,
    f"""
    SELECT
      m."ISO-alpha3 Code" AS iso3,
      m."ISO-alpha2 Code" AS iso2,
      c.subdivision_count
    FROM read_parquet('{M49_PARQUET}') m
    LEFT JOIN {{csv}} c ON c.iso2 = m."ISO-alpha2 Code"
    """,
)

print(
    f"Wrote ISO 3166-2 subdivision counts for {len(counts)} countries → {OUT_PARQUET}"
)
