import {
  addDays,
  countWorkingDays,
  dayInTimezone,
  maxDay,
  minDay,
  overlap,
  weekBuckets,
  workingDays,
  weekStart,
  type Bucket,
} from './calendar';
import type { Cycle, Day, Issue, OooDataset, OooEntry, Person, PlannerState, Settings, Snapshot, Team } from './types';

// Capacity engine. Everything is computed in points (or issue counts for teams
// that don't estimate) from today forward, and every number keeps references to
// the issues, OOO rows and cycles it came from so the UI can show its evidence.

export type Status = 'none' | 'under' | 'healthy' | 'at-risk' | 'over';

export interface CapacityInput {
  snapshot: Snapshot;
  ooo: OooDataset | null;
  planner: PlannerState;
  range: { from: Day; to: Day };
  today: Day;
}

export interface VelocityInfo {
  value: number;
  source: 'history' | 'team-average' | 'default' | 'override';
  /** Velocity measured from the person's own history, even when not used. */
  historyValue: number | null;
  points: number;
  availableDays: number;
  oooDays: number;
  completedIssues: number;
  window: { start: Day; end: Day } | null;
  cycles: { cycleId: string; points: number }[];
  issueIds: string[];
}

export interface AllocationInfo {
  shares: Record<string, number>;
  source: 'override' | 'single-team' | 'history' | 'planned' | 'even';
  historyPoints: Record<string, number>;
  plannedPoints: Record<string, number>;
}

export interface UnplannedHistory {
  ratio: number | null;
  buffer: number;
  bufferSource: 'override' | 'default';
  cycles: { cycleId: string; total: number; unplanned: number; issueIds: string[] }[];
}

export interface LoadItem {
  issueId: string;
  teamId: string;
  cycleId: string;
  kind: 'planned' | 'unplanned';
  /** Points falling inside the window. */
  points: number;
  /** Points of the whole issue. */
  fullPoints: number;
  unestimated: boolean;
}

export interface TeamLoad {
  planned: number;
  unplanned: number;
  reserve: number;
}

export interface PersonWindow {
  start: Day;
  end: Day;
  workingDays: number;
  oooDays: number;
  oooEntries: { entryId: string; days: number }[];
  /** Capacity before absences. */
  gross: number;
  /** Capacity removed by absences. */
  absence: number;
  capacity: number;
  loadByTeam: Record<string, TeamLoad>;
  items: LoadItem[];
  load: number;
  utilization: number | null;
  status: Status;
}

export interface Breakdown {
  planned: number;
  unplanned: number;
  shared: number;
  sharedByTeam: Record<string, number>;
  absence: number;
  capacity: number;
  gross: number;
  load: number;
}

export interface PersonSummary {
  person: Person;
  focusTeamId: string | null;
  velocity: VelocityInfo;
  allocation: AllocationInfo;
  total: PersonWindow;
  breakdown: Breakdown;
  weeks: { bucket: Bucket; window: PersonWindow }[];
  why: string[];
}

export interface TeamCycleMember {
  personId: string;
  share: number;
  /** Allocated capacity for this team in the window. */
  capacity: number;
  teamLoad: number;
  otherTeamLoad: number;
  oooDays: number;
  /** Whole-person utilization across all teams in the window. */
  utilization: number | null;
  status: Status;
}

export interface TeamCycleSummary {
  cycle: Cycle;
  start: Day;
  end: Day;
  isActive: boolean;
  /** Members' whole working time, before absences and other teams. */
  fullGross: number;
  /** Capacity removed by members' absences (whole person). */
  fullAbsence: number;
  /** Allocated gross capacity (team share). */
  gross: number;
  /** Allocated capacity removed by absences. */
  absence: number;
  /** Members' available capacity that belongs to other teams. */
  sharedLost: number;
  capacity: number;
  planned: number;
  unplanned: number;
  reserve: number;
  unassigned: number;
  load: number;
  utilization: number | null;
  status: Status;
  unestimatedIssueIds: string[];
  linearStyleCapacity: number | null;
  members: TeamCycleMember[];
  issueIds: string[];
}

export interface TeamSummary {
  team: Team;
  cycles: TeamCycleSummary[];
  unplanned: UnplannedHistory;
  medianEstimate: number;
  avgCompletedPerCycle: number | null;
  totals: { capacity: number; load: number; net: number; cyclesAtRisk: number; peopleOver: number };
}

