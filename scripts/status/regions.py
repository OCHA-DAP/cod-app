import csv
import sys
from pathlib import Path

from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "regions.csv"

# hub code → HDX org slug
HUBS: dict[str, str] = {
    "ROSEA": "ocha-rosea",
    "ROAP": "ocha-roap",
    "ROWCA": "ocha-rowca",
    "ROLAC": "ocha-rolac",
    "ROMENA": "ocha-romena",
}

# Minimum ratio of (winner datasets / loser datasets) required to resolve a
# conflict in favour of the dominant hub. Below this ratio the conflict is
# left unresolved and the country is excluded from the output.
CONFLICT_RATIO_THRESHOLD = 2

HDX_BASE = "https://data.humdata.org/api/3/action/package_search"


def ckan_get(url: str, params: dict) -> dict:
    res = http.get(url, params=params, timeout=30)
    return res.json()


def fetch_hdx_org_countries(org_name: str) -> set[str]:
    data = ckan_get(HDX_BASE, {"fq": f"organization:{org_name}", "rows": 1000, "fl": "groups"})
    if not data.get("success"):
        raise RuntimeError("CKAN returned success=false")
    countries: set[str] = set()
    for pkg in data.get("result", {}).get("results", []):
        for grp in pkg.get("groups", []):
            name = grp if isinstance(grp, str) else grp.get("name", "")
            if len(name) == 3 and name.isalpha():
                countries.add(name.upper())
    return countries


def fetch_hdx_hubs():
    mapping: dict[str, str] = {}
    all_hubs: dict[str, set[str]] = {}

    for hub, org_name in HUBS.items():
        try:
            countries = fetch_hdx_org_countries(org_name)
        except Exception as err:
            print(f"  HDX: failed for {org_name}: {err}", file=sys.stderr)
            continue
        for iso3 in countries:
            all_hubs.setdefault(iso3, set()).add(hub)

    conflict_resolutions: dict[str, dict | None] = {}

    for iso3, hubs in all_hubs.items():
        if len(hubs) == 1:
            mapping[iso3] = next(iter(hubs))
        else:
            counts: dict[str, int] = {}
            for hub in hubs:
                org_slug = HUBS[hub]
                try:
                    data = ckan_get(
                        HDX_BASE,
                        {"fq": f"organization:{org_slug} groups:{iso3.lower()}", "rows": 0},
                    )
                    counts[hub] = data.get("result", {}).get("count", 0)
                except Exception:
                    counts[hub] = 0
            winner_hub = max(counts, key=counts.__getitem__)
            winner_count = counts[winner_hub]
            loser_count = max(v for h, v in counts.items() if h != winner_hub)
            if loser_count == 0 or winner_count / loser_count >= CONFLICT_RATIO_THRESHOLD:
                mapping[iso3] = winner_hub
                conflict_resolutions[iso3] = {"hub": winner_hub, "counts": counts}
            else:
                conflict_resolutions[iso3] = None  # unresolved

    return mapping, all_hubs, conflict_resolutions


def print_analysis(all_hubs, conflict_resolutions):
    for hub in HUBS:
        count = sum(1 for hubs in all_hubs.values() if hub in hubs)
        print(f"  {hub}: {count} countries")

    if conflict_resolutions:
        print("\n  Conflicts (country claimed by multiple hubs):")
        for iso3, resolution in conflict_resolutions.items():
            hubs = all_hubs.get(iso3, set())
            if resolution:
                counts_str = ", ".join(f"{h}:{n}" for h, n in resolution["counts"].items())
                print(f"    {iso3}: {' + '.join(hubs)} → {resolution['hub']} ({counts_str})")
            else:
                print(
                    f"    {iso3}: {' + '.join(hubs)} → unresolved, excluded",
                    file=sys.stderr,
                )


hub_mapping, all_hubs, conflict_resolutions = fetch_hdx_hubs()

print_analysis(all_hubs, conflict_resolutions)

rows = sorted(hub_mapping.keys())
with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.writer(f)
    writer.writerow(["iso3", "regional"])
    for iso3 in rows:
        writer.writerow([iso3, hub_mapping[iso3]])

print(f"\nWrote {len(rows)} rows → {OUTPUT}")
