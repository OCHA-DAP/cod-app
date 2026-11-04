"""
offices.py

Fetches OCHA country offices (CO), humanitarian advisory teams (HAT),
and regional offices (RO) from the OCHA PowerBI dashboard and writes
public/status/data/offices.csv.

Output CSV columns:  iso3, type   (type is "CO", "HAT", or "RO")

Also verifies the CO list against the Jan 2026 OCHA org chart PDF.

Usage:
    python3 scripts/offices.py

Requires: public/status/data/m49.csv (run m49.py first if missing)

Dashboard: https://app.powerbi.com/view?r=eyJrIjoiZTNmYjk4ZDUtZDFlYi00MzllLTk5YTAtY2NiNTQ5MmRmZWY0IiwidCI6IjBmOWUzNWRiLTU0NGYtNGY2MC1iZGNjLTVlYTQxNmU2ZGM3MCIsImMiOjh9
"""

import csv
import sys
from collections import Counter
from pathlib import Path

from httpx2 import HTTPError
from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_CSV = OUTPUT_DIR / "offices.csv"
M49_CSV = OUTPUT_DIR / "m49.csv"

# ---------------------------------------------------------------------------
# PowerBI embed parameters (decoded from the dashboard embed URL).
# The APIM host is derived from the cluster URI by stripping "-redirect"
# and appending "-api" to the first hostname segment (PowerBI getAPIMUrl logic).
# Cluster: https://wabi-north-europe-j-primary-redirect.analysis.windows.net
# APIM:    https://wabi-north-europe-j-primary-api.analysis.windows.net
# ---------------------------------------------------------------------------
RESOURCE_KEY = "e3fb98d5-d1eb-439e-99a0-ccb5492dfef4"
APIM = "https://wabi-north-europe-j-primary-api.analysis.windows.net"
MODEL_ID = 156451  # from conceptualschema response

# ---------------------------------------------------------------------------
# Country offices confirmed in the Jan 2026 OCHA org chart PDF.
# Used for verification only.
# ---------------------------------------------------------------------------
PDF_CO_ISO3: set[str] = {
    "AFG", "BFA", "CMR", "CAF", "TCD", "COL", "COD", "ERI", "ETH", "HTI",
    "LBN", "MLI", "MOZ", "MMR", "NER", "NGA", "PSE", "PAK", "SOM", "SSD",
    "SDN", "SYR", "TUR", "UKR", "VEN", "YEM",
}

# ---------------------------------------------------------------------------
# Name → ISO3 overrides for entries where the dashboard label differs from
# M49, or where the ISO column in the dashboard is null/missing.
# ---------------------------------------------------------------------------
NAME_OVERRIDES: dict[str, str] = {
    # CO table
    "opt": "PSE",  # "Occupied Palestinian Territory"
    "occupied palestinian territory": "PSE",
    "state of palestine": "PSE",
    "turkiye": "TUR",
    "türkiye": "TUR",
    "turkey": "TUR",
    "syrian arab republic": "SYR",
    "syria": "SYR",
    "venezuela (bolivarian republic of)": "VEN",
    "dr congo": "COD",
    "dr of the congo": "COD",
    "democratic republic of the congo": "COD",
    # HAT table
    "guatemala": "GTM",
    "iran": "IRN",
    "dprk": "PRK",  # M49: "Democratic People's Republic of Korea"
}

# ---------------------------------------------------------------------------
# Entries to skip entirely (not sovereign countries).
# ---------------------------------------------------------------------------
SKIP_NAMES: set[str] = {"office for the pacific (suva)", "asean", "aulo"}


# ---------------------------------------------------------------------------
# Build lowercase-name → ISO3 lookup from M49 CSV.
# ---------------------------------------------------------------------------
def build_m49_lookup() -> dict[str, str]:
    try:
        text = M49_CSV.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        print("  M49 CSV not found — run `python3 scripts/m49.py` first", file=sys.stderr)
        return {}
    lookup: dict[str, str] = {}
    reader = csv.reader(text.splitlines())
    header = next(reader)
    name_idx = header.index("country_or_area")
    iso3_idx = header.index("iso_alpha3_code")
    min_cols = max(name_idx, iso3_idx)
    for row in reader:
        if len(row) > min_cols:
            name = row[name_idx].lower().strip()
            iso3 = row[iso3_idx].strip()
            if name and iso3:
                lookup[name] = iso3
    return lookup


