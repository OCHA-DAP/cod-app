import { describe, expect, test } from "vitest";
import { decisions, parseDecisions } from "$lib/explorer/decisions";
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
});
