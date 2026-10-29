import { addDays, countWorkingDays, dayInTimezone, maxDay, minDay, overlap, weekStart, workingDays } from './calendar';
import type { Cycle, Day, Issue, OooDataset, OooEntry, Person, PlannerState, Project, Settings, Snapshot, Team, VelocityMode } from './types';

// Capacity engine. Capacity is calculated in this order:
//   1. baseline   = velocity × working days
//   2. available  = baseline × (1 − OOO share)          OOO share = OOO days ÷ working days
//   3. plannable  = available × (1 − buffer %)
//   4. utilization = planned load ÷ plannable
// Planned load = cycle work + unscheduled work spread to its due/target date, each issue
// counted at its remaining share by status (e.g. In Progress = 50%).
// Periods can start in the past (at the earliest open issue's cycle). A cycle under way
// then carries its whole commitment: work already done (completed issues, and the done
// share of started ones) is spread over the elapsed days, remaining work over the rest.

export type Status = 'none' | 'under' | 'healthy' | 'at-risk' | 'over';

export interface CapacityInput {
  snapshot: Snapshot;
  ooo: OooDataset | null;
  planner: PlannerState;
  range: { from: Day; to: Day };
  today: Day;
  /** Defaults to per-person history. */
  velocityMode?: VelocityMode;
  /** Share of available capacity held back for unplanned work, applied to everyone. Defaults to 10%. */
  bufferPct?: number;
}

export interface VelocityInfo {
  value: number;
  source: 'history' | 'team-average' | 'default' | 'manual';
  /** Velocity measured from the person's own history, even when not used. */
  historyValue: number | null;
  points: number;
  availableDays: number;
  oooDays: number;
  completedIssues: number;
  window: { start: Day; end: Day } | null;
  cycles: { cycleId: string; points: number }[];
  issueIds: string[];
  /** Why a fallback was used, shown under the person's name. */
  fallbackNote: string | null;
}

export interface AllocationInfo {
  shares: Record<string, number>;
  source: 'single-team' | 'history' | 'planned' | 'even';
  historyPoints: Record<string, number>;
  plannedPoints: Record<string, number>;
}

export type LoadKind = 'planned' | 'unplanned' | 'unscheduled' | 'done';

export interface LoadItem {
  issueId: string;
  teamId: string;
  assigneeId: string | null;
  /** Null for unscheduled work (no cycle; spread to its due date or project target). */
  cycleId: string | null;
  projectId: string | null;
  kind: LoadKind;
  /** Points falling inside the window (remaining work, or for `done`, work already done). */
  points: number;
  /** Estimate (or team median when unestimated). */
  fullPoints: number;
  /** Share still to do, from the issue's status (for `done`, the share already done). */
  weight: number;
  /** fullPoints × weight: all points of this part of the issue, inside the window or not. */
  remainingPoints: number;
  unestimated: boolean;
  /** For unscheduled work: where its end date came from. */
  dateSource?: 'due' | 'project';
  /** Unscheduled work whose date has already passed. */
  overdue?: boolean;
}

export interface TeamLoad {
  planned: number;
  unplanned: number;
  unscheduled: number;
  /** Work already done in a cycle under way, on its elapsed days. */
  done: number;
}

export interface PersonWindow {
  start: Day;
  end: Day;
  workingDays: number;
  oooDays: number;
  oooShare: number;
  oooEntries: { entryId: string; days: number }[];
  baseline: number;
  available: number;
  buffer: number;
  bufferPoints: number;
  plannable: number;
  /** Same as plannable: what utilization is measured against. */
  capacity: number;
  loadByTeam: Record<string, TeamLoad>;
  items: LoadItem[];
  load: number;
  utilization: number | null;
  status: Status;
}

export interface TeamMember {
  personId: string;
  share: number;
  /** Plannable capacity for this team. */
  capacity: number;
  teamLoad: number;
  otherTeamLoad: number;
  oooDays: number;
  /** Whole-person utilization across all teams in the window. */
  utilization: number | null;
  status: Status;
}

