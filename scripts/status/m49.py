import csv
import re
import sys
from pathlib import Path

from shared import http

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "m49.csv"

URL = "https://unstats.un.org/unsd/methodology/m49/overview/"
TABLE_ID = "downloadTableEN"

print(f"Fetching {URL} ...")
res = http.get(URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
html = res.text

# Extract the target table's HTML
table_re = re.compile(
    rf'<table[^>]*id\s*=\s*"{TABLE_ID}"[^>]*>([\s\S]*?)</table>', re.IGNORECASE
)
table_match = table_re.search(html)
if not table_match:
    print(f"Error: Table #{TABLE_ID} not found in page", file=sys.stderr)
    sys.exit(1)
table_html = table_match.group(0)


def decode_cell(raw: str) -> str:
    text = re.sub(r"<[^>]+>", "", raw)
    text = text.replace("&amp;", "&")
    text = text.replace("&lt;", "<")
    text = text.replace("&gt;", ">")
    text = text.replace("&nbsp;", " ")
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    return text.strip()


rows = []
for row_match in re.finditer(r"<tr[\s>]([\s\S]*?)</tr>", table_html, re.IGNORECASE):
    cells = [
        decode_cell(cell_match.group(1))
        for cell_match in re.finditer(
            r"<t[dh][\s>]([\s\S]*?)</t[dh]>", row_match.group(1), re.IGNORECASE
        )
    ]
    if cells:
        rows.append(cells)

if len(rows) < 2:
    print(f"Error: Only {len(rows)} rows parsed — check the HTML structure", file=sys.stderr)
    sys.exit(1)

# Convert header row to snake_case
rows[0] = [
    re.sub(r"^_|_$", "", re.sub(r"[^a-z0-9]+", "_", h.lower())) for h in rows[0]
]

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.writer(f)
    writer.writerows(rows)

print(f"Wrote {len(rows) - 1} rows → {OUTPUT}")