# ---------------------------------------------------------------------------
# PowerBI DSR decoder.
#
# Each row in DM0 can have:
#   S   — schema definition (skip as data row)
#   C   — array of new values (indices into ValueDicts)
#   R   — bitmask: bit i set = repeat column i from previous row
#   Ø   — bitmask: bit i set = column i is null (no C slot consumed)
#
# For each column i:
#   if R & (1<<i) → use prev[i]
#   else if Ø & (1<<i) → null
#   else → C[ci++]
# ---------------------------------------------------------------------------
def decode_dsr(dm_rows: list, dicts: dict, num_cols: int) -> list[list]:
    prev = [None] * num_cols
    results = []

    for row in dm_rows:
        # "S" marks a schema definition; the same row may also carry the first
        # data values in "C", so skip only when C is absent or empty.
        if "S" in row and not row.get("C"):
            continue

        R = row.get("R", 0)
        O = row.get("Ø", 0)
        c = row.get("C", [])

        vals = []
        ci = 0
        for i in range(num_cols):
            if R & (1 << i):
                vals.append(prev[i])
            elif O & (1 << i):
                vals.append(None)
            else:
                vals.append(c[ci] if ci < len(c) else None)
                ci += 1

        prev = list(vals)

        # Resolve dict indices to string values
        resolved = []
        for i, v in enumerate(vals):
            dict_key = f"D{i}"
            d = dicts.get(dict_key)
            if d is not None and isinstance(v, int):
                resolved.append(d[v] if v < len(d) else None)
            else:
                resolved.append(v)

        results.append(resolved)

    return results


# ---------------------------------------------------------------------------
# Resolve a country name to ISO3.
# ---------------------------------------------------------------------------
def resolve_iso3(name: str, m49: dict[str, str]) -> str | None:
    lower = name.lower().strip()
    if lower in NAME_OVERRIDES:
        return NAME_OVERRIDES[lower]
    if lower in m49:
        return m49[lower]
    # Partial match: every word in the display name appears in an M49 name
    words = lower.split()
    for m49_name, iso3 in m49.items():
        if all(w in m49_name for w in words):
            return iso3
    return None