export interface CapacityModel {
  input: CapacityInput;
  /** Effective range: never before today. */
  from: Day;
  to: Day;
  teams: Map<string, Team>;
  people: Map<string, Person>;
  cycles: Map<string, Cycle>;
  issues: Map<string, Issue>;
  oooEntries: Map<string, OooEntry>;
  velocity: Map<string, VelocityInfo>;
  allocation: Map<string, AllocationInfo>;
  unplanned: Map<string, UnplannedHistory>;
  medianEstimate: Map<string, number>;
  avgCompletedPerCycle: Map<string, number | null>;
  pointsOf(issue: Issue): { points: number; unestimated: boolean };
  isCompletedCycle(cycle: Cycle): boolean;
  isActiveCycle(cycle: Cycle): boolean;
  completedCyclesOf(teamId: string): Cycle[];
  upcomingCyclesOf(teamId: string): Cycle[];
  personWindow(personId: string, start: Day, end: Day): PersonWindow;
  unplannedKind(issue: Issue): 'planned' | 'unplanned';
  teamName(teamId: string): string;
  cycleLabel(cycleId: string): string;
}

export const DEFAULT_SETTINGS: Settings = {
  workDays: [1, 2, 3, 4, 5],
  defaultVelocity: 1,
  lookbackCycles: 3,
  defaultUnplannedBuffer: 0.1,
  thresholds: { under: 0.7, atRisk: 1.0, over: 1.15 },
};

export function emptyPlanner(): PlannerState {
  return { settings: structuredClone(DEFAULT_SETTINGS), allocations: {}, velocityOverrides: {}, unplannedBuffers: {}, ledger: [], dismissed: [] };
}

const OPEN_STATES = new Set(['triage', 'backlog', 'unstarted', 'started']);

