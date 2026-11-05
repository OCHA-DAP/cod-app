export interface GlossaryEntry {
  label: string;
  definition: string;
}

export const GLOSSARY = {
  "cod-ab": {
    label: "COD-AB",
    definition:
      "Common Operational Dataset for Administrative Boundaries: the shared reference layer, maintained by OCHA, for a country's admin subdivisions (country, province, district and so on), used across humanitarian response.",
  },
  cod: {
    label: "COD",
    definition:
      "Common Operational Datasets: shared reference data that humanitarian responders use to coordinate in an emergency.",
  },
  hdx: {
    label: "HDX",
    definition: "Humanitarian Data Exchange: OCHA's open platform for sharing humanitarian data.",
  },
  iso3: {
    label: "ISO3",
    definition: "ISO 3166-1 alpha-3 three-letter country code (e.g. SYR = Syrian Arab Republic).",
  },
  m49: {
    label: "M49",
    definition:
      "UN Statistics Division standard codes for countries and regions; used here to align country lists across data sources.",
  },
  "p-code": {
    label: "P-code",
    definition:
      "Place code: the unique identifier of an administrative unit, such as AFG.001.012. Every code starts with the code of the unit above it.",
  },
  "admin-level": {
    label: "Admin level",
    definition:
      "A tier in a country's hierarchy of subdivisions. Admin 0 is the country, admin 1 its largest subdivisions (such as provinces), and each level below divides the one above.",
  },
  "edge-matching": {
    label: "Edge matching",
    definition:
      "Aligning a country's outer boundary with the UN admin 0 layer, so neighbouring countries meet without gaps or overlaps.",
  },
  imwg: {
    label: "IMWG",
    definition:
      "Information Management Working Group: the in-country group of agencies that coordinates information management and accepts CODs.",
  },
  "cod-ab-wg": {
    label: "COD-AB WG",
    definition:
      "COD-AB Working Group: the agencies that manage COD-AB together (OCHA, WFP, UNICEF, UNHCR and IOM).",
  },
  arcgis: {
    label: "ArcGIS",
    definition: "Esri's GIS platform where OCHA publishes the COD-AB catalog of admin boundaries.",
  },

  hrp: {
    label: "HRP",
    definition: "Humanitarian Response Plan: a coordinated humanitarian appeal for one country.",
  },
  hnrp: {
    label: "HNRP",
    definition:
      "Humanitarian Needs and Response Plan: one document that covers both the needs overview (HNO) and the response plan (HRP).",
  },
  fa: {
    label: "Flash Appeal",
    definition: "Flash Appeal: a short-term emergency appeal for a sudden-onset crisis.",
  },
  reg: {
    label: "Regional Plan",
    definition:
      "Regional Refugee Response Plan: a plan across several countries for refugees fleeing the same crisis.",
  },
  "current-other": {
    label: "Other Plans (Current)",
    definition:
      "Locations with an active plan in the current cycle that is not an HNRP, HRP, or Flash Appeal, usually a Regional Response Plan (REG) or another lower-priority type (CAP, SRP, CIAA, Other).",
  },
  "prior-other": {
    label: "Other Plans (Prior Years)",
    definition:
      "Locations with no plan in the current cycle whose most recent prior plan was not an HNRP, HRP, or Flash Appeal.",
  },
  "no-plans": {
    label: "No Plans",
    definition: "Locations with no active humanitarian plan in the current or recent cycles.",
  },

  co: {
    label: "CO",
    definition: "Country Office: an OCHA office in one country.",
  },
  hat: {
    label: "HAT",
    definition:
      "Humanitarian Advisory Team: a smaller OCHA presence that advises on humanitarian coordination, usually based in a UN Resident Coordinator's office.",
  },
  ro: {
    label: "RO",
    definition: "Regional Office: an OCHA office covering several countries in a region.",
  },
  "office-type": {
    label: "Office Type",
    definition:
      "Whether the location is served by a Country Office (CO), Humanitarian Advisory Team (HAT), or Regional Office (RO).",
  },
  "regional-office": {
    label: "Regional Office",
    definition: "The OCHA regional office responsible for the location.",
  },

  "work-order": {
    label: "Work Order",
    definition: "A tracked task to update or create a country's COD-AB dataset.",
  },
  pipeline: {
    label: "Pipeline",
    definition:
      "The sequence of statuses a work order passes through, from Backlog to Done.",
  },
  selected: {
    label: "Selected for Development",
    definition: "Work order has been opened and is queued for work.",
  },
  "planned-quarter": {
    label: "Planned Quarter",
    definition: "The quarter (Q1–Q4) in which the work order is targeted to complete.",
  },
  "open-for": {
    label: "Open For",
    definition: "How long the work order has been in progress since it was created.",
  },
  "major-minor": {
    label: "Major / Minor",
    definition:
      "Whether the update is substantive (Major, ●), such as a real change to boundaries or codes, or cosmetic (Minor, ○), such as a metadata or formatting correction.",
  },
  "plan-type": {
    label: "Plan Type",
    definition:
      "Type of humanitarian plan active for the location: HRP (Humanitarian Response Plan), HNRP (Humanitarian Needs and Response Plan), FA (Flash Appeal), or REG (Regional Refugee Response Plan).",
  },

  "status-backlog": {
    label: "Backlog",
    definition:
      "Location is expected to need a boundary update this cycle, but no work order has been opened yet.",
  },
  "status-selected": {
    label: "Selected for Development",
    definition: "Work order has been opened and is queued; work has not begun yet.",
  },
  "status-in_progress": {
    label: "In Progress",
    definition: "Work is actively underway on the boundaries.",
  },
  "status-blocked": {
    label: "Blocked",
    definition: "Work is paused awaiting feedback or unblocking from stakeholders.",
  },
  "status-done": {
    label: "Done",
    definition: "Boundaries have been finalized and are available in the ArcGIS catalog.",
  },
  "status-cancelled": {
    label: "Cancelled",
    definition: "Work order has been cancelled and will not be completed.",
  },

  "next-review": {
    label: "Next Review",
    definition:
      "Date the next data review or update is due, computed from COD metadata and update frequency.",
  },
  "ps-age": {
    label: "Age",
    definition: "Years between the COD-PS reference year and the current year.",
  },
  "reference-year": {
    label: "Reference Year",
    definition:
      "Blue: year the current COD-AB boundaries are valid from. Orange: year the COD-PS figures refer to, from the global COD-PS tables, or from the location's own HDX dataset when it is newer.",
  },
  "ab-levels": {
    label: "COD-AB levels",
    definition:
      "One cell per admin level. A solid cell covers the whole country or territory. A pale cell is a partial level, filled to the share of parent units it subdivides when known.",
  },
  "ps-levels": {
    label: "COD-PS levels",
    definition:
      "One cell per admin level with population figures. The orange share of each cell is the P-codes found in the current COD-AB, and red marks P-codes that won't join to the boundaries.",
  },
  "plan-coverage": {
    label: "Plan Coverage",
    definition: "Locations covered by HRP or Flash Appeal plans in a given year.",
  },
  "current-hrp": {
    label: "HNRP / HRP (Current)",
    definition:
      "Locations with an active Humanitarian Needs and Response Plan (HNRP) or Humanitarian Response Plan (HRP) in the current cycle. These are the priority group for boundary readiness.",
  },
  "current-fa": {
    label: "Flash Appeals (Current)",
    definition:
      "Locations with an active Flash Appeal (FA) in the current cycle and no HNRP or HRP.",
  },
  "prior-hrp": {
    label: "HNRP / HRP (Prior Years)",
    definition:
      "Locations with no plan in the current cycle that have had an HNRP or HRP in a prior year.",
  },
  "prior-fa": {
    label: "Flash Appeals (Prior Years)",
    definition:
      "Locations with no plan in the current cycle whose highest-ranked prior plan was a Flash Appeal.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermSlug = keyof typeof GLOSSARY;
