// Domain model shared by the server, the CLI scripts and the browser.
// Calendar days are always 'YYYY-MM-DD' strings; timestamps are ISO strings.

export type Day = string;

export type StateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface Team {
  id: string;
  key: string;
  name: string;
  cyclesEnabled: boolean;
  /** Cycle length in weeks. */
  cycleDuration: number;
  /** Linear's issueEstimationType; 'notUsed' means we count issues instead of points. */
  estimationType: string;
  timezone: string;
  memberIds: string[];
}

export interface Person {
  id: string;
  name: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  active: boolean;
  teamIds: string[];
}

export interface Cycle {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  /** First day of the cycle (team timezone), inclusive. */
  startDate: Day;
  /** Last day of the cycle (team timezone), inclusive. */
  endDate: Day;
  completedAt: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  cycleId: string | null;
  assigneeId: string | null;
  estimate: number | null;
  /** 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low. */
  priority: number;
  stateType: StateType;
  stateName: string;
  projectName: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  /** When the issue entered its current cycle (from issue history, falling back to createdAt). */
  addedToCycleAt: string | null;
}

export interface Snapshot {
  source: 'linear' | 'demo';
  organizationName: string;
  /** Used to build links when an issue url is missing. */
  urlKey: string | null;
  fetchedAt: string;
  /** Demo mode only: the day the demo workspace was generated for. */
  demoSeedDay?: Day;
  teams: Team[];
  people: Person[];
  cycles: Cycle[];
  issues: Issue[];
}

export interface SyncRecord {
  at: string;
  source: 'linear' | 'demo';
  ok: boolean;
  error?: string;
  counts?: { teams: number; people: number; cycles: number; issues: number };
  staleEntries?: number;
}

// ---------------------------------------------------------------------------
// OOO

export interface OooEntry {
  id: string;
  /** Lower-cased email, or '*' for a company-wide holiday. */
  email: string;
  personId: string | null;
  start: Day;
  end: Day;
  type: string;
  /** Share of each day that is out: 1 = full day, 0.5 = half day. */
  fraction: number;
  note: string;
  /** 1-based data row in the source CSV (header excluded). */
  row: number;
}

export type OooProblemKind = 'parse' | 'missing' | 'date' | 'range' | 'fraction' | 'unknown-email' | 'overlap';

export interface OooProblem {
  row: number;
  kind: OooProblemKind;
  severity: 'error' | 'warning';
  message: string;
  email?: string;
}

export interface OooDataset {
  fileName: string;
  uploadedAt: string;
  entries: OooEntry[];
  problems: OooProblem[];
  /** True when the entries were generated for demo mode rather than imported. */
  generated?: boolean;
}

// ---------------------------------------------------------------------------
// Planner state (kept locally, never written to Linear)

export interface Thresholds {
  /** Below this utilization a person or cycle is under-loaded. */
  under: number;
  /** Above this utilization it is at risk. */
  atRisk: number;
  /** Above this utilization it is over capacity. */
  over: number;
}

export interface Settings {
  /** Days of week that count as working days (0 = Sunday … 6 = Saturday). */
  workDays: number[];
  /** Points per available working day when a person has no usable history. */
  defaultVelocity: number;
  /** How many completed cycles per team feed velocity and unplanned ratios. */
  lookbackCycles: number;
  /** Share of future capacity reserved for unplanned work when a team has no explicit buffer. */
  defaultUnplannedBuffer: number;
  thresholds: Thresholds;
}

export type Change =
  | { kind: 'issue.cycle'; issueId: string; identifier: string; from: string | null; to: string }
  | { kind: 'issue.assignee'; issueId: string; identifier: string; from: string | null; to: string }
  | { kind: 'issue.estimate'; issueId: string; identifier: string; from: number | null; to: number }
  | { kind: 'planner.allocation'; personId: string; from: Record<string, number> | null; to: Record<string, number> }
  | { kind: 'planner.velocity'; personId: string; from: number | null; to: number }
  | { kind: 'planner.unplannedBuffer'; teamId: string; from: number | null; to: number }
  | { kind: 'csv.ooo'; email: string; rows: number[]; note: string };

export type Destination = 'linear' | 'planner' | 'csv';

export type LedgerStatus =
  | 'pending' // linear: accepted, waiting for review + apply
  | 'stale' // linear: the issue changed in Linear since the recommendation was accepted
  | 'synced' // linear: written to Linear
  | 'failed' // linear: the write failed
  | 'applied' // planner: in effect
  | 'reverted' // planner: undone
  | 'open' // csv: to-do for the OOO source system
  | 'done'; // csv: marked fixed by the user

export interface ChangeResult {
  ok: boolean;
  message: string;
}

export interface LedgerEntry {
  id: string;
  recommendationId: string;
  /** Group of the recommendation; while the entry is active, others in the group stay hidden. */
  group: string;
  rule: RuleId;
  destination: Destination;
  title: string;
  /** One-line evidence summary captured at accept time. */
  reason: string;
  changes: Change[];
  status: LedgerStatus;
  acceptedAt: string;
  acceptedBy: string;
  updatedAt: string;
  results?: ChangeResult[];
  note?: string;
}

export interface PlannerState {
  settings: Settings;
  /** personId → teamId → share of time (0..1). Only set for explicit overrides. */
  allocations: Record<string, Record<string, number>>;
  /** personId → points per working day. */
  velocityOverrides: Record<string, number>;
  /** teamId → share of future capacity reserved for unplanned work. */
  unplannedBuffers: Record<string, number>;
  ledger: LedgerEntry[];
  dismissed: string[];
}

// ---------------------------------------------------------------------------
// Recommendations

export type RuleId =
  | 'defer'
  | 'reassign'
  | 'estimate'
  | 'rebalance-allocation'
  | 'unplanned-buffer'
  | 'velocity-override'
  | 'ooo-data';

export interface EvidenceIssue {
  issueId: string;
  note?: string;
  highlight?: boolean;
}

export interface EvidenceCycle {
  cycleId: string;
  points: number;
  note?: string;
}

export interface Evidence {
  metric: { label: string; value: string; threshold?: string };
  rule: string;
  rationale: string[];
  facts: { label: string; value: string }[];
  issues: EvidenceIssue[];
  oooEntryIds: string[];
  oooProblemRows: number[];
  cycles: EvidenceCycle[];
  freshness: { snapshotFetchedAt: string; snapshotSource: string; oooFile: string | null; oooUploadedAt: string | null };
}

export interface Recommendation {
  id: string;
  rule: RuleId;
  destination: Destination;
  severity: 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  /** Recommendations sharing a group act on the same thing; accepting one hides the rest. */
  group: string;
  changes: Change[];
  /** Estimate recommendations let the user edit the proposed values before accepting. */
  editable?: boolean;
  personId?: string;
  teamId?: string;
  cycleId?: string;
  evidence: Evidence;
}
