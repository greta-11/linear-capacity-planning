import { addDays, countWorkingDays, diffDays, formatShort, weekStart } from './calendar';
import { isOpen, round1, type CapacityModel, type Status } from './capacity';
import type { Day, Project } from './types';

// Project delivery risk, built from the capacity of the people doing the work.
// Every factor is a 0..1 value with a fixed weight, so the score is explainable:
//   score = 100 × Σ weight × factor   (overdue with open work = 100)
//   high ≥ 50, medium ≥ 25

export type RiskLevel = 'high' | 'medium' | 'low';
export type RiskFactorKey = 'pressure' | 'late' | 'unassigned' | 'unestimated';

// Capacity pressure dominates: a project whose people are well over capacity is at risk
// even when everything is assigned, estimated and scheduled before the target.
export const RISK_WEIGHTS: Record<RiskFactorKey, number> = { pressure: 0.6, late: 0.2, unassigned: 0.12, unestimated: 0.08 };
/** Utilization where capacity pressure starts counting, and the span over which it reaches 1. */
export const PRESSURE_START = 0.85;
export const PRESSURE_SPAN = 0.5;
const NO_TARGET_WEEKS = 12;

export interface RiskFactor {
  key: RiskFactorKey;
  label: string;
  weight: number;
  value: number;
  /** weight × value × 100: this factor's share of the score. */
  contribution: number;
  detail: string;
}

export interface ProjectPerson {
  personId: string;
  /** Open project points assigned to this person. */
  projectPoints: number;
  /** Everything on their plate (all projects and teams) from today to the target date. */
  load: number;
  capacity: number;
  utilization: number | null;
  status: Status;
  oooDays: number;
  pressure: number;
}

