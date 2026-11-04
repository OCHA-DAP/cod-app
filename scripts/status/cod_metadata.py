import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from shared import http

# Load .env if present (for local development)
dotenv = Path(__file__).parents[2] / ".env"
if dotenv.exists():
    for line in dotenv.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "cod_metadata.csv"

username = os.environ.get("ARCGIS_USERNAME")
password = os.environ.get("ARCGIS_PASSWORD")

if not username or not password:
    print(
        "Error: ARCGIS_USERNAME and ARCGIS_PASSWORD must be set in .env or environment",
        file=sys.stderr,
    )
    sys.exit(1)

BASE_URL = "https://gis.unocha.org"
HEADERS = {"Referer": BASE_URL}
FEATURE_URL = f"{BASE_URL}/server/rest/services/Hosted/COD_Global_Metadata/FeatureServer/0"


def get_token() -> str:
    res = http.post(
        f"{BASE_URL}/portal/sharing/rest/generateToken",
        data={
            "username": username,
            "password": password,
            "client": "referer",
            "referer": BASE_URL,
            "f": "json",
        },
        headers=HEADERS,
        timeout=30,
    )
    data = res.json()
    if "error" in data:
        print(f"Token error: {data['error']}", file=sys.stderr)
        sys.exit(1)
    if "token" not in data:
        print(f"No token in response: {data}", file=sys.stderr)
        sys.exit(1)
    return data["token"]


def fetch_all_records(token: str) -> list[dict]:
    records = []
    offset = 0
    page_size = 1000
    while True:
        res = http.get(
            f"{FEATURE_URL}/query",
            params={
                "where": "1=1",
                "outFields": "*",
                "resultOffset": offset,
                "resultRecordCount": page_size,
                "f": "json",
                "token": token,
            },
            headers=HEADERS,
            timeout=30,
        )
        data = res.json()
        if "error" in data:
            print(f"Query error: {data['error']}", file=sys.stderr)
            sys.exit(1)
        features = data.get("features", [])
        records.extend(f["attributes"] for f in features)
        if len(features) < page_size:
            break
        offset += page_size
    return records


def convert_timestamps(record: dict) -> dict:
    """Convert ArcGIS Unix-ms timestamp integers to ISO date strings."""
    converted = {}
    for k, v in record.items():
        if isinstance(v, int) and v > 1e11:
            converted[k] = datetime.fromtimestamp(v / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        else:
            converted[k] = v if v is not None else ""
    return converted


token = get_token()
print("Fetching COD_Global_Metadata records...")
records = fetch_all_records(token)
print(f"{len(records)} records fetched")

records = [convert_timestamps(r) for r in records if r.get("country_iso3")]

if not records:
    print("No records with country_iso3 found", file=sys.stderr)
    sys.exit(1)

# Column order: country_iso3 first, then all others alphabetically
all_cols = sorted({k for r in records for k in r} - {"country_iso3"})
fieldnames = ["country_iso3"] + all_cols

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(records)

print(f"Written {len(records)} records to {OUTPUT}")
