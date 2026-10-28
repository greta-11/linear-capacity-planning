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

export interface Project {
  id: string;
  name: string;
  url: string;
  /** Target delivery day, if set. */
  targetDate: Day | null;
  startDate: Day | null;
  /** Linear project status category (backlog, planned, started, paused, completed, canceled). */
  statusType: string;
  statusName: string;
  /** Health from the latest project update in Linear. */
  health: 'onTrack' | 'atRisk' | 'offTrack' | null;
  /** 0..1, as reported by Linear. */
  progress: number;
  leadId: string | null;
  teamIds: string[];
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
  /** Linear due date, if set. */
  dueDate: Day | null;
  projectId: string | null;
  projectName: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  /** When the issue entered its current cycle (from issue history, falling back to createdAt). */
  addedToCycleAt: string | null;
}

/** Bump when the snapshot shape changes so stored snapshots are pulled again. */
export const SNAPSHOT_VERSION = 4;

export interface Snapshot {
  version?: number;
  source: 'linear' | 'demo';
  organizationName: string;
  /** Used to build links when an issue url is missing. */
  urlKey: string | null;
  fetchedAt: string;
  /** Set when the issues in scope come from one saved Linear view. */
  view?: { id: string; name: string; url: string; issueIds: string[] } | null;
  /** Demo mode only: the day the demo workspace was generated for. */
  demoSeedDay?: Day;
  teams: Team[];
  people: Person[];
  cycles: Cycle[];
  issues: Issue[];
  projects: Project[];
}

/** How each person's points-per-working-day is derived. */
export type VelocityMode = { kind: 'history' } | { kind: 'team-average' } | { kind: 'manual'; pointsPerWeek: number };

export interface SyncRecord {
  at: string;
  source: 'linear' | 'demo';
  ok: boolean;
  error?: string;
  counts?: { teams: number; people: number; cycles: number; issues: number };
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

/** Share of an issue's points still to do, by workflow status. */
export interface StatusWeights {
  /** Triage, Backlog, Todo. */
  notStarted: number;
  /** Started states (e.g. In Progress). */
  inProgress: number;
  /** Started states whose name contains "review". */
  inReview: number;
}

export interface Settings {
  /** Days of week that count as working days (0 = Sunday … 6 = Saturday). */
  workDays: number[];
  /** Points per available working day when a person has no usable history and no teammate has any. */
  defaultVelocity: number;
  /** How many completed cycles per team feed velocity. */
  lookbackCycles: number;
  thresholds: Thresholds;
  statusWeights: StatusWeights;
}

export interface PlannerState {
  settings: Settings;
}