export interface TeamWindow {
  start: Day;
  end: Day;
  /** Members' whole baseline, before OOO and other teams. */
  fullBaseline: number;
  /** Baseline lost to members' OOO. */
  fullOoo: number;
  /** Members' available capacity that belongs to other teams. */
  sharedLost: number;
  /** Available capacity for this team. */
  available: number;
  bufferPoints: number;
  plannable: number;
  capacity: number;
  planned: number;
  unplanned: number;
  unscheduled: number;
  done: number;
  /** Of the load above, what has no assignee. */
  unassigned: number;
  load: number;
  utilization: number | null;
  status: Status;
  items: LoadItem[];
  byProject: Record<string, { points: number; issueIds: string[] }>;
  unestimatedIssueIds: string[];
  issueIds: string[];
  members: TeamMember[];
}

export interface Spread {
  issue: Issue;
  cycle: Cycle | null;
  start: Day;
  end: Day;
  days: number;
  fullPoints: number;
  weight: number;
  points: number;
  unestimated: boolean;
  kind: LoadKind;
  dateSource?: 'due' | 'project';
  overdue: boolean;
  /** The spread has no working days; all points land on its last day. */
  noWorkDays: boolean;
}

export interface CapacityModel {
  input: CapacityInput;
  from: Day;
  to: Day;
  bufferPct: number;
  teams: Map<string, Team>;
  people: Map<string, Person>;
  cycles: Map<string, Cycle>;
  issues: Map<string, Issue>;
  projects: Map<string, Project>;
  oooEntries: Map<string, OooEntry>;
  velocity: Map<string, VelocityInfo>;
  allocation: Map<string, AllocationInfo>;
  medianEstimate: Map<string, number>;
  velocityMode: VelocityMode;
  pointsOf(issue: Issue): { points: number; unestimated: boolean };
  statusWeight(issue: Issue): number;
  /** Where an issue's remaining points are spread, or null when it isn't load. */
  spreadOf(issueId: string): Spread | null;
  /** Remaining points of an issue that fall in a window. */
  issuePoints(issueId: string, start: Day, end: Day): number;
  /** Work already done on an issue in its current cycle, spread over the cycle's elapsed days. */
  doneSpreadOf(issueId: string): Spread | null;
  /** Active people with no planned load anywhere in the range (0% in every period). */
  idlePeople: Set<string>;
  /** Whether a person counts: active, with planned load somewhere in the range. */
  inPlan(personId: string): boolean;
  isCompletedCycle(cycle: Cycle): boolean;
  isActiveCycle(cycle: Cycle): boolean;
  completedCyclesOf(teamId: string): Cycle[];
  upcomingCyclesOf(teamId: string): Cycle[];
  personWindow(personId: string, start: Day, end: Day): PersonWindow;
  /** Open work of a team (assigned or not) that falls inside the window. */
  teamItems(teamId: string, start: Day, end: Day): LoadItem[];
  unplannedKind(issue: Issue): 'planned' | 'unplanned';
  teamName(teamId: string): string;
  cycleLabel(cycleId: string): string;
}

export const DEFAULT_BUFFER = 0.1;

export const DEFAULT_SETTINGS: Settings = {
  workDays: [1, 2, 3, 4, 5],
  defaultVelocity: 1,
  lookbackCycles: 3,
  thresholds: { under: 0.7, atRisk: 1.0, over: 1.15 },
  statusWeights: { notStarted: 1, inProgress: 0.5, inReview: 0.25 },
};

export function emptyPlanner(): PlannerState {
  return { settings: structuredClone(DEFAULT_SETTINGS) };
}

const OPEN_STATES = new Set(['triage', 'backlog', 'unstarted', 'started']);

export function isOpen(issue: Issue): boolean {
  return OPEN_STATES.has(issue.stateType);
}

export function isNotStarted(issue: Issue): boolean {
  return issue.stateType === 'triage' || issue.stateType === 'backlog' || issue.stateType === 'unstarted';
}

export function classify(load: number, capacity: number, settings: Settings): { utilization: number | null; status: Status } {
  if (capacity <= 0.0001) return { utilization: null, status: load > 0.0001 ? 'over' : 'none' };
  const u = load / capacity;
  const t = settings.thresholds;
  if (u > t.over) return { utilization: u, status: 'over' };
  if (u > t.atRisk) return { utilization: u, status: 'at-risk' };
  if (u < t.under) return { utilization: u, status: 'under' };
  return { utilization: u, status: 'healthy' };
}