export function isOpen(issue: Issue): boolean {
  return OPEN_STATES.has(issue.stateType);
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

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildModel(input: CapacityInput): CapacityModel {
  const { snapshot, planner, today } = input;
  const settings = planner.settings;
  const workDays = settings.workDays;
  const from = maxDay(input.range.from, today);
  const to = input.range.to;

  const teams = new Map(snapshot.teams.map((t) => [t.id, t]));
  const people = new Map(snapshot.people.map((p) => [p.id, p]));
  const cycles = new Map(snapshot.cycles.map((c) => [c.id, c]));
  const issues = new Map(snapshot.issues.map((i) => [i.id, i]));
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
    return { total, byEntry, perDay };
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
    const usable = historyValue != null && count >= 3 && available >= 5;
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
    });
  }
  const teamAvgVelocity = new Map<string, number>();
  for (const t of snapshot.teams) {
    const vals = t.memberIds.map((id) => velocity.get(id)).filter((v) => v?.source === 'history').map((v) => v!.value);
    if (vals.length) teamAvgVelocity.set(t.id, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  for (const p of snapshot.people) {
    const v = velocity.get(p.id)!;
    if (v.source !== 'history') {
      const avgs = p.teamIds.map((t) => teamAvgVelocity.get(t)).filter((x): x is number => x != null);
      if (avgs.length) {
        v.value = avgs.reduce((a, b) => a + b, 0) / avgs.length;
        v.source = 'team-average';
      } else {
        v.value = settings.defaultVelocity;
        v.source = 'default';
      }
    }
    const override = planner.velocityOverrides[p.id];
    if (override != null) {
      v.value = override;
      v.source = 'override';
    }
  }

  // --- Spread of open work over working days -----------------------------
  interface Spread {
    issue: Issue;
    cycle: Cycle;
    start: Day;
    end: Day;
    days: number;
    points: number;
    unestimated: boolean;
    kind: 'planned' | 'unplanned';
    /** The remaining cycle has no working days; all points land on its last day. */
    noWorkDays: boolean;
  }
  const spreads: Spread[] = [];
  for (const i of snapshot.issues) {
    if (!i.cycleId || !isOpen(i)) continue;
    const c = cycles.get(i.cycleId);
    if (!c || isCompletedCycle(c)) continue;
    let start = maxDay(c.startDate, today);
    let days = countWorkingDays(start, c.endDate, workDays);
    const noWorkDays = days === 0;
    if (noWorkDays) {
      start = c.endDate;
      days = 1;
    }
    const { points, unestimated } = pointsOf(i);
    spreads.push({ issue: i, cycle: c, start, end: c.endDate, days, points, unestimated, kind: unplannedKind(i), noWorkDays });
  }
  const spreadsByAssignee = new Map<string | null, Spread[]>();
  for (const s of spreads) {
    const list = spreadsByAssignee.get(s.issue.assigneeId) ?? [];
    list.push(s);
    spreadsByAssignee.set(s.issue.assigneeId, list);
  }
  const portion = (s: Spread, start: Day, end: Day) => {
    const ov = overlap(start, end, s.start, s.end);
    if (!ov) return 0;
    const wd = s.noWorkDays ? 1 : countWorkingDays(ov[0], ov[1], workDays);
    return (s.points * wd) / s.days;
  };

  // --- Allocation --------------------------------------------------------
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
    const override = planner.allocations[p.id];
    if (override && teamIds.some((t) => override[t] != null)) {
      const total = teamIds.reduce((a, t) => a + (override[t] ?? 0), 0) || 1;
      info = { shares: Object.fromEntries(teamIds.map((t) => [t, (override[t] ?? 0) / total])), source: 'override', historyPoints, plannedPoints };
    } else if (teamIds.length <= 1) {
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

  // --- Unplanned history and team history --------------------------------
  const unplanned = new Map<string, UnplannedHistory>();
  const avgCompletedPerCycle = new Map<string, number | null>();
  for (const t of snapshot.teams) {
    const hist: UnplannedHistory['cycles'] = [];
    let total = 0;
    let unpl = 0;
    let completedSum = 0;
    const completed = completedCyclesOf(t.id);
    for (const c of completed) {
      let ct = 0;
      let cu = 0;
      const ids: string[] = [];
      for (const i of issuesByCycle.get(c.id) ?? []) {
        if (i.stateType === 'canceled') continue;
        const pts = pointsOf(i).points;
        ct += pts;
        if (i.stateType === 'completed') completedSum += pts;
        if (unplannedKind(i) === 'unplanned') {
          cu += pts;
          ids.push(i.id);
        }
      }
      hist.push({ cycleId: c.id, total: ct, unplanned: cu, issueIds: ids });
      total += ct;
      unpl += cu;
    }
    const override = planner.unplannedBuffers[t.id];
    unplanned.set(t.id, {
      ratio: total > 0 ? unpl / total : null,
      buffer: override ?? settings.defaultUnplannedBuffer,
      bufferSource: override != null ? 'override' : 'default',
      cycles: hist.reverse(),
    });
    avgCompletedPerCycle.set(t.id, completed.length ? completedSum / completed.length : null);
  }

  const futureCycleOn = (teamId: string, day: Day) =>
    (cyclesByTeam.get(teamId) ?? []).find((c) => c.startDate <= day && day <= c.endDate && c.startDate > today);

  // --- Person window -----------------------------------------------------
  const personWindow = (personId: string, start: Day, end: Day): PersonWindow => {
    const person = people.get(personId)!;
    const v = velocity.get(personId)!;
    const alloc = allocation.get(personId)!;
    const wdays = workingDays(start, end, workDays);
    const ooo = oooIn(personId, start, end);
    const gross = v.value * wdays.length;
    const absence = v.value * ooo.total;
    const capacity = gross - absence;
    const loadByTeam: Record<string, TeamLoad> = {};
    const bucket = (t: string) => (loadByTeam[t] ??= { planned: 0, unplanned: 0, reserve: 0 });
    for (const t of person.teamIds) bucket(t);
    const items: LoadItem[] = [];
    for (const s of spreadsByAssignee.get(personId) ?? []) {
      const pts = portion(s, start, end);
      if (pts <= 0) continue;
      bucket(s.issue.teamId)[s.kind] += pts;
      items.push({ issueId: s.issue.id, teamId: s.issue.teamId, cycleId: s.cycle.id, kind: s.kind, points: pts, fullPoints: s.points, unestimated: s.unestimated });
    }
    for (const t of person.teamIds) {
      const buffer = unplanned.get(t)?.buffer ?? 0;
      const share = alloc.shares[t] ?? 0;
      if (!buffer || !share) continue;
      let reserve = 0;
      for (const d of wdays) {
        if (!futureCycleOn(t, d)) continue;
        reserve += v.value * (1 - (ooo.perDay.get(d) ?? 0)) * share * buffer;
      }
      bucket(t).reserve += reserve;
    }
    const load = Object.values(loadByTeam).reduce((a, l) => a + l.planned + l.unplanned + l.reserve, 0);
    return { start, end, workingDays: wdays.length, oooDays: ooo.total, oooEntries: ooo.byEntry, gross, absence, capacity, loadByTeam, items, load, ...classify(load, capacity, settings) };
  };

  const teamName = (teamId: string) => teams.get(teamId)?.name ?? 'Unknown team';
  const cycleLabel = (cycleId: string) => {
    const c = cycles.get(cycleId);
    return c ? cycleName(c, teams.get(c.teamId)) : 'Unknown cycle';
  };

  return {
    input,
    from,
    to,
    teams,
    people,
    cycles,
    issues,
    oooEntries,
    velocity,
    allocation,
    unplanned,
    medianEstimate,
    avgCompletedPerCycle,
    pointsOf,
    isCompletedCycle,
    isActiveCycle,
    completedCyclesOf,
    upcomingCyclesOf,
    personWindow,
    unplannedKind,
    teamName,
    cycleLabel,
  };
}

// ---------------------------------------------------------------------------
// Team view

export function summarizeTeam(model: CapacityModel, teamId: string): TeamSummary {
  const team = model.teams.get(teamId)!;
  const settings = model.input.planner.settings;
  const out: TeamCycleSummary[] = [];
  const peopleOver = new Set<string>();
  for (const cycle of model.upcomingCyclesOf(teamId)) {
    const ov = overlap(cycle.startDate, cycle.endDate, model.from, model.to);
    if (!ov) continue;
    const [start, end] = ov;
    let fullGross = 0;
    let fullAbsence = 0;
    let gross = 0;
    let absence = 0;
    let sharedLost = 0;
    let reserve = 0;
    const members: TeamCycleMember[] = [];
    for (const pid of team.memberIds) {
      const person = model.people.get(pid);
      if (!person?.active) continue;
      const w = model.personWindow(pid, start, end);
      const share = model.allocation.get(pid)!.shares[teamId] ?? 0;
      fullGross += w.gross;
      fullAbsence += w.absence;
      gross += w.gross * share;
      absence += w.absence * share;
      sharedLost += w.capacity * (1 - share);
      reserve += w.loadByTeam[teamId]?.reserve ?? 0;
      const teamLoad = w.items.filter((i) => i.teamId === teamId && i.cycleId === cycle.id).reduce((a, i) => a + i.points, 0);
      members.push({
        personId: pid,
        share,
        capacity: w.capacity * share,
        teamLoad,
        otherTeamLoad: w.load - teamLoad - (w.loadByTeam[teamId]?.reserve ?? 0),
        oooDays: w.oooDays,
        utilization: w.utilization,
        status: w.status,
      });
      if (w.status === 'over') peopleOver.add(pid);
    }
    // Team load: every open issue in this cycle, prorated to the window.
    let planned = 0;
    let unplanned = 0;
    let unassigned = 0;
    const unestimatedIssueIds: string[] = [];
    const issueIds: string[] = [];
    const fullDays = countWorkingDays(maxDay(cycle.startDate, model.input.today), cycle.endDate, settings.workDays);
    const windowDays = countWorkingDays(start, end, settings.workDays);
    const factor = fullDays === 0 ? 1 : Math.min(1, windowDays / fullDays);
    for (const issue of model.issues.values()) {
      if (issue.cycleId !== cycle.id || !isOpen(issue)) continue;
      issueIds.push(issue.id);
      const { points, unestimated } = model.pointsOf(issue);
      if (unestimated) unestimatedIssueIds.push(issue.id);
      const pts = points * factor;
      if (!issue.assigneeId) unassigned += pts;
      else if (model.unplannedKind(issue) === 'unplanned') unplanned += pts;
      else planned += pts;
    }
    const capacity = gross - absence;
    const load = planned + unplanned + unassigned + reserve;
    const avg = model.avgCompletedPerCycle.get(teamId);
    const cycleDays = countWorkingDays(cycle.startDate, cycle.endDate, settings.workDays) || 1;
    out.push({
      cycle,
      start,
      end,
      isActive: model.isActiveCycle(cycle),
      fullGross,
      fullAbsence,
      gross,
      absence,
      sharedLost,
      capacity,
      planned,
      unplanned,
      reserve,
      unassigned,
      load,
      ...classify(load, capacity, settings),
      unestimatedIssueIds,
      linearStyleCapacity: avg != null ? (avg * windowDays) / cycleDays : null,
      members: members.sort((a, b) => (b.utilization ?? Infinity) - (a.utilization ?? Infinity)),
      issueIds,
    });
  }
  const capacity = out.reduce((a, c) => a + c.capacity, 0);
  const load = out.reduce((a, c) => a + c.load, 0);
  return {
    team,
    cycles: out,
    unplanned: model.unplanned.get(teamId)!,
    medianEstimate: model.medianEstimate.get(teamId) ?? 2,
    avgCompletedPerCycle: model.avgCompletedPerCycle.get(teamId) ?? null,
    totals: {
      capacity,
      load,
      net: capacity - load,
      cyclesAtRisk: out.filter((c) => c.status === 'at-risk' || c.status === 'over').length,
      peopleOver: peopleOver.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Individual view

export function breakdown(window: PersonWindow, focusTeamId: string | null): Breakdown {
  const sharedByTeam: Record<string, number> = {};
  let planned = 0;
  let unplanned = 0;
  for (const [teamId, l] of Object.entries(window.loadByTeam)) {
    if (teamId === focusTeamId) {
      planned += l.planned;
      unplanned += l.unplanned + l.reserve;
    } else {
      const total = l.planned + l.unplanned + l.reserve;
      if (total > 0) sharedByTeam[teamId] = total;
    }
  }
  const shared = Object.values(sharedByTeam).reduce((a, b) => a + b, 0);
  return { planned, unplanned, shared, sharedByTeam, absence: window.absence, capacity: window.capacity, gross: window.gross, load: window.load };
}

export function focusTeamFor(model: CapacityModel, personId: string, teamFilter: string | null): string | null {
  const person = model.people.get(personId)!;
  if (teamFilter && person.teamIds.includes(teamFilter)) return teamFilter;
  const shares = model.allocation.get(personId)!.shares;
  return [...person.teamIds].sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0))[0] ?? null;
}

export function explain(model: CapacityModel, w: PersonWindow, b: Breakdown, focusTeamId: string | null): string[] {
  const why: string[] = [];
  const pts = (n: number) => `${round1(n)} pts`;
  if (w.oooDays > 0 && w.absence >= 0.1 * w.gross) {
    const types = [...new Set(w.oooEntries.map((e) => model.oooEntries.get(e.entryId)?.type).filter(Boolean))];
    why.push(`${round1(w.oooDays)} OOO day${w.oooDays === 1 ? '' : 's'}${types.length ? ` (${types.join(', ')})` : ''} removes ${pts(w.absence)} of capacity`);
  }
  for (const [teamId, p] of Object.entries(b.sharedByTeam).sort((a, b2) => b2[1] - a[1])) {
    why.push(`${pts(p)} committed to ${model.teamName(teamId)}`);
  }
  const actualUnplanned = Object.values(w.loadByTeam).reduce((a, l) => a + l.unplanned, 0);
  if (actualUnplanned > 0) why.push(`${pts(actualUnplanned)} added mid-cycle (unplanned)`);
  const reserve = Object.values(w.loadByTeam).reduce((a, l) => a + l.reserve, 0);
  if (reserve > 0.5) why.push(`${pts(reserve)} reserved for unplanned work`);
  if (focusTeamId && w.capacity > 0 && b.planned > w.capacity) {
    why.push(`planned ${model.teamName(focusTeamId)} work alone is ${Math.round((b.planned / w.capacity) * 100)}% of capacity`);
  }
  const unestimated = w.items.filter((i) => i.unestimated);
  if (unestimated.length) why.push(`${unestimated.length} unestimated issue${unestimated.length === 1 ? '' : 's'} counted at team median`);
  return why;
}

export function summarizePeople(model: CapacityModel, teamFilter: string | null): PersonSummary[] {
  const buckets = weekBuckets(model.from, model.to);
  const out: PersonSummary[] = [];
  for (const person of model.people.values()) {
    if (!person.active) continue;
    if (teamFilter && !person.teamIds.includes(teamFilter)) continue;
    if (!person.teamIds.length) continue;
    const focusTeamId = focusTeamFor(model, person.id, teamFilter);
    const total = model.personWindow(person.id, model.from, model.to);
    const b = breakdown(total, focusTeamId);
    out.push({
      person,
      focusTeamId,
      velocity: model.velocity.get(person.id)!,
      allocation: model.allocation.get(person.id)!,
      total,
      breakdown: b,
      weeks: buckets.map((bucket) => ({ bucket, window: model.personWindow(person.id, bucket.start, bucket.end) })),
      why: explain(model, total, b, focusTeamId),
    });
  }
  return out.sort((a, b) => (b.total.utilization ?? Infinity) - (a.total.utilization ?? Infinity));
}

/** Today through the Sunday ending the 12th week. */
export function defaultRange(today: Day): { from: Day; to: Day } {
  return { from: today, to: addDays(weekStart(today), 7 * 12 - 1) };
}
