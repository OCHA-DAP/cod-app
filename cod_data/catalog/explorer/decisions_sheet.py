"""Pull the team's picks from the Google Sheet at DECISIONS_SHEET_URL into decisions.csv."""

import csv
import io
import os
import re
import sys

import duckdb

from cod_data.catalog.common import CATALOG, DECISIONS_CSV
from cod_data.catalog.global_build.conform import COLUMNS as BUILD_SOURCES
from cod_data.shared.http import get

COLUMNS = ["iso3", "selected_source", "accepted", "rationale"]
KNOWN_SOURCES = set(BUILD_SOURCES) | {"none"}
ACCEPTED = {"true": "true", "false": "false", "": "false"}
M49 = CATALOG / "explorer/reference/m49/m49.parquet"
# Locations the explorer covers that M49 leaves out.
EXTRA_ISO3 = {"TWN"}


def known_iso3() -> set[str]:
    rows = duckdb.sql(
        f"""SELECT "ISO-alpha3 Code" FROM read_parquet('{M49}')"""
    ).fetchall()
    return {r[0] for r in rows} | EXTRA_ISO3


def current_iso3() -> set[str]:
    with DECISIONS_CSV.open(newline="") as f:
        return {
            r["iso3"].strip().upper() for r in csv.DictReader(f) if r["iso3"].strip()
        }


def main() -> None:
    url = os.environ.get("DECISIONS_SHEET_URL")
    if not url:
        sys.exit("Set DECISIONS_SHEET_URL in .env to the sheet's CSV export URL.")
    if not M49.exists():
        sys.exit(f"{M49} is missing; sync the catalog down from source.coop first.")
    iso3_codes = known_iso3()
    reader = csv.DictReader(io.StringIO(get(url).content.decode("utf-8")), restval="")
    header = reader.fieldnames or []
    if missing := [c for c in COLUMNS if c not in header]:
        sys.exit(f"Sheet is missing columns: {missing}")
    if repeated := [c for c in COLUMNS if header.count(c) > 1]:
        sys.exit(f"Sheet has repeated columns: {repeated}")
    rows: dict[str, list[str]] = {}
    errors = []
    for line, row in enumerate(reader, start=2):
        iso3 = row["iso3"].strip().upper()
        if not iso3:
            continue
        source = row["selected_source"].strip().lower()
        accepted = row["accepted"].strip().lower()
        if iso3 not in iso3_codes:
            errors.append(f"row {line}: unknown iso3 {iso3!r}")
        if iso3 in rows:
            errors.append(f"row {line}: duplicate iso3 {iso3}")
        if source not in KNOWN_SOURCES:
            errors.append(
                f"row {line}: source {source!r} for {iso3} isn't one of {sorted(KNOWN_SOURCES)}"
            )
        if accepted not in ACCEPTED:
            errors.append(
                f"row {line}: accepted {accepted!r} for {iso3} isn't TRUE, FALSE or blank"
            )
        rationale = re.sub(r"\s*[\r\n]+\s*", " ", row["rationale"]).strip()
        rows[iso3] = [iso3, source, ACCEPTED.get(accepted, "false"), rationale]
    if dropped := current_iso3() - rows.keys():
        errors.append(
            f"locations in {DECISIONS_CSV} missing from the sheet: {sorted(dropped)}"
        )
    if errors:
        sys.exit("Not written:\n" + "\n".join(errors))
    with DECISIONS_CSV.open("w", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(COLUMNS)
        # Sheet row order, so the explorer's dev editor can copy a block that pastes back in place.
        writer.writerows(rows.values())
    print(f"Wrote {len(rows)} rows to {DECISIONS_CSV}")


if __name__ == "__main__":
    main()