export interface ProjectRisk {
  project: Project;
  score: number;
  level: RiskLevel;
  overdue: boolean;
  noTargetDate: boolean;
  /** End of the window the risk is measured over: the target date, or 12 weeks out. */
  windowEnd: Day;
  daysLeft: number | null;
  workingDaysLeft: number;
  remainingPoints: number;
  openIssueIds: string[];
  unassignedPoints: number;
  unestimatedPoints: number;
  latePoints: number;
  lateIssueIds: string[];
  teamIds: string[];
  people: ProjectPerson[];
  factors: RiskFactor[];
  drivers: string[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const pts = (n: number) => `${round1(n)} pts`;

export function levelOf(score: number): RiskLevel {
  return score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
}

export function summarizeProjects(model: CapacityModel): ProjectRisk[] {
  const today = model.input.today;
  const workDays = model.input.planner.settings.workDays;
  const out: ProjectRisk[] = [];

  for (const project of model.projects.values()) {
    const noTargetDate = !project.targetDate;
    const target = project.targetDate ?? addDays(weekStart(today), 7 * NO_TARGET_WEEKS - 1);
    const overdue = !noTargetDate && target < today;
    const windowEnd = overdue ? today : target;

    const open = [...model.issues.values()].filter((i) => i.projectId === project.id && isOpen(i));
    let remainingPoints = 0;
    let unassignedPoints = 0;
    let unestimatedPoints = 0;
    let latePoints = 0;
    const lateIssueIds: string[] = [];
    const byPerson = new Map<string, number>();
    const teamIds = new Set(project.teamIds);
    for (const issue of open) {
      const { points, unestimated } = model.pointsOf(issue);
      remainingPoints += points;
      teamIds.add(issue.teamId);
      if (unestimated) unestimatedPoints += points;
      if (!issue.assigneeId) unassignedPoints += points;
      else byPerson.set(issue.assigneeId, (byPerson.get(issue.assigneeId) ?? 0) + points);
      const cycle = issue.cycleId ? model.cycles.get(issue.cycleId) : undefined;
      if (!noTargetDate && cycle && cycle.endDate > target) {
        latePoints += points;
        lateIssueIds.push(issue.id);
      }
    }

    const people: ProjectPerson[] = [...byPerson.entries()].map(([personId, projectPoints]) => {
      const w = model.personWindow(personId, today, windowEnd);
      const u = w.utilization ?? (w.load > 0 ? Infinity : 0);
      return {
        personId,
        projectPoints,
        load: w.load,
        capacity: w.capacity,
        utilization: w.utilization,
        status: w.status,
        oooDays: w.oooDays,
        pressure: clamp01((u - PRESSURE_START) / PRESSURE_SPAN),
      };
    });
    people.sort((a, b) => b.pressure - a.pressure || b.projectPoints - a.projectPoints);

    const assigned = remainingPoints - unassignedPoints;
    const pressure = assigned > 0 ? people.reduce((a, p) => a + p.pressure * p.projectPoints, 0) / assigned : 0;
    const share = (n: number) => (remainingPoints > 0 ? n / remainingPoints : 0);
    const name = (id: string) => model.people.get(id)?.displayName ?? 'Unknown';
    const through = formatShort(windowEnd);
    const overloaded = people.filter((p) => p.pressure > 0);

    const values: Record<RiskFactorKey, { label: string; value: number; detail: string }> = {
      pressure: {
        label: 'Capacity pressure',
        value: pressure,
        detail: assigned
          ? overloaded.length
            ? `${overloaded.length} of ${people.length} people are above ${pct(PRESSURE_START)} of their capacity through ${through} (all their work, not just this project); weighted by their share of the project's points.`
            : `Everyone on it stays under ${pct(PRESSURE_START)} of their capacity through ${through}.`
          : 'No assigned work to measure.',
      },
      late: {
        label: 'Scheduled after target',
        value: share(latePoints),
        detail: noTargetDate ? 'No target date to compare against.' : `${pts(latePoints)} of ${pts(remainingPoints)} sit in cycles that end after ${formatShort(target)}.`,
      },
      unassigned: { label: 'Unassigned', value: share(unassignedPoints), detail: `${pts(unassignedPoints)} of ${pts(remainingPoints)} have no assignee, so no one's capacity covers them.` },
      unestimated: { label: 'Unestimated', value: share(unestimatedPoints), detail: `${pts(unestimatedPoints)} of ${pts(remainingPoints)} are unestimated and counted at the team median.` },
    };
    const factors: RiskFactor[] = (Object.keys(RISK_WEIGHTS) as RiskFactorKey[]).map((key) => ({
      key,
      ...values[key],
      weight: RISK_WEIGHTS[key],
      contribution: RISK_WEIGHTS[key] * values[key].value * 100,
    }));
    const raw = factors.reduce((a, f) => a + f.contribution, 0);
    const score = remainingPoints === 0 ? 0 : overdue ? 100 : Math.round(raw);

    const drivers: string[] = [];
    if (overdue) drivers.push(`Target date ${formatShort(target)} has passed with ${pts(remainingPoints)} open`);
    for (const p of overloaded.slice(0, 2)) {
      drivers.push(`${name(p.personId)} ${p.utilization == null ? 'fully out' : pct(p.utilization)} through ${through}${p.oooDays >= 1 ? ` (${round1(p.oooDays)} OOO days)` : ''}`);
    }
    if (latePoints > 0) drivers.push(`${pts(latePoints)} scheduled after target`);
    if (unassignedPoints > 0) drivers.push(`${pts(unassignedPoints)} unassigned`);
    if (unestimatedPoints > 0 && drivers.length < 3) drivers.push(`${pts(unestimatedPoints)} unestimated`);
    if (noTargetDate) drivers.push('No target date');

    out.push({
      project,
      score,
      level: levelOf(score),
      overdue,
      noTargetDate,
      windowEnd,
      daysLeft: noTargetDate ? null : diffDays(today, target),
      workingDaysLeft: countWorkingDays(today, windowEnd, workDays),
      remainingPoints,
      openIssueIds: open.map((i) => i.id),
      unassignedPoints,
      unestimatedPoints,
      latePoints,
      lateIssueIds,
      teamIds: [...teamIds],
      people,
      factors,
      drivers,
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.project.targetDate ?? '9999').localeCompare(b.project.targetDate ?? '9999'));
}