# ---------------------------------------------------------------------------
# Query one PowerBI table and return decoded rows.
# ---------------------------------------------------------------------------
def query_table(table: str, columns: list[str]) -> list[list]:
    url = f"{APIM}/public/reports/querydata?preferReadOnlySession=true"
    headers = {
        "X-PowerBI-ResourceKey": RESOURCE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    select = [
        {
            "Column": {
                "Expression": {"SourceRef": {"Source": "t"}},
                "Property": col,
            },
            "Name": col,
        }
        for col in columns
    ]

    body = {
        "queries": [
            {
                "Query": {
                    "Commands": [
                        {
                            "SemanticQueryDataShapeCommand": {
                                "Query": {
                                    "Version": 2,
                                    "From": [{"Name": "t", "Entity": table, "Type": 0}],
                                    "Select": select,
                                },
                                "Binding": {
                                    "Primary": {"Groupings": [{"Projections": list(range(len(columns)))}]},
                                    "DataReduction": {
                                        "DataVolume": 4,
                                        "Primary": {"Window": {"Count": 500}},
                                    },
                                    "Version": 1,
                                },
                            }
                        }
                    ]
                }
            }
        ],
        "cancelQueries": [],
        "modelId": MODEL_ID,
    }

    try:
        res = http.post(url, json=body, headers=headers, timeout=20)
    except HTTPError as err:
        raise RuntimeError(f'querydata failed for "{table}": {err}') from err

    data = res.json()
    ds = (
        data.get("results", [{}])[0]
        .get("result", {})
        .get("data", {})
        .get("dsr", {})
        .get("DS", [{}])[0]
    )
    if not ds:
        raise RuntimeError(f'Unexpected querydata response for "{table}"')

    dm_rows = ds.get("PH", [{}])[0].get("DM0", [])
    dicts = ds.get("ValueDicts", {})
    return decode_dsr(dm_rows, dicts, len(columns))


# ---------------------------------------------------------------------------
# Verify COs against the PDF list.
# ---------------------------------------------------------------------------
def verify_against_pdf(co_iso3: set[str]) -> None:
    pdf_only = sorted(iso3 for iso3 in PDF_CO_ISO3 if iso3 not in co_iso3)
    pbi_only = sorted(iso3 for iso3 in co_iso3 if iso3 not in PDF_CO_ISO3)

    print("\n=== Verification vs Jan 2026 PDF org chart ===")
    if pdf_only:
        print(f"  PDF only ({len(pdf_only)}): {' '.join(pdf_only)}  ← missing from PowerBI",
              file=sys.stderr)
    if pbi_only:
        print(f"  PBI only ({len(pbi_only)}): {' '.join(pbi_only)}  ← not in PDF (new offices?)")
    if not pdf_only and not pbi_only:
        print("  CO lists match exactly.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
m49 = build_m49_lookup()

result_map: dict[str, str] = {}  # iso3 → type
unmatched: list[dict] = []

# ── 1. Country Offices ────────────────────────────────────────────────────
co_rows = query_table("CO HOO CONTACT LIST", ["COUNTRY", "OFFICE TYPE"])

for row in co_rows:
    country = row[0]
    if not country:
        continue
    if country.lower().strip() in SKIP_NAMES:
        continue

    iso3 = resolve_iso3(country, m49)
    if not iso3:
        unmatched.append({"name": country, "type": "CO"})
        continue
    result_map[iso3] = "CO"

# ── 2. Humanitarian Advisory Teams ────────────────────────────────────────
hat_rows = query_table("RO_HAT HOO CONTACT LIST", ["COUNTRY", "OFFICE TYPE"])

for row in hat_rows:
    country, office_type = row[0], row[1]
    if not country or not office_type:
        continue
    if country.lower().strip() in SKIP_NAMES:
        continue

    ot_lower = office_type.lower()
    if "humanitarian" in ot_lower:
        entry_type = "HAT"
    elif "regional" in ot_lower:
        entry_type = "RO"
    else:
        continue  # skip Liaison Offices and other types

    iso3 = resolve_iso3(country, m49)
    if not iso3:
        unmatched.append({"name": country, "type": entry_type})
        continue
    # Priority: CO > HAT > RO — don't overwrite a higher-priority entry
    existing = result_map.get(iso3)
    if existing == "CO" or (existing == "HAT" and entry_type == "RO"):
        continue
    result_map[iso3] = entry_type

# ── 3. Write CSV ──────────────────────────────────────────────────────────
sorted_entries = sorted(result_map.items())
with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.writer(f)
    writer.writerow(["iso3", "type"])
    writer.writerows(sorted_entries)

type_counts = Counter(t for _, t in sorted_entries)
print(f"\nWrote {len(sorted_entries)} rows → {OUTPUT_CSV}")
print(f"  CO:  {type_counts['CO']}")
print(f"  HAT: {type_counts['HAT']}")
print(f"  RO:  {type_counts['RO']}")

if unmatched:
    names = "\n".join(f'  "{u["name"]}" [{u["type"]}]' for u in unmatched)
    print(
        f"\nWarning: {len(unmatched)} name(s) could not be resolved to ISO3"
        f" (add to NAME_OVERRIDES):\n{names}",
        file=sys.stderr,
    )

# ── 4. Verify COs vs PDF ──────────────────────────────────────────────────
co_iso3 = {iso3 for iso3, t in sorted_entries if t == "CO"}
verify_against_pdf(co_iso3)
