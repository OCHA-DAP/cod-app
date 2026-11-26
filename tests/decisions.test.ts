import { describe, expect, test } from "vitest";
import {
  decisions,
  getDecision,
  parseDecisions,
  pickSource,
  resetDecision,
  sheetBlock,
} from "$lib/explorer/decisions";
import { ADMIN_SOURCES } from "$lib/explorer/sources";

describe("decisions", () => {
  test("every row names a known source or none", () => {
    const ids = new Set(ADMIN_SOURCES.map((s) => s.id));
    expect(decisions.size).toBeGreaterThan(0);
    for (const d of decisions.values()) {
      expect(d.iso3).toMatch(/^[A-Z]{3}$/);
      if (d.noSourceSuitable) expect(d.selectedSource).toBeNull();
      else expect(ids).toContain(d.selectedSource);
    }
  });

  test("parses none, quoted rationale and accepted", () => {
    const parsed = parseDecisions(
      'iso3,selected_source,accepted,rationale\nabc,none,false,"a, b"\nDEF,EuroGeographics,true,x\n',
    );
    expect(parsed.get("ABC")).toEqual({
      iso3: "ABC",
      selectedSource: null,
      noSourceSuitable: true,
      accepted: false,
      rationale: "a, b",
    });
    expect(parsed.get("DEF")?.selectedSource).toBe("eurogeographics");
    expect(parsed.get("DEF")?.accepted).toBe(true);
  });

  test("a dev pick of another source starts unaccepted and copies back in sheet order", () => {
    const [iso3, original] = [...decisions].find(([, d]) => d.accepted && d.selectedSource)!;
    const other = ADMIN_SOURCES.find((s) => s.id !== original.selectedSource)!.id;
    pickSource(iso3, other);
    expect(getDecision(iso3)).toMatchObject({ selectedSource: other, accepted: false });
    const lines = sheetBlock().split("\n");
    expect(lines).toHaveLength(decisions.size);
    expect(lines[[...decisions.keys()].indexOf(iso3)].split("\t")).toEqual([
      other,
      original.rationale.includes('"') ? expect.any(String) : original.rationale,
      "FALSE",
    ]);
    resetDecision(iso3);
    expect(getDecision(iso3)).toEqual(original);
  });
});
