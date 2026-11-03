import base64
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
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

OUTPUT_DIR = Path(__file__).parents[2] / "public" / "status" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "work.csv"

BASE_URL = "https://humanitarian.atlassian.net"
JQL = "parent = COD-51"
FIELDS = "summary,status,labels,description"

email = os.environ.get("JIRA_EMAIL")
token = os.environ.get("JIRA_API_TOKEN")

if not email or not token:
    print(
        "Error: JIRA_EMAIL and JIRA_API_TOKEN must be set in .env or environment",
        file=sys.stderr,
    )
    sys.exit(1)

auth = base64.b64encode(f"{email}:{token}".encode()).decode()
HEADERS = {"Authorization": f"Basic {auth}", "Accept": "application/json"}

STATUS_MAP = {
    "Backlog": "backlog",
    "Selected for Development": "selected",
    "In Progress": "in_progress",
    "Blocked": "blocked",
    "Done": "done",
    "Cancelled": "cancelled",
}

LABEL_RE = re.compile(r"^([a-z_]+):(.+)$")
YEAR_RE = re.compile(r"^\d{4}$")
QUARTER_RE = re.compile(r"^\d{4}-Q[1-4]$")
UPDATE_RE = re.compile(r"^(major|minor)$")

DESCRIPTION_KEYS = {
    "Created:": "creation_date",
    "Publication date:": "publication_date",
}


def fetch_issues() -> list[dict]:
    issues: list[dict] = []
    next_token: str | None = None
    while True:
        params = {"jql": JQL, "fields": FIELDS, "maxResults": 100}
        if next_token:
            params["nextPageToken"] = next_token
        res = http.get(
            f"{BASE_URL}/rest/api/3/search/jql",
            params=params,
            headers=HEADERS,
            timeout=30,
        )
        data = res.json()
        issues.extend(data.get("issues", []))
        next_token = data.get("nextPageToken")
        if not next_token or data.get("isLast"):
            break
    return issues


def parse_labels(labels: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for label in labels:
        m = LABEL_RE.match(label)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def parse_description_dates(adf: dict | None) -> dict[str, str]:
    """Walk ADF JSON, pull '<bold prefix>: <value>' pairs from bullet items
    or from manually bullet-marked paragraph lines (split on hardBreak)."""
    out: dict[str, str] = {}
    if not adf:
        return out

    def process_texts(texts: list[str]) -> None:
        for i, text in enumerate(texts):
            key = text.strip()
            if key in DESCRIPTION_KEYS and i + 1 < len(texts):
                value = texts[i + 1].strip()
                if value == "—":
                    value = ""
                out[DESCRIPTION_KEYS[key]] = value

    for node in adf.get("content", []):
        if node.get("type") == "bulletList":
            for item in node.get("content", []):
                for para in item.get("content", []):
                    texts = [
                        t.get("text", "")
                        for t in para.get("content", [])
                        if t.get("type") == "text"
                    ]
                    process_texts(texts)
        elif node.get("type") == "paragraph":
            line: list[str] = []
            for child in node.get("content", []):
                if child.get("type") == "hardBreak":
                    process_texts(line)
                    line = []
                elif child.get("type") == "text":
                    line.append(child.get("text", ""))
            process_texts(line)
    return out


def issue_to_row(issue: dict) -> dict | None:
    fields = issue["fields"]
    summary = fields.get("summary", "")
    jira_status = fields.get("status", {}).get("name", "")

    if jira_status not in STATUS_MAP:
        print(
            f"Skipping {issue['key']}: unknown status '{jira_status}'", file=sys.stderr
        )
        return None

    labels = parse_labels(fields.get("labels", []))
    year = labels.get("year", "")
    quarter = labels.get("quarter", "")
    update_type = labels.get("update", "")

    if not YEAR_RE.match(year):
        print(f"Skipping {issue['key']}: missing/invalid year label '{year}'", file=sys.stderr)
        return None
    # update_type is unset for backlog items (work not yet scoped); required otherwise
    if jira_status != "Backlog" and not UPDATE_RE.match(update_type):
        print(
            f"Skipping {issue['key']}: missing/invalid update label '{update_type}'",
            file=sys.stderr,
        )
        return None
    if quarter and not QUARTER_RE.match(quarter):
        print(
            f"Skipping {issue['key']}: invalid quarter label '{quarter}'", file=sys.stderr
        )
        return None

    if "_" not in summary:
        print(
            f"Skipping {issue['key']}: summary '{summary}' missing iso3 prefix",
            file=sys.stderr,
        )
        return None

    dates = parse_description_dates(fields.get("description"))

    return {
        "iso3": summary.split("_")[0],
        "year": year,
        "id": summary,
        "update_type": update_type,
        "creation_date": dates.get("creation_date", ""),
        "status": STATUS_MAP[jira_status],
        "planned_quarter": quarter,
        "publication_date": dates.get("publication_date", ""),
    }


issues = fetch_issues()
print(f"{len(issues)} issues fetched from JIRA")

rows = [r for r in (issue_to_row(i) for i in issues) if r is not None]
rows.sort(key=lambda r: (r["iso3"], r["year"], r["id"]))

columns = [
    "iso3",
    "year",
    "id",
    "update_type",
    "creation_date",
    "status",
    "planned_quarter",
    "publication_date",
]

with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)

print(f"Written {len(rows)} work orders to {OUTPUT}")
