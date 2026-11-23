"""Pull the team's picks from the Google Sheet at DECISIONS_SHEET_URL into decisions.csv."""

import csv
import io
import os
import sys

import duckdb

from cod_data.catalog.common import BOUNDARY_SOURCES, DECISIONS_CSV, path_of
from cod_data.shared.http import get

COLUMNS = ["iso3", "selected_source", "accepted", "rationale"]
KNOWN_SOURCES = {s.name for s in BOUNDARY_SOURCES} | {"none", ""}
# Locations the explorer covers that M49 leaves out.
EXTRA_ISO3 = {"TWN"}


def known_iso3() -> set[str]:
    rows = duckdb.sql(
        f"""SELECT "ISO-alpha3 Code" FROM read_parquet('{path_of("m49")}')"""
    ).fetchall()
    return {r[0] for r in rows} | EXTRA_ISO3


def main() -> None:
    url = os.environ.get("DECISIONS_SHEET_URL")
    if not url:
        sys.exit("Set DECISIONS_SHEET_URL in .env to the sheet's CSV export URL.")
    reader = csv.DictReader(io.StringIO(get(url).content.decode("utf-8")))
    if missing := set(COLUMNS) - set(reader.fieldnames or []):
        sys.exit(f"Sheet is missing columns: {sorted(missing)}")
    iso3_codes = known_iso3()
    rows: dict[str, list[str]] = {}
    errors = []
    for line, row in enumerate(reader, start=2):
        iso3 = row["iso3"].strip().upper()
        if not iso3:
            continue
        source = row["selected_source"].strip().lower()
        if iso3 not in iso3_codes:
            errors.append(f"row {line}: unknown iso3 {iso3!r}")
        if iso3 in rows:
            errors.append(f"row {line}: duplicate iso3 {iso3}")
        if source not in KNOWN_SOURCES:
            errors.append(f"row {line}: unknown source {source!r} for {iso3}")
        accepted = "true" if row["accepted"].strip().lower() == "true" else "false"
        rows[iso3] = [iso3, source, accepted, row["rationale"].strip()]
    if errors:
        sys.exit("Not written:\n" + "\n".join(errors))
    with DECISIONS_CSV.open("w", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(COLUMNS)
        writer.writerows(rows[k] for k in sorted(rows))
    print(f"Wrote {len(rows)} rows to {DECISIONS_CSV}")


if __name__ == "__main__":
    main()
