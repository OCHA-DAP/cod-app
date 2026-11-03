import csv
from pathlib import Path

from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "hdx.csv"

BASE_URL = "https://data.humdata.org/api/3/action/package_search"
PREFIX = "cod-ab-"
PAGE_SIZE = 500


def fetch_hdx_iso3() -> list[str]:
    iso3_set: set[str] = set()
    start = 0
    while True:
        res = http.get(
            BASE_URL,
            params={"q": f"name:{PREFIX}*", "rows": PAGE_SIZE, "start": start},
            timeout=30,
        )
        data = res.json()
        results = data.get("result", {}).get("results", [])
        for dataset in results:
            name = dataset.get("name", "")
            if name.startswith(PREFIX):
                iso3 = name[len(PREFIX) :].upper()
                if len(iso3) == 3 and iso3.isalpha():
                    iso3_set.add(iso3)
        total = data.get("result", {}).get("count", 0)
        start += len(results)
        if start >= total or not results:
            break
    return sorted(iso3_set)


iso3_list = fetch_hdx_iso3()

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=["iso3"])
    writer.writeheader()
    for iso3 in iso3_list:
        writer.writerow({"iso3": iso3})

print(f"{len(iso3_list)} HDX COD AB datasets written to {OUTPUT}")
