"""Fetch per-country, per-level admin unit counts from Mapbox's Boundaries Explorer demo.

Mapbox Boundaries itself is a licensed dataset with no public bulk API, but the
public demo at demos.mapbox.com/boundaries-explorer loads a small per-country,
per-level lookup JSON (name/code/wikidata_id per unit) to populate its own UI.
Counting entries in that lookup reproduces the "how many admin units does
Mapbox Boundaries have" figure a person would otherwise read off the demo by
hand, without needing a Mapbox Boundaries API token.

Requires m49.parquet (run m49.py first).
"""

from concurrent.futures import ThreadPoolExecutor

from common import connect, csv_to_parquet, path_of
from httpx2 import HTTPStatusError
from shared import http

LOOKUP_URL = (
    "https://demos.mapbox.com/boundaries-explorer/lib/lookups/{iso2}/adm{level}.json"
)
LEVELS = [1, 2, 3, 4]
M49_PARQUET = path_of("m49")
OUT_PARQUET = path_of("mapbox_boundaries")
MAX_WORKERS = 8


def fetch_count(iso2: str, level: int) -> int | None:
    url = LOOKUP_URL.format(iso2=iso2, level=level)
    try:
        data = http.get(url, headers={"User-Agent": "Mozilla/5.0"}).json()
    except HTTPStatusError as e:
        # A 404 means the country has no such level.
        if e.response.status_code == 404:
            return None
        raise
    return len(data.get("all", {}))


def get_iso2_codes() -> list[tuple[str, str]]:
    con = connect()
    rows = con.execute(f"""
        SELECT "ISO-alpha3 Code" AS iso3, "ISO-alpha2 Code" AS iso2
        FROM read_parquet('{M49_PARQUET}')
        WHERE "ISO-alpha2 Code" IS NOT NULL
    """).fetchall()
    con.close()
    return rows


countries = get_iso2_codes()
rows: list[tuple[str, str, int, int]] = []

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
    futures = {
        pool.submit(fetch_count, iso2, level): (iso3, iso2, level)
        for iso3, iso2 in countries
        for level in LEVELS
    }
    for future, (iso3, iso2, level) in futures.items():
        count = future.result()
        if count is not None:
            rows.append((iso3, iso2, level, count))

csv_to_parquet([["iso3", "iso2", "level", "feature_count"], *sorted(rows)], OUT_PARQUET)

print(
    f"Wrote Mapbox Boundaries counts for {len(rows)} country/level pairs → {OUT_PARQUET}"
)
