import csv
from datetime import datetime
from pathlib import Path

from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "plans.csv"

FIRST_YEAR = 2000


def fetch_plans_for_year(year: int) -> list:
    url = f"https://api.hpc.tools/v2/public/plan?year={year}&limit=500"
    res = http.get(url, timeout=30)
    return res.json().get("data", [])


def get_plan_type(plan: dict) -> str:
    for cat in plan.get("categories", []):
        if cat.get("group") == "planType":
            return cat.get("code", "")
    return ""


def build_rows(plans: list, year: int) -> list[dict]:
    rows = []
    for plan in plans:
        plan_type = get_plan_type(plan)
        for loc in plan.get("locations", []):
            iso3 = loc.get("iso3", "")
            if iso3:
                rows.append({"iso3": iso3, "year": year, "type": plan_type, "id": plan["id"]})
    return sorted(rows, key=lambda r: (r["iso3"], r["type"], str(r["id"])))


current_year = datetime.now().year
years = list(range(current_year, FIRST_YEAR - 1, -1))

all_rows: list[dict] = []
for year in years:
    plans = fetch_plans_for_year(year)
    print(f"{len(plans)} plans fetched for {year}")
    all_rows.extend(build_rows(plans, year))

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=["iso3", "year", "type", "id"])
    writer.writeheader()
    writer.writerows(all_rows)

print(f"{len(all_rows)} rows written to {OUTPUT}")
