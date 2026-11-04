#!/usr/bin/env python3
"""Download the UN M49 country/area codes from unstats.un.org."""

import html.parser

from common import csv_to_parquet, path_of
from shared import http

URL = "https://unstats.un.org/unsd/methodology/m49/overview/"
TABLE_ID = "downloadTableEN"
OUT_PARQUET = path_of("m49")


class TableParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.target = False
        self.nested = 0
        self.in_cell = False
        self.rows, self.row, self.cell = [], [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            if attrs.get("id") == TABLE_ID:
                self.target = True
            elif self.target:
                self.nested += 1
        if not self.target or self.nested:
            return
        if tag == "tr":
            self.row = []
        elif tag in ("th", "td"):
            self.in_cell, self.cell = True, []

    def handle_endtag(self, tag):
        if tag == "table" and self.target:
            if self.nested:
                self.nested -= 1
            else:
                self.target = False
        if not self.target or self.nested:
            return
        if tag == "tr" and self.row:
            self.rows.append(self.row)
        elif tag in ("th", "td") and self.in_cell:
            self.in_cell = False
            self.row.append("".join(self.cell).strip())

    def handle_data(self, data):
        if self.in_cell:
            self.cell.append(data)


content = http.get(URL, headers={"User-Agent": "Mozilla/5.0"}).text

parser = TableParser()
parser.feed(content)

csv_to_parquet(parser.rows, OUT_PARQUET)
print(f"Wrote {len(parser.rows) - 1} rows → {OUT_PARQUET}")
