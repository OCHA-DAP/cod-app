import { readFileSync } from "node:fs";
import { join } from "node:path";

import Papa from "papaparse";

import { isOpenStatus, statusRank } from "./status";

export interface WorkOrderRow {
  iso3: string;
  name_en: string;
  year: string;
  work_order_id: string;
  work_order_status: string;
  plan_type: string;
  office_type: string;
  planned_quarter: string;
  created_date: string;
  publication_date: string;
  regional: string;
  update_type: string;
  hdxUrl?: string;
}

export interface ScheduleGroup {
  quarter: string;
  rows: WorkOrderRow[];
}

export interface PlanCoverageRow {
  iso3: string;
  name_en: string;
  plan_types: string;
  work_order_status: string;
  planned_quarter: string;
  regional: string;
  hdxUrl?: string;
}

export interface PlanCoverageYear {
  year: string;
  rows: PlanCoverageRow[];
}

export interface PlanCountry {
  iso3: string;
  name_en: string;
  regional: string;
  office_type: string;
  plan_types: string[];
  inGis: boolean;
  plan_years?: string[];
  next_review_date?: string;
  next_review_sort?: string;
  next_review_relative?: string;
  review_overdue?: boolean;
  open_work_order_status?: string;
  hdxUrl?: string;
  ps_reference_year?: number;
  ps_age?: string;
  /** joined: every COD-PS P-code is in the COD-AB; unset: no subnational COD-PS P-codes. */
  ps_match?: "joined" | "mismatched";
}

export interface LevelStats {
  level: number;
  ab_units?: number;
  /** Share of parent units with children at this level; below 100 means partial. */
  ab_share?: number;
  ps_units?: number;
  matched?: number;
  /** Share of PS parent units with children at this level; below 100 means partial. */
  ps_share?: number;
}

export interface InfoRow {
  iso3: string;
  name_en: string;
  ab_reference_year?: number;
  ab_level?: number;
  /** Deepest COD-AB level covering the whole country; levels below it up to ab_level are partial. */
  ab_level_full?: number;
  hdxUrl?: string;
  ps_reference_year?: number;
  ps_level?: number;
  levels: LevelStats[];
  psUrl?: string;
}

export interface PlanGroup {
  key: "current-priority" | "prior-priority" | "current-other" | "prior-other" | "no-plans";
  label: string;
  countries: PlanCountry[];
}

function parseCsv(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  }).data;
}

function woPlanTypeRank(s: string): number {
  if (!s) return 5;
  const lower = s.toLowerCase();
  if (lower.includes("hnrp")) return 0;
  if (lower.includes("hrp")) return 1;
  if (lower.includes("fa")) return 2;
  if (lower.includes("reg")) return 3;
  return 4;
}

function woOfficeTypeRank(s: string): number {
  if (s === "CO") return 0;
  if (s === "HAT") return 1;
  if (s === "RO") return 2;
  return 3;
}

// For picking one row per country: active work always wins, but otherwise a
// completed order should represent the country over a queued backlog ticket
// or an abandoned one — unlike statusRank (used for in-queue urgency
// ordering), a shipped Done shouldn't be shadowed by a not-yet-started
// Backlog for the same country.
function countryDedupRank(status: string): number {
  if (status === "blocked") return 0;
  if (status === "in_progress") return 1;
  if (status === "selected") return 2;
  if (status === "done") return 3;
  if (status === "backlog") return 4;
  if (status === "cancelled") return 5;
  return 6;
}

// Country's best-ever plan type outranks a lesser plan type from a more
// recent year (mirrors scripts/catalog/explorer/plan_status.py's rank).
function planTypeRank(t: string): number {
  const upper = t.toUpperCase();
  if (upper === "HNRP") return 0;
  if (upper === "HRP") return 1;
  if (upper === "FA") return 2;
  if (upper === "REG") return 3;
  return 4;
}

// Best (lowest-ranked) plan type across a country's plan years, tie-broken
// by the most recent year achieving that rank. Pass excludeYear to search
// prior years only.
function bestPlanType(
  byYear: Map<string, Set<string>>,
  excludeYear?: string,
): { rank: number; year: string; types: string[] } {
  let bestRank = Infinity;
  let bestYear = "";
  for (const [year, types] of byYear) {
    if (year === excludeYear) continue;
    for (const t of types) {
      const rank = planTypeRank(t);
      if (rank < bestRank || (rank === bestRank && year > bestYear)) {
        bestRank = rank;
        bestYear = year;
      }
    }
  }
  const types = bestYear
    ? [...(byYear.get(bestYear) ?? [])].filter((t) => planTypeRank(t) === bestRank)
    : [];
  return { rank: bestRank, year: bestYear, types };
}

