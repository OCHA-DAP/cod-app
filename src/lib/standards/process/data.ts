export type Track = "with" | "without";
export type CellTrack = Track | "both";
export type Kind = "lead" | "support" | "informed";

export const TRACKS: { id: Track; label: string }[] = [
  { id: "with", label: "With OCHA presence" },
  { id: "without", label: "Without OCHA presence" },
];

export interface Step {
  id: string;
  number?: number;
  title: string;
  duration?: string;
  /** Duration depends on country consultations. */
  variable?: boolean;
}

export const STEPS: Step[] = [
  {
    id: "step-1",
    number: 1,
    title: "Periodic review",
    duration: "1 week",
  },
  {
    id: "step-2",
    number: 2,
    title: "Initialization",
    duration: "1 week",
    variable: true,
  },
  {
    id: "step-3",
    number: 3,
    title: "Country-level review",
    duration: "1 week",
    variable: true,
  },
  {
    id: "step-4",
    number: 4,
    title: "Standardization",
    duration: "1 week",
  },
  {
    id: "step-5",
    number: 5,
    title: "Final review",
    duration: "1 week",
  },
  {
    id: "step-6",
    number: 6,
    title: "Final data package",
    duration: "1 week",
  },
  { id: "step-ongoing", title: "Monitoring" },
];

export type LaneId =
  "wg" | "ocha-hq" | "imwg" | "agency-hq" | "agency-country" | "lead" | "partners";
export type GroupId = "wg" | "ocha" | "agencies" | "partners";

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "wg", label: "WG" },
  { id: "ocha", label: "OCHA" },
  { id: "agencies", label: "Agencies" },
  { id: "partners", label: "Partners" },
];

export interface Lane {
  id: LaneId;
  group: GroupId;
  label: string;
  subtitle?: string;
  /** Lanes that only exist in one track. */
  track?: Track;
}

export const LANES: Lane[] = [
  { id: "wg", group: "wg", label: "COD-AB Working Group" },
  { id: "ocha-hq", group: "ocha", label: "OCHA HQ", subtitle: "ISS team" },
  {
    id: "imwg",
    group: "ocha",
    label: "IMWG",
    subtitle: "Coordinated by OCHA, incl. the IMO",
    track: "with",
  },
  { id: "agency-hq", group: "agencies", label: "Member Agency HQ" },
  {
    id: "agency-country",
    group: "agencies",
    label: "Member Agency Country Team",
    track: "without",
  },
  {
    id: "lead",
    group: "agencies",
    label: "Lead Agency",
    subtitle: "One member agency per update, agreed by the WG",
    track: "without",
  },
  { id: "partners", group: "partners", label: "UN Geospatial Section, other stakeholders" },
];

export interface Cell {
  step: string;
  lane: LaneId;
  track: CellTrack;
  kind: Kind;
  /** Short text for the diagram box. */
  label: string;
  delegableTo?: string;
}

export const CELLS: Cell[] = [
  // Step 1
  {
    step: "step-1",
    lane: "ocha-hq",
    track: "with",
    kind: "lead",
    label: "Starts the review, sends requests",
  },
  {
    step: "step-1",
    lane: "ocha-hq",
    track: "without",
    kind: "lead",
    label: "Starts the review",
  },
  {
    step: "step-1",
    lane: "agency-hq",
    track: "without",
    kind: "lead",
    label: "Sends review requests",
  },
  {
    step: "step-1",
    lane: "imwg",
    track: "with",
    kind: "lead",
    label: "Reviews boundaries, submits the form",
  },
  {
    step: "step-1",
    lane: "agency-country",
    track: "without",
    kind: "lead",
    label: "Reviews boundaries, submits the form",
  },
  // Step 2
  {
    step: "step-2",
    lane: "ocha-hq",
    track: "with",
    kind: "lead",
    label: "Reconciles requests, opens ticket and workspace, prepares sources",
    delegableTo: "the IMWG",
  },
  {
    step: "step-2",
    lane: "ocha-hq",
    track: "without",
    kind: "lead",
    label: "Reconciles requests, opens ticket and workspace",
  },
  {
    step: "step-2",
    lane: "agency-hq",
    track: "without",
    kind: "lead",
    label: "Prepares sources",
    delegableTo: "its country team",
  },
  {
    step: "step-2",
    lane: "wg",
    track: "without",
    kind: "support",
    label: "Agrees the Lead Agency",
  },
  // Step 3
  {
    step: "step-3",
    lane: "imwg",
    track: "with",
    kind: "lead",
    label: "Coordinates the review, endorses and nominates the Candidate",
  },
  {
    step: "step-3",
    lane: "lead",
    track: "without",
    kind: "lead",
    label: "Coordinates the review, nominates the Candidate",
  },
  {
    step: "step-3",
    lane: "agency-country",
    track: "without",
    kind: "lead",
    label: "Carries out the review",
  },
  {
    step: "step-3",
    lane: "ocha-hq",
    track: "both",
    kind: "support",
    label: "Records the outcome, closes the ticket if no update",
  },
  // Step 4
  {
    step: "step-4",
    lane: "ocha-hq",
    track: "with",
    kind: "lead",
    label: "Standardizes, assigns P-codes, validates, uploads",
    delegableTo: "the IMWG",
  },
  {
    step: "step-4",
    lane: "lead",
    track: "without",
    kind: "lead",
    label: "Standardizes, assigns P-codes, validates, uploads",
    delegableTo: "its country team",
  },
  // Step 5
  {
    step: "step-5",
    lane: "wg",
    track: "both",
    kind: "lead",
    label: "Reviews and accepts the Candidate",
  },
  {
    step: "step-5",
    lane: "imwg",
    track: "with",
    kind: "lead",
    label: "Reviews and accepts the Candidate",
  },
  {
    step: "step-5",
    lane: "agency-country",
    track: "without",
    kind: "lead",
    label: "Reviews and accepts the Candidate",
  },
  // Step 6
  {
    step: "step-6",
    lane: "ocha-hq",
    track: "both",
    kind: "lead",
    label: "Completes metadata and package, signs off, publishes, notifies, closes",
  },
  {
    step: "step-6",
    lane: "partners",
    track: "both",
    kind: "informed",
    label: "Informed",
  },
  // Ongoing
  {
    step: "step-ongoing",
    lane: "ocha-hq",
    track: "both",
    kind: "lead",
    label: "Keeps the status record and dashboard",
  },
  {
    step: "step-ongoing",
    lane: "imwg",
    track: "with",
    kind: "support",
    label: "Monitors changes",
  },
  {
    step: "step-ongoing",
    lane: "agency-hq",
    track: "both",
    kind: "support",
    label: "Monitors changes",
  },
  {
    step: "step-ongoing",
    lane: "agency-country",
    track: "without",
    kind: "support",
    label: "Monitors changes",
  },
];

export const RETURN_LOOPS = [
  { from: "step-4", to: "step-3", label: "Issues found" },
  { from: "step-5", to: "step-4", label: "Returned for rework" },
];

export const cellId = (c: Cell) => `${c.step}-${c.lane}${c.track === "both" ? "" : `-${c.track}`}`;
export const laneById = (id: LaneId) => LANES.find((l) => l.id === id)!;
export const stepById = (id: string) => STEPS.find((s) => s.id === id)!;
export const stepName = (s: Step) => (s.number ? `Step ${s.number}: ${s.title}` : s.title);
