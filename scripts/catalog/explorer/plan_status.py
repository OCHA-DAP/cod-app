#!/usr/bin/env python3
"""Fetch OCHA HPC Tools plan data and rank each country's humanitarian plan status.

Ranking mirrors hdx-cod-ab-status's woPlanTypeRank: HNRP > HRP > FA > REG > Other > none.
Requires m49.parquet (run m49.py first).
"""

from datetime import date

from common import csv_to_parquet, path_of
from httpx2 import HTTPStatusError
from shared import http

FIRST_YEAR = 2000
LAST_YEAR = date.today().year
M49_PARQUET = path_of("m49")
OUT_PARQUET = path_of("plan_status")


def fetch_plans_for_year(year: int) -> list:
    url = f"https://api.hpc.tools/v2/public/plan?year={year}&limit=500"
    return http.get(url, headers={"User-Agent": "Mozilla/5.0"}).json().get("data", [])


def get_plan_type(plan: dict) -> str:
    for cat in plan.get("categories", []):
        if cat.get("group") == "planType":
            return cat.get("code", "")
    return ""


rows = []
for year in range(FIRST_YEAR, LAST_YEAR + 1):
    try:
        plans = fetch_plans_for_year(year)
    except HTTPStatusError:
        continue
    for plan in plans:
        plan_type = get_plan_type(plan)
        if not plan_type:
            continue
        for loc in plan.get("locations", []):
            iso3 = (loc.get("iso3") or "").strip().upper()
            if len(iso3) == 3:
                rows.append((iso3, year, plan_type))

# Rank per iso3 with the best (lowest) rank ever seen across all fetched years,
# tie-broken by the most recent year, then left-join onto the full M49 country
# list so every country gets a row (rank=5, nulls) even with no plan history.
csv_to_parquet(
    [["iso3", "year", "type"], *rows],
    OUT_PARQUET,
    f"""
              WITH raw AS (
                SELECT iso3, year, type,
                  CASE
                    WHEN lower(type) LIKE '%hnrp%' THEN 0
                    WHEN lower(type) LIKE '%hrp%' THEN 1
                    WHEN lower(type) LIKE '%fa%' THEN 2
                    WHEN lower(type) LIKE '%reg%' THEN 3
                    ELSE 4
                  END AS rank
                FROM {{csv}}
              ),
              best AS (
                SELECT iso3, type AS plan_type, year AS plan_year, rank
                FROM raw
                QUALIFY row_number() OVER (
                  PARTITION BY iso3 ORDER BY rank ASC, year DESC
                ) = 1
              )
              SELECT
                m."ISO-alpha3 Code" AS iso3,
                b.plan_type,
                b.plan_year,
                COALESCE(b.rank, 5) AS rank
              FROM read_parquet('{M49_PARQUET}') m
              LEFT JOIN best b ON b.iso3 = m."ISO-alpha3 Code"
    """,
)

print(f"Wrote plan status from {len(rows)} plan-country-year rows → {OUT_PARQUET}")
