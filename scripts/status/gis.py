import csv
import os
import re
import sys
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
OUTPUT = OUTPUT_DIR / "gis.csv"

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


def fetch_services(token: str) -> list[dict]:
    url = f"{BASE_URL}/server/rest/services/Hosted"
    res = http.get(url, params={"f": "json", "token": token}, headers=HEADERS, timeout=30)
    data = res.json()
    if "error" in data:
        print(f"Services error: {data['error']}", file=sys.stderr)
        sys.exit(1)
    return data.get("services", [])


COD_AB_RE = re.compile(r"^(?:Hosted/)?cod_ab_([a-z]{3})(?:[_-].*)?$", re.IGNORECASE)


def extract_countries(services: list[dict]) -> list[str]:
    return sorted({
        m.group(1).upper()
        for svc in services
        if (m := COD_AB_RE.match(svc.get("name", "")))
    })


token = get_token()
services = fetch_services(token)
print(f"{len(services)} services found in Hosted folder")

countries = extract_countries(services)
print(f"{len(countries)} COD-AB countries found")

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.writer(f)
    writer.writerow(["iso3"])
    writer.writerows([iso3] for iso3 in countries)

print(f"\nWritten to {OUTPUT}")