function computeNextReview(
  anchorDate: string,
  freq: number,
): {
  next_review_date: string;
  next_review_sort: string;
  next_review_relative: string;
  review_overdue: boolean;
} {
  const d = new Date(anchorDate + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + freq);
  const now = new Date();
  const overdue = d < now;
  const diffMs = overdue ? now.getTime() - d.getTime() : d.getTime() - now.getTime();
  const diffMonths = Math.round(diffMs / (1000 * 60 * 60 * 24 * 30.44));
  const relative =
    diffMonths === 0
      ? "This month"
      : overdue
        ? `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`
        : `In ${diffMonths} month${diffMonths === 1 ? "" : "s"}`;
  return {
    next_review_date: d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }),
    next_review_sort: d.toISOString().slice(0, 10),
    next_review_relative: relative,
    review_overdue: overdue,
  };
}

const UNSCHEDULED = "Unscheduled";

function currentQuarter(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

function groupByQuarter(rows: WorkOrderRow[]): ScheduleGroup[] {
  const map: Record<string, WorkOrderRow[]> = {};
  for (const r of rows) {
    const key = r.planned_quarter || UNSCHEDULED;
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  const current = currentQuarter();
  // Current and future quarters, then unscheduled, then past quarters newest first.
  const rank = (q: string) => (q === UNSCHEDULED ? 1 : q >= current ? 0 : 2);
  return Object.entries(map)
    .sort(
      ([a], [b]) => rank(a) - rank(b) || (rank(a) === 2 ? b.localeCompare(a) : a.localeCompare(b)),
    )
    .map(([quarter, rows]) => ({ quarter, rows }));
}

export function loadData() {
  const dataDir = join(process.cwd(), "public/status/data");
  const [workText, m49Text, planText, officesText, officeTypesText] = [
    "work.csv",
    "m49.csv",
    "plans.csv",
    "regions.csv",
    "offices.csv",
  ].map((f) => readFileSync(join(dataDir, f), "utf-8"));

  let lastUpdatedAt: string | null = null;
  try {
    lastUpdatedAt = readFileSync(join(dataDir, "last_updated.txt"), "utf-8").trim();
  } catch {
    // file won't exist until npm run fetch:status has been run
  }

  const m49 = parseCsv(m49Text);
  const plans = parseCsv(planText);
  const workOrderRows = parseCsv(workText);
  const offices = parseCsv(officesText);
  const officeTypes = parseCsv(officeTypesText);

  const m49ByIso3 = Object.fromEntries(
    m49.map((r) => [r.iso_alpha3_code, { ...r, name_en: r.country_or_area }]),
  );
  const officeByIso3 = Object.fromEntries(offices.map((r) => [r.iso3, r]));
  const officeTypeByIso3 = Object.fromEntries(officeTypes.map((r) => [r.iso3, r.type]));

  // Load HDX dataset presence list (may not exist until npm run fetch:status has been run)
  const hdxIso3 = new Set<string>();
  try {
    const hdxText = readFileSync(join(dataDir, "hdx.csv"), "utf-8");
    for (const r of parseCsv(hdxText)) if (r.iso3) hdxIso3.add(r.iso3);
  } catch {
    // file won't exist until npm run fetch:status has been run
  }

  const hdxDatasetUrl = (dataset: "cod-ab" | "cod-ps", iso3: string) =>
    `https://data.humdata.org/dataset/${dataset}-${iso3.toLowerCase()}`;

  function getHdxUrl(iso3: string): string | undefined {
    return hdxIso3.has(iso3) ? hdxDatasetUrl("cod-ab", iso3) : undefined;
  }

  // Plans grouped by year → iso3 (HRP and FA only, for plan coverage table)
  const coveragePlanTypes = new Set(["HRP", "HNRP", "FA"]);
  const plansByYear: Record<string, Record<string, { types: string[] }>> = {};
  for (const p of plans) {
    if (!coveragePlanTypes.has(p.type)) continue;
    if (!plansByYear[p.year]) plansByYear[p.year] = {};
    const byIso3 = plansByYear[p.year];
    if (!byIso3[p.iso3]) {
      byIso3[p.iso3] = { types: [p.type] };
    } else {
      if (!byIso3[p.iso3].types.includes(p.type)) byIso3[p.iso3].types.push(p.type);
    }
  }

  // Most recent work order per iso3+year pair (for plan coverage matching)
  const latestWorkByIso3Year: Record<string, Record<string, string>> = {};
  for (const wo of workOrderRows) {
    const key = `${wo.iso3}:${wo.year}`;
    const cur = latestWorkByIso3Year[key];
    if (!cur || wo.creation_date > cur.creation_date) latestWorkByIso3Year[key] = wo;
  }

  function buildRow(wo: Record<string, string>): WorkOrderRow {
    const geo = m49ByIso3[wo.iso3] ?? {};
    const office = officeByIso3[wo.iso3] ?? {};
    const planTypes: string[] = [];
    for (const [year, byIso3] of Object.entries(plansByYear)) {
      if (year < wo.year) continue;
      const plan = byIso3[wo.iso3];
      if (!plan) continue;
      for (const t of plan.types) if (!planTypes.includes(t)) planTypes.push(t);
    }
    return {
      iso3: wo.iso3,
      name_en: geo.name_en ?? wo.iso3,
      year: wo.year,
      work_order_id: wo.id ?? "",
      work_order_status: wo.status ?? "",
      plan_type: planTypes.map((t) => t.toUpperCase()).join(" / "),
      office_type: officeTypeByIso3[wo.iso3] ?? "",
      planned_quarter: wo.planned_quarter ?? "",
      created_date: wo.creation_date ?? "",
      publication_date: wo.publication_date ?? "",
      regional: office.regional ?? "",
      update_type: wo.update_type ?? "",
      hdxUrl: getHdxUrl(wo.iso3),
    };
  }

  const allRows = workOrderRows.map(buildRow);

  // Most active open (non-done) work order status per iso3
  const openWoByIso3: Record<string, string> = {};
  for (const row of allRows) {
    if (row.work_order_status === "done") continue;
    const existing = openWoByIso3[row.iso3];
    if (!existing || statusRank(row.work_order_status) < statusRank(existing)) {
      openWoByIso3[row.iso3] = row.work_order_status;
    }
  }

  // One row per country: a country can accrue multiple work orders across
  // years (e.g. a cancelled request followed by a new one, or a completed
  // minor fix alongside a still-queued backlog ticket), so keep only the
  // most representative status (countryDedupRank), tie-broken by the most
  // recent date — otherwise a newer-but-cancelled order could shadow an
  // older order that actually finished and published.
  const rowsByIso3 = new Map<string, WorkOrderRow[]>();
  for (const r of allRows) {
    if (!rowsByIso3.has(r.iso3)) rowsByIso3.set(r.iso3, []);
    rowsByIso3.get(r.iso3)!.push(r);
  }
  const dedupedRows = [...rowsByIso3.values()].map((rows) =>
    rows.reduce((best, r) => {
      const rRank = countryDedupRank(r.work_order_status);
      const bestRank = countryDedupRank(best.work_order_status);
      if (rRank !== bestRank) return rRank < bestRank ? r : best;
      const rDate = r.publication_date || r.created_date || "";
      const bestDate = best.publication_date || best.created_date || "";
      return rDate > bestDate ? r : best;
    }),
  );

  // All work orders, one per country, grouped by planned quarter (quarter
  // values are year-prefixed, e.g. "2026-Q1", so chronological order holds)
  const workOrders = [...dedupedRows].sort(
    (a, b) =>
      statusRank(a.work_order_status) - statusRank(b.work_order_status) ||
      woPlanTypeRank(a.plan_type) - woPlanTypeRank(b.plan_type) ||
      woOfficeTypeRank(a.office_type) - woOfficeTypeRank(b.office_type) ||
      (a.publication_date || a.created_date || "").localeCompare(
        b.publication_date || b.created_date || "",
      ),
  );
  const workByQuarter = groupByQuarter(workOrders);

  // Plan coverage per year (newest first)
  const planCoverageByYear: PlanCoverageYear[] = Object.entries(plansByYear)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, byIso3]) => {
      const rows: PlanCoverageRow[] = Object.entries(byIso3)
        .map(([iso3, plan]) => {
          const geo = m49ByIso3[iso3] ?? {};
          const office = officeByIso3[iso3] ?? {};
          const wo = latestWorkByIso3Year[`${iso3}:${year}`];
          return {
            iso3,
            name_en: geo.name_en ?? iso3,
            plan_types: plan.types.map((t) => t.toUpperCase()).join(" / "),
            work_order_status: wo?.status ?? "",
            planned_quarter: wo?.planned_quarter ?? "",
            regional: office.regional ?? "",
            hdxUrl: getHdxUrl(iso3),
          };
        })
        .sort((a, b) => {
          const typeRank = (t: string) => (t === "hrp" ? 0 : t.includes("hrp") ? 1 : 2);
          const tComp = typeRank(a.plan_types) - typeRank(b.plan_types);
          return tComp !== 0
            ? tComp
            : statusRank(a.work_order_status) - statusRank(b.work_order_status);
        });
      return {
        year,
        rows,
      };
    });

  // Load gis.unocha.org catalog country list
  const gisText = readFileSync(join(dataDir, "gis.csv"), "utf-8");
  const gisIso3 = new Set(parseCsv(gisText).map((r) => r.iso3));

  // Load COD Global Metadata (may not exist until npm run fetch:status has been run)
  const optionalNumber = (v: string | undefined) => (v ? Number(v) : undefined);
  const codMetaByIso3: Record<string, { anchor_date: string; update_frequency: number }> = {};
  const unitsByIso3: Record<
    string,
    { date: string; units: number; level?: number; full?: number; validYear?: number }
  > = {};
  try {
    const codMetaText = readFileSync(join(dataDir, "cod_metadata.csv"), "utf-8");
    for (const r of parseCsv(codMetaText)) {
      const date = r.date_updated ?? "";
      if (
        r.country_iso3 &&
        (!unitsByIso3[r.country_iso3] || date > unitsByIso3[r.country_iso3].date)
      ) {
        const units = [1, 2, 3, 4, 5].reduce(
          (sum, l) => sum + (Number(r[`admin_${l}_count`]) || 0),
          0,
        );
        unitsByIso3[r.country_iso3] = {
          date,
          units,
          level: optionalNumber(r.admin_level_max),
          full: optionalNumber(r.admin_level_full),
          validYear: optionalNumber(r.date_valid_on?.slice(0, 4)),
        };
      }
      if (!r.country_iso3 || !r.update_frequency) continue;
      const anchor = [r.date_reviewed, r.date_updated, r.date_valid_on]
        .filter(Boolean)
        .sort()
        .at(-1);
      if (!anchor) continue;
      const existing = codMetaByIso3[r.country_iso3];
      if (!existing || anchor > existing.anchor_date) {
        codMetaByIso3[r.country_iso3] = {
          anchor_date: anchor,
          update_frequency: Number(r.update_frequency),
        };
      }
    }
  } catch {
    // file won't exist until npm run fetch:status has been run
  }

  // COD-PS summary (may not exist until npm run fetch:status has been run)
  const psByIso3: Record<string, Record<string, string>> = {};
  try {
    const psText = readFileSync(join(dataDir, "cod_ps.csv"), "utf-8");
    for (const r of parseCsv(psText)) if (r.iso3) psByIso3[r.iso3] = r;
  } catch {
    // file won't exist until npm run fetch:status has been run
  }

  const levelsByIso3: Record<string, LevelStats[]> = {};
  try {
    const text = readFileSync(join(dataDir, "levels.csv"), "utf-8");
    for (const r of parseCsv(text))
      (levelsByIso3[r.iso3] ??= []).push({
        level: Number(r.level),
        ab_units: optionalNumber(r.ab_units),
        ab_share: optionalNumber(r.ab_share),
        ps_units: optionalNumber(r.ps_units),
        ps_share: optionalNumber(r.ps_share),
        matched: optionalNumber(r.matched),
      });
  } catch {
    // file won't exist until npm run fetch:status has been run
  }

  const infoRows: InfoRow[] = [...gisIso3]
    .filter(Boolean)
    .map((iso3) => {
      const ps = psByIso3[iso3];
      return {
        iso3,
        name_en: m49ByIso3[iso3]?.name_en ?? iso3,
        ab_reference_year: unitsByIso3[iso3]?.validYear,
        ab_level: unitsByIso3[iso3]?.level,
        ab_level_full: unitsByIso3[iso3]?.full,
        hdxUrl: getHdxUrl(iso3),
        ps_reference_year: optionalNumber(ps?.reference_year),
        ps_level: optionalNumber(ps?.admin_level),
        levels: levelsByIso3[iso3] ?? [],
        psUrl: ps?.on_hdx === "true" ? hdxDatasetUrl("cod-ps", iso3) : undefined,
      };
    })
    .sort((a, b) => a.name_en.localeCompare(b.name_en));

  const currentYear = new Date().getUTCFullYear();
  function getCountryExtras(iso3: string): Partial<PlanCountry> {
    const meta = codMetaByIso3[iso3];
    const reviewFields = meta ? computeNextReview(meta.anchor_date, meta.update_frequency) : {};
    const woStatus = openWoByIso3[iso3];
    const psYear = optionalNumber(psByIso3[iso3]?.reference_year);
    const psAge = psYear === undefined ? undefined : currentYear - psYear;
    const psLevels = (levelsByIso3[iso3] ?? []).filter((l) => l.ps_units !== undefined);
    return {
      ...reviewFields,
      ...(woStatus && { open_work_order_status: woStatus }),
      ps_reference_year: psYear,
      ps_age:
        psAge === undefined
          ? undefined
          : psAge <= 0
            ? "Current"
            : `${psAge} year${psAge === 1 ? "" : "s"}`,
      ps_match:
        psLevels.length === 0
          ? undefined
          : psLevels.every((l) => l.matched === l.ps_units)
            ? "joined"
            : "mismatched",
    };
  }

  // Build plan groups from the plans data
  const latestPlanYear = [...new Set(plans.map((p) => p.year))].sort().at(-1) ?? "";

  // iso3 → year → unique types[]
  const plansByIso3 = new Map<string, Map<string, Set<string>>>();
  for (const p of plans) {
    if (!plansByIso3.has(p.iso3)) plansByIso3.set(p.iso3, new Map());
    const byYear = plansByIso3.get(p.iso3)!;
    if (!byYear.has(p.year)) byYear.set(p.year, new Set());
    byYear.get(p.year)!.add(p.type);
  }

  const priorityTypes = new Set(["HRP", "HNRP", "FA"]);

  const currentPriority: PlanCountry[] = [];
  const currentOther: PlanCountry[] = [];
  const priorPriority: PlanCountry[] = [];
  const priorOther: PlanCountry[] = [];

  for (const [iso3, byYear] of plansByIso3) {
    const geo = m49ByIso3[iso3] ?? {};
    const office = officeByIso3[iso3] ?? {};
    const currentTypes = [...(byYear.get(latestPlanYear) ?? [])];

    let bucket: PlanCountry[];
    let planTypes: string[];
    let planYears: string[];
    if (currentTypes.length > 0) {
      // An active plan this cycle takes priority over stale plan history,
      // regardless of type — a country working on a current REG/Other plan
      // is more relevant than one whose only priority plan is years old.
      const hasPriority = currentTypes.some((t) => priorityTypes.has(t));
      if (hasPriority) {
        // Also surface the most recent prior year's plan type(s), if they
        // differ from the current one, for context on how the country's
        // plan classification has changed over time.
        const priorYears = [...byYear.keys()].filter((y) => y !== latestPlanYear).sort();
        const mostRecentPriorYear = priorYears.at(-1);
        const priorTypes = mostRecentPriorYear
          ? [...(byYear.get(mostRecentPriorYear) ?? [])].filter((t) => !currentTypes.includes(t))
          : [];
        bucket = currentPriority;
        planTypes = [...currentTypes, ...priorTypes];
        planYears = [
          ...currentTypes.map(() => latestPlanYear),
          ...priorTypes.map(() => mostRecentPriorYear!),
        ];
      } else {
        // Surface a genuinely better historical plan type alongside the
        // current one (e.g. "Other / HRP"), so an old HNRP/HRP/FA isn't
        // hidden just because this cycle's plan is a lesser type.
        const currentBestRank = Math.min(...currentTypes.map(planTypeRank));
        const prior = bestPlanType(byYear, latestPlanYear);
        const hasBetterPrior = prior.year !== "" && prior.rank < currentBestRank;
        const priorTypes = hasBetterPrior ? prior.types : [];
        bucket = currentOther;
        planTypes = [...currentTypes, ...priorTypes];
        planYears = [
          ...currentTypes.map(() => latestPlanYear),
          ...priorTypes.map(() => prior.year),
        ];
      }
    } else {
      // No plan this cycle — fall back to the best-ever plan type across
      // prior years, tie-broken by the most recent year achieving it, so a
      // country's old HNRP/HRP/FA still outranks another country's old
      // REG/Other (mirrors scripts/catalog/explorer/plan_status.py's).
      const best = bestPlanType(byYear);
      const hasPriority = best.types.some((t) => priorityTypes.has(t));
      bucket = hasPriority ? priorPriority : priorOther;
      planTypes = best.types;
      planYears = best.types.map(() => best.year);
    }

    bucket.push({
      iso3,
      name_en: geo.name_en ?? iso3,
      regional: office.regional ?? "",
      office_type: officeTypeByIso3[iso3] ?? "",
      plan_types: planTypes,
      inGis: gisIso3.has(iso3),
      plan_years: planYears,
      hdxUrl: getHdxUrl(iso3),
      ...getCountryExtras(iso3),
    });
  }

  const allPlanIso3 = new Set(plansByIso3.keys());
  const gisOnly: PlanCountry[] = [...gisIso3]
    .filter((iso3) => !allPlanIso3.has(iso3))
    .map((iso3) => {
      const geo = m49ByIso3[iso3] ?? {};
      const office = officeByIso3[iso3] ?? {};
      return {
        iso3,
        name_en: geo.name_en ?? iso3,
        regional: office.regional ?? "",
        office_type: officeTypeByIso3[iso3] ?? "",
        plan_types: [],
        inGis: true,
        hdxUrl: getHdxUrl(iso3),
        ...getCountryExtras(iso3),
      };
    })
    .sort((a, b) => a.name_en.localeCompare(b.name_en));

  const m49Only: PlanCountry[] = Object.entries(m49ByIso3)
    .filter(([iso3]) => !allPlanIso3.has(iso3) && !gisIso3.has(iso3) && iso3 !== "")
    .map(([iso3, geo]) => {
      const office = officeByIso3[iso3] ?? {};
      return {
        iso3,
        name_en: geo.name_en ?? iso3,
        regional: office.regional ?? "",
        office_type: officeTypeByIso3[iso3] ?? "",
        plan_types: [],
        inGis: false,
        hdxUrl: getHdxUrl(iso3),
        ...getCountryExtras(iso3),
      };
    })
    .sort((a, b) => a.name_en.localeCompare(b.name_en));

  const byNextReview = (a: PlanCountry, b: PlanCountry) => {
    if (a.next_review_sort && b.next_review_sort)
      return a.next_review_sort.localeCompare(b.next_review_sort);
    if (a.next_review_sort) return -1;
    if (b.next_review_sort) return 1;
    if (a.inGis !== b.inGis) return a.inGis ? -1 : 1;
    return a.name_en.localeCompare(b.name_en);
  };
  const planGroups: PlanGroup[] = [
    {
      key: "current-priority",
      label: `HNRP / HRP / FA (${latestPlanYear})`,
      countries: currentPriority.sort(byNextReview),
    },
    {
      key: "current-other",
      label: `Other Plans (${latestPlanYear})`,
      countries: currentOther.sort(byNextReview),
    },
    {
      key: "prior-priority",
      label: "HNRP / HRP / FA (Prior Years)",
      countries: priorPriority.sort(byNextReview),
    },
    {
      key: "prior-other",
      label: "Other Plans (Prior Years)",
      countries: priorOther.sort(byNextReview),
    },
    {
      key: "no-plans",
      label: `No Plans (2000-${latestPlanYear})`,
      countries: [...gisOnly, ...m49Only].sort(byNextReview),
    },
  ];

  return {
    workOrders,
    workByQuarter,
    planCoverageByYear,
    planGroups,
    infoRows,
    overdueTotal: planGroups.reduce(
      (sum, g) => sum + g.countries.filter((c) => c.review_overdue).length,
      0,
    ),
    totalInGis: planGroups.reduce((sum, g) => sum + g.countries.filter((c) => c.inGis).length, 0),
    adminUnits: Object.values(unitsByIso3).reduce((sum, c) => sum + c.units, 0),
    total: dedupedRows.length,
    openTotal: dedupedRows.filter((r) => isOpenStatus(r.work_order_status)).length,
    lastUpdatedAt,
  };
}