export function cycleName(cycle: Cycle, team?: Team): string {
  const base = cycle.name ? `${cycle.name}` : `Cycle ${cycle.number}`;
  return team ? `${team.key} ${base}` : base;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function teamLoadTotal(l: TeamLoad): number {
  return l.planned + l.unplanned + l.unscheduled + l.done;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildModel(input: CapacityInput): CapacityModel {
  const { snapshot, planner, today } = input;
  const settings = { ...DEFAULT_SETTINGS, ...planner.settings, statusWeights: { ...DEFAULT_SETTINGS.statusWeights, ...planner.settings.statusWeights } };
  const workDays = settings.workDays;
  // The range may start before today; past days count in full (see the header).
  const from = input.range.from;
  const to = input.range.to;
  const bufferPct = Math.min(0.9, Math.max(0, input.bufferPct ?? DEFAULT_BUFFER));

  const teams = new Map(snapshot.teams.map((t) => [t.id, t]));
  const people = new Map(snapshot.people.map((p) => [p.id, p]));
  const cycles = new Map(snapshot.cycles.map((c) => [c.id, c]));
  const issues = new Map(snapshot.issues.map((i) => [i.id, i]));
  const projects = new Map((snapshot.projects ?? []).map((p) => [p.id, p]));
  const velocityMode: VelocityMode = input.velocityMode ?? { kind: 'history' };
  const oooEntries = new Map((input.ooo?.entries ?? []).map((e) => [e.id, e]));

  const cyclesByTeam = new Map<string, Cycle[]>();
  for (const c of snapshot.cycles) {
    const list = cyclesByTeam.get(c.teamId) ?? [];
    list.push(c);
    cyclesByTeam.set(c.teamId, list);
  }
  for (const list of cyclesByTeam.values()) list.sort((a, b) => a.startDate.localeCompare(b.startDate));

  const issuesByCycle = new Map<string, Issue[]>();
  for (const i of snapshot.issues) {
    if (!i.cycleId) continue;
    const list = issuesByCycle.get(i.cycleId) ?? [];
    list.push(i);
    issuesByCycle.set(i.cycleId, list);
  }

  const isCompletedCycle = (c: Cycle) => c.completedAt != null || c.endDate < today;
  const isActiveCycle = (c: Cycle) => !isCompletedCycle(c) && c.startDate <= today;
  const completedCyclesOf = (teamId: string) =>
    (cyclesByTeam.get(teamId) ?? []).filter(isCompletedCycle).sort((a, b) => b.endDate.localeCompare(a.endDate)).slice(0, settings.lookbackCycles);
  const upcomingCyclesOf = (teamId: string) => (cyclesByTeam.get(teamId) ?? []).filter((c) => !isCompletedCycle(c));

  // Median estimate per team, used for unestimated issues.
  const medianEstimate = new Map<string, number>();
  for (const t of snapshot.teams) {
    const est = snapshot.issues.filter((i) => i.teamId === t.id && i.estimate != null && i.estimate > 0).map((i) => i.estimate as number);
    medianEstimate.set(t.id, median(est) ?? 2);
  }

  const pointsOf = (issue: Issue) => {
    const team = teams.get(issue.teamId);
    if (team?.estimationType === 'notUsed') return { points: 1, unestimated: false };
    if (issue.estimate != null) return { points: issue.estimate, unestimated: false };
    return { points: medianEstimate.get(issue.teamId) ?? 2, unestimated: true };
  };

  const statusWeight = (issue: Issue) => {
    const w = settings.statusWeights;
    if (issue.stateType !== 'started') return w.notStarted;
    return /review/i.test(issue.stateName) ? w.inReview : w.inProgress;
  };

  const unplannedKind = (issue: Issue): 'planned' | 'unplanned' => {
    const cycle = issue.cycleId ? cycles.get(issue.cycleId) : undefined;
    if (!cycle || cycle.startDate > today || !issue.addedToCycleAt) return 'planned';
    const tz = teams.get(issue.teamId)?.timezone ?? 'UTC';
    return dayInTimezone(issue.addedToCycleAt, tz) > cycle.startDate ? 'unplanned' : 'planned';
  };

  // --- OOO per person per working day ------------------------------------
  const oooByPerson = new Map<string, OooEntry[]>();
  const companyOoo: OooEntry[] = [];
  for (const e of oooEntries.values()) {
    if (e.email === '*') companyOoo.push(e);
    else if (e.personId) {
      const list = oooByPerson.get(e.personId) ?? [];
      list.push(e);
      oooByPerson.set(e.personId, list);
    }
  }
  const oooIn = (personId: string, start: Day, end: Day) => {
    const entries = [...companyOoo, ...(oooByPerson.get(personId) ?? [])];
    const perDay = new Map<Day, number>();
    const byEntry: { entryId: string; days: number }[] = [];
    for (const e of entries) {
      const ov = overlap(start, end, e.start, e.end);
      if (!ov) continue;
      const days = workingDays(ov[0], ov[1], workDays);
      if (!days.length) continue;
      byEntry.push({ entryId: e.id, days: days.length * e.fraction });
      for (const d of days) perDay.set(d, Math.min(1, (perDay.get(d) ?? 0) + e.fraction));
    }
    let total = 0;
    for (const v of perDay.values()) total += v;
    return { total, byEntry };
  };

  // --- Velocity -----------------------------------------------------------
  const velocity = new Map<string, VelocityInfo>();
  const historyPointsByTeam = new Map<string, Record<string, number>>();
  for (const p of snapshot.people) {
    const lookback = new Map<string, Cycle>();
    for (const t of p.teamIds) for (const c of completedCyclesOf(t)) lookback.set(c.id, c);
    const cycleList = [...lookback.values()];
    const perTeam: Record<string, number> = {};
    let points = 0;
    let count = 0;
    const issueIds: string[] = [];
    const cyclePoints: { cycleId: string; points: number }[] = [];
    for (const c of cycleList) {
      let cp = 0;
      for (const i of issuesByCycle.get(c.id) ?? []) {
        if (i.assigneeId !== p.id || i.stateType !== 'completed') continue;
        const pts = pointsOf(i).points;
        cp += pts;
        count++;
        issueIds.push(i.id);
        perTeam[i.teamId] = (perTeam[i.teamId] ?? 0) + pts;
      }
      points += cp;
      cyclePoints.push({ cycleId: c.id, points: cp });
    }
    historyPointsByTeam.set(p.id, perTeam);
    let window: VelocityInfo['window'] = null;
    let available = 0;
    let oooDays = 0;
    if (cycleList.length) {
      const start = cycleList.reduce((m, c) => minDay(m, c.startDate), cycleList[0].startDate);
      const end = cycleList.reduce((m, c) => maxDay(m, c.endDate), cycleList[0].endDate);
      window = { start, end };
      oooDays = oooIn(p.id, start, end).total;
      available = countWorkingDays(start, end, workDays) - oooDays;
    }
    const historyValue = available > 0 && points > 0 ? points / available : null;
    const usable = historyValue != null && historyValue > 0 && count >= 3 && available >= 5;
    velocity.set(p.id, {
      value: usable ? historyValue : 0,
      source: usable ? 'history' : 'default',
      historyValue,
      points,
      availableDays: available,
      oooDays,
      completedIssues: count,
      window,
      cycles: cyclePoints.sort((a, b) => (cycles.get(a.cycleId)!.startDate < cycles.get(b.cycleId)!.startDate ? -1 : 1)),
      issueIds,
      fallbackNote: null,
    });
  }
  // Team averages only count members with usable history and a velocity above zero.
  const teamAvgVelocity = new Map<string, number>();
  for (const t of snapshot.teams) {
    const vals = t.memberIds
      .map((id) => velocity.get(id))
      .filter((v) => v?.source === 'history' && v.value > 0)
      .map((v) => v!.value);
    if (vals.length) teamAvgVelocity.set(t.id, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const perWeek = (v: number) => round1(v * workDays.length);
  for (const p of snapshot.people) {
    const v = velocity.get(p.id)!;
    const avgTeams = p.teamIds.filter((t) => teamAvgVelocity.has(t));
    const teamAvg = avgTeams.length ? avgTeams.reduce((a, t) => a + teamAvgVelocity.get(t)!, 0) / avgTeams.length : null;
    const teamNames = avgTeams.map((t) => teams.get(t)!.name).join(' + ');
    if (velocityMode.kind === 'history') {
      if (v.source !== 'history') {
        const why = `Not enough history (${v.completedIssues} completed issue${v.completedIssues === 1 ? '' : 's'})`;
        if (teamAvg != null) {
          v.value = teamAvg;
          v.source = 'team-average';
          v.fallbackNote = `${why} — using ${teamNames} team average, ${perWeek(teamAvg)} pts/wk`;
        } else {
          v.value = settings.defaultVelocity;
          v.source = 'default';
          v.fallbackNote = `${why} and no teammate history — using the default, ${perWeek(settings.defaultVelocity)} pts/wk`;
        }
      }
    } else if (velocityMode.kind === 'team-average') {
      v.value = teamAvg ?? settings.defaultVelocity;
      v.source = teamAvg != null ? 'team-average' : 'default';
    } else {
      // Points per week → points per working day, so any period length rescales it.
      v.value = Math.max(0, velocityMode.pointsPerWeek) / Math.max(1, workDays.length);
      v.source = 'manual';
    }
  }

  // --- Spread of work over working days ----------------------------------
  // Cycle work is spread over the cycle's remaining working days. Work with no cycle is
  // spread from today to its due date, or else its project's target date (over the
  // current week when that date has passed). Work with no date at all isn't load.
  // In a cycle under way, work already done is spread over the elapsed days.
  const spreads: Spread[] = [];
  const spreadById = new Map<string, Spread>();
  const doneById = new Map<string, Spread>();
  const yesterday = addDays(today, -1);
  const addSpread = (
    issue: Issue,
    cycle: Cycle | null,
    start: Day,
    end: Day,
    kind: LoadKind,
    extra: { dateSource?: 'due' | 'project'; overdue?: boolean; weight?: number } = {},
  ) => {
    let days = countWorkingDays(start, end, workDays);
    const noWorkDays = days === 0;
    if (noWorkDays) {
      start = end;
      days = 1;
    }
    const { points: fullPoints, unestimated } = pointsOf(issue);
    const weight = extra.weight ?? statusWeight(issue);
    if (kind === 'done' && fullPoints * weight <= 0) return;
    const s: Spread = { issue, cycle, start, end, days, fullPoints, weight, points: fullPoints * weight, unestimated, kind, overdue: !!extra.overdue, dateSource: extra.dateSource, noWorkDays };
    spreads.push(s);
    (kind === 'done' ? doneById : spreadById).set(issue.id, s);
  };
  for (const i of snapshot.issues) {
    const c = i.cycleId ? cycles.get(i.cycleId) : undefined;
    // Done work in a cycle under way: completed issues in full, started ones by their done share.
    if (c && !isCompletedCycle(c) && c.startDate < today && countWorkingDays(c.startDate, yesterday, workDays) > 0) {
      if (i.stateType === 'completed') addSpread(i, c, c.startDate, yesterday, 'done', { weight: 1 });
      else if (isOpen(i)) addSpread(i, c, c.startDate, yesterday, 'done', { weight: 1 - statusWeight(i) });
    }
    if (!isOpen(i)) continue;
    if (i.cycleId) {
      if (!c || isCompletedCycle(c)) continue;
      addSpread(i, c, maxDay(c.startDate, today), c.endDate, unplannedKind(i));
      continue;
    }
    const target = i.projectId ? projects.get(i.projectId)?.targetDate : null;
    const date = i.dueDate ?? target ?? null;
    if (!date) continue;
    const overdue = date < today;
    addSpread(i, null, today, overdue ? addDays(weekStart(today), 6) : date, 'unscheduled', { dateSource: i.dueDate ? 'due' : 'project', overdue });
  }
  const portion = (s: Spread, start: Day, end: Day) => {
    const ov = overlap(start, end, s.start, s.end);
    if (!ov) return 0;
    const wd = s.noWorkDays ? 1 : countWorkingDays(ov[0], ov[1], workDays);
    return (s.points * wd) / s.days;
  };
  const toItem = (s: Spread, pts: number): LoadItem => ({
    issueId: s.issue.id,
    teamId: s.issue.teamId,
    assigneeId: s.issue.assigneeId,
    cycleId: s.cycle?.id ?? null,
    projectId: s.issue.projectId ?? null,
    kind: s.kind,
    points: pts,
    fullPoints: s.fullPoints,
    weight: s.weight,
    remainingPoints: s.points,
    unestimated: s.unestimated,
    ...(s.dateSource ? { dateSource: s.dateSource } : {}),
    ...(s.overdue ? { overdue: true } : {}),
  });
  const spreadsByAssignee = new Map<string | null, Spread[]>();
  const spreadsByTeam = new Map<string, Spread[]>();
  for (const s of spreads) {
    spreadsByAssignee.set(s.issue.assigneeId, [...(spreadsByAssignee.get(s.issue.assigneeId) ?? []), s]);
    spreadsByTeam.set(s.issue.teamId, [...(spreadsByTeam.get(s.issue.teamId) ?? []), s]);
  }
  const teamItems = (teamId: string, start: Day, end: Day): LoadItem[] => {
    const out: LoadItem[] = [];
    for (const s of spreadsByTeam.get(teamId) ?? []) {
      const pts = portion(s, start, end);
      if (pts > 0) out.push(toItem(s, pts));
    }
    return out;
  };

  // People with no planned load anywhere in the range would show 0% in every period and
  // pad their teams' capacity, so they're left out of capacity, rows and recommendations.
  const idlePeople = new Set(
    snapshot.people.filter((p) => p.active && !(spreadsByAssignee.get(p.id) ?? []).some((s) => portion(s, from, to) > 0)).map((p) => p.id),
  );
  const inPlan = (personId: string) => !!people.get(personId)?.active && !idlePeople.has(personId);

  // --- Allocation (share of time per team, for people on several teams) ---
  const allocation = new Map<string, AllocationInfo>();
  for (const p of snapshot.people) {
    const historyPoints = historyPointsByTeam.get(p.id) ?? {};
    const plannedPoints: Record<string, number> = {};
    for (const s of spreadsByAssignee.get(p.id) ?? []) {
      const pts = portion(s, from, to);
      if (pts > 0) plannedPoints[s.issue.teamId] = (plannedPoints[s.issue.teamId] ?? 0) + pts;
    }
    const teamIds = p.teamIds;
    const proportional = (src: Record<string, number>) => {
      const total = teamIds.reduce((a, t) => a + (src[t] ?? 0), 0);
      return total > 0 ? Object.fromEntries(teamIds.map((t) => [t, (src[t] ?? 0) / total])) : null;
    };
    let info: AllocationInfo;
    if (teamIds.length <= 1) {
      info = { shares: teamIds.length ? { [teamIds[0]]: 1 } : {}, source: 'single-team', historyPoints, plannedPoints };
    } else {
      const hist = proportional(historyPoints);
      const plan = hist ? null : proportional(plannedPoints);
      info = hist
        ? { shares: hist, source: 'history', historyPoints, plannedPoints }
        : plan
          ? { shares: plan, source: 'planned', historyPoints, plannedPoints }
          : { shares: Object.fromEntries(teamIds.map((t) => [t, 1 / teamIds.length])), source: 'even', historyPoints, plannedPoints };
    }
    allocation.set(p.id, info);
  }

  // --- Person window -----------------------------------------------------
  const personWindow = (personId: string, start: Day, end: Day): PersonWindow => {
    const person = people.get(personId)!;
    const v = velocity.get(personId)!;
    const wdays = countWorkingDays(start, end, workDays);
    const ooo = oooIn(personId, start, end);
    const baseline = v.value * wdays;
    const oooShare = wdays ? Math.min(1, ooo.total / wdays) : 0;
    const available = baseline * (1 - oooShare);
    const bufferPoints = available * bufferPct;
    const plannable = available - bufferPoints;
    const loadByTeam: Record<string, TeamLoad> = {};
    const bucket = (t: string) => (loadByTeam[t] ??= { planned: 0, unplanned: 0, unscheduled: 0, done: 0 });
    for (const t of person.teamIds) bucket(t);
    const items: LoadItem[] = [];
    for (const s of spreadsByAssignee.get(personId) ?? []) {
      const pts = portion(s, start, end);
      if (pts <= 0) continue;
      bucket(s.issue.teamId)[s.kind] += pts;
      items.push(toItem(s, pts));
    }
    const load = Object.values(loadByTeam).reduce((a, l) => a + teamLoadTotal(l), 0);
    return {
      start,
      end,
      workingDays: wdays,
      oooDays: ooo.total,
      oooShare,
      oooEntries: ooo.byEntry,
      baseline,
      available,
      buffer: bufferPct,
      bufferPoints,
      plannable,
      capacity: plannable,
      loadByTeam,
      items,
      load,
      ...classify(load, plannable, settings),
    };
  };

  const teamName = (teamId: string) => teams.get(teamId)?.name ?? 'Unknown team';
  const cycleLabel = (cycleId: string) => {
    const c = cycles.get(cycleId);
    return c ? cycleName(c, teams.get(c.teamId)) : 'Unknown cycle';
  };

  return {
    input: { ...input, planner: { settings } },
    from,
    to,
    bufferPct,
    teams,
    people,
    cycles,
    issues,
    projects,
    oooEntries,
    velocity,
    allocation,
    medianEstimate,
    velocityMode,
    pointsOf,
    statusWeight,
    spreadOf: (id) => spreadById.get(id) ?? null,
    issuePoints: (id, start, end) => {
      const s = spreadById.get(id);
      return s ? portion(s, start, end) : 0;
    },
    doneSpreadOf: (id) => doneById.get(id) ?? null,
    idlePeople,
    inPlan,
    isCompletedCycle,
    isActiveCycle,
    completedCyclesOf,
    upcomingCyclesOf,
    personWindow,
    teamItems,
    unplannedKind,
    teamName,
    cycleLabel,
  };
}

// ---------------------------------------------------------------------------
// Team view

/** A team's open work in a window, against its members' plannable time on that team. */
export function teamWindow(model: CapacityModel, teamId: string, start: Day, end: Day): TeamWindow {
  const team = model.teams.get(teamId)!;
  const settings = model.input.planner.settings;
  let fullBaseline = 0;
  let fullOoo = 0;
  let sharedLost = 0;
  let available = 0;
  const members: TeamMember[] = [];
  for (const pid of team.memberIds) {
    if (!model.inPlan(pid)) continue;
    const w = model.personWindow(pid, start, end);
    const share = model.allocation.get(pid)!.shares[teamId] ?? 0;
    fullBaseline += w.baseline;
    fullOoo += w.baseline - w.available;
    sharedLost += w.available * (1 - share);
    available += w.available * share;
    const teamLoad = w.items.filter((i) => i.teamId === teamId).reduce((a, i) => a + i.points, 0);
    members.push({
      personId: pid,
      share,
      capacity: w.plannable * share,
      teamLoad,
      otherTeamLoad: w.load - teamLoad,
      oooDays: w.oooDays,
      utilization: w.utilization,
      status: w.status,
    });
  }
  const bufferPoints = available * model.bufferPct;
  const plannable = available - bufferPoints;
  const items = model.teamItems(teamId, start, end);
  let planned = 0;
  let unplanned = 0;
  let unscheduled = 0;
  let done = 0;
  let unassigned = 0;
  const byProject: TeamWindow['byProject'] = {};
  for (const i of items) {
    if (i.kind === 'unplanned') unplanned += i.points;
    else if (i.kind === 'unscheduled') unscheduled += i.points;
    else if (i.kind === 'done') done += i.points;
    else planned += i.points;
    if (!i.assigneeId) unassigned += i.points;
    const key = i.projectId ?? 'none';
    const p = (byProject[key] ??= { points: 0, issueIds: [] });
    p.points += i.points;
    p.issueIds.push(i.issueId);
  }
  const load = planned + unplanned + unscheduled + done;
  return {
    start,
    end,
    fullBaseline,
    fullOoo,
    sharedLost,
    available,
    bufferPoints,
    plannable,
    capacity: plannable,
    planned,
    unplanned,
    unscheduled,
    done,
    unassigned,
    load,
    ...classify(load, plannable, settings),
    items,
    byProject,
    unestimatedIssueIds: [...new Set(items.filter((i) => i.unestimated).map((i) => i.issueId))],
    issueIds: [...new Set(items.map((i) => i.issueId))],
    members: members.sort((a, b) => (b.utilization ?? Infinity) - (a.utilization ?? Infinity)),
  };
}

/** Today through the Sunday ending the 12th week. */
export function defaultRange(today: Day): { from: Day; to: Day } {
  return { from: today, to: addDays(weekStart(today), 7 * 12 - 1) };
}

/**
 * Where the heat map's first period starts: the start of the earliest cycle that still
 * holds open work, even when that's in the past. Today when no open issue is in a cycle.
 */
export function planningStart(snapshot: Snapshot, today: Day): Day {
  const cycles = new Map(snapshot.cycles.map((c) => [c.id, c]));
  let start = today;
  for (const i of snapshot.issues) {
    if (!isOpen(i) || !i.cycleId) continue;
    const c = cycles.get(i.cycleId);
    if (!c || c.completedAt != null || c.endDate < today) continue;
    if (c.startDate < start) start = c.startDate;
  }
  return start;
}
