import { describe, expect, it } from 'vitest';
import { periodBuckets } from '../shared/calendar';
import { buildModel, defaultRange, emptyPlanner, summarizeTeam, teamWindow } from '../shared/capacity';
import { RISK_WEIGHTS, summarizeProjects } from '../shared/projects';
import type { Project, VelocityMode } from '../shared/types';
import { demoOooCsv, demoSnapshot } from '../server/demo/seed';
import { parseOooCsv } from '../server/ooo/csv';
import { fixture, issue, planner, TODAY } from './fixtures';

const range = { from: TODAY, to: '2026-11-29' };
const project = (patch: Partial<Project> = {}): Project => ({
  id: 'P',
  name: 'Project P',
  url: 'https://linear.app/x/project/p',
  targetDate: '2026-11-13',
  startDate: null,
  statusType: 'started',
  statusName: 'In Progress',
  health: null,
  progress: 0,
  leadId: null,
  teamIds: ['T'],
  ...patch,
});

describe('periodBuckets', () => {
  it('builds week periods aligned to Monday, clipped to today', () => {
    const b = periodBuckets('2026-10-28', 'week', 2, 3);
    expect(b.map((x) => [x.start, x.end, x.label])).toEqual([
      ['2026-10-28', '2026-11-08', 'Oct 26 – Nov 8'],
      ['2026-11-09', '2026-11-22', 'Nov 9 – Nov 22'],
      ['2026-11-23', '2026-12-06', 'Nov 23 – Dec 6'],
    ]);
  });

  it('builds months and quarters, including across a year boundary', () => {
    expect(periodBuckets('2026-11-15', 'month', 1, 3).map((x) => x.label)).toEqual(['Nov 2026', 'Dec 2026', 'Jan 2027']);
    expect(periodBuckets('2026-11-15', 'month', 2, 2).map((x) => [x.start, x.end, x.label])).toEqual([
      ['2026-11-15', '2026-12-31', 'Nov – Dec 2026'],
      ['2027-01-01', '2027-02-28', 'Jan – Feb 2027'],
    ]);
    expect(periodBuckets('2026-12-15', 'month', 2, 1)[0].label).toBe('Dec 2026 – Jan 2027');
    expect(periodBuckets('2026-11-15', 'quarter', 1, 2).map((x) => [x.start, x.end, x.label])).toEqual([
      ['2026-11-15', '2026-12-31', 'Q4 2026'],
      ['2027-01-01', '2027-03-31', 'Q1 2027'],
    ]);
  });
});

describe('velocity modes', () => {
  const build = (velocityMode: VelocityMode, p = planner()) => buildModel({ snapshot: fixture(), ooo: null, planner: p, range, today: TODAY, velocityMode });

  it('converts manual points per week to points per working day, so capacity scales with period length', () => {
    const m = build({ kind: 'manual', pointsPerWeek: 10 });
    expect(m.velocity.get('A')!).toMatchObject({ value: 2, source: 'manual' });
    const twoWeeks = m.personWindow('A', '2026-11-02', '2026-11-15').capacity;
    const fourWeeks = m.personWindow('A', '2026-11-02', '2026-11-29').capacity;
    expect(twoWeeks).toBe(20);
    expect(fourWeeks).toBe(2 * twoWeeks);
  });

  it('gives everyone their teams’ average in team-average mode and ignores per-person overrides outside history mode', () => {
    const m = build({ kind: 'team-average' }, planner({ velocityOverrides: { A: 9 } }));
    expect(m.velocity.get('A')!.source).toBe('team-average');
    expect(m.velocity.get('A')!.value).toBeCloseTo(1);
    expect(build({ kind: 'history' }, planner({ velocityOverrides: { A: 9 } })).velocity.get('A')!.value).toBe(9);
  });
});

describe('unscheduled project work', () => {
  it('spreads open project issues without a cycle from today to the target date', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 10, projectId: 'P' })], [project()]);
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY });
    const week1 = m.personWindow('A', '2026-11-02', '2026-11-08');
    expect(week1.loadByTeam.T.unscheduled).toBeCloseTo(5);
    expect(week1.items[0]).toMatchObject({ kind: 'unscheduled', cycleId: null, projectId: 'P' });
    expect(m.personWindow('A', '2026-11-16', '2026-11-22').loadByTeam.T.unscheduled).toBe(0);
  });

  it('puts overdue project work on the current week, and ignores projects without a target date', () => {
    const snap = fixture(
      [
        issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 5, projectId: 'P' }),
        issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 5, projectId: 'Q' }),
      ],
      [project({ targetDate: '2026-10-20' }), project({ id: 'Q', targetDate: null })],
    );
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY });
    const w = m.personWindow('A', '2026-11-02', '2026-11-08');
    expect(w.loadByTeam.T.unscheduled).toBeCloseTo(5);
    expect(w.items).toHaveLength(1);
    expect(w.items[0].overdue).toBe(true);
  });
});

describe('teamWindow', () => {
  it('matches the per-cycle team summary for the same window', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8 }), issue({ teamId: 'T', cycleId: 'c3', assigneeId: null, estimate: 3 })]);
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY });
    const c3 = summarizeTeam(m, 'T').cycles.find((c) => c.cycle.id === 'c3')!;
    const w = teamWindow(m, 'T', '2026-11-02', '2026-11-15');
    expect(w.capacity).toBeCloseTo(c3.capacity);
    expect(w.load).toBeCloseTo(c3.load);
    expect(w.unassigned).toBeCloseTo(3);
    expect(w.planned).toBeCloseTo(8);
  });
});

describe('project risk on the demo workspace', () => {
  const today = '2026-10-27';
  const snapshot = demoSnapshot(today, '2026-10-27T08:00:00.000Z');
  const ooo = parseOooCsv(demoOooCsv(today), 'demo-ooo.csv', snapshot.people);
  const risks = summarizeProjects(buildModel({ snapshot, ooo, planner: emptyPlanner(), range: defaultRange(today), today }));

  it('ranks API v2 first and high, driven by Ana’s vacation-time overload', () => {
    expect(risks[0].project.name).toBe('API v2 launch');
    expect(risks[0].level).toBe('high');
    expect(risks[0].drivers[0]).toMatch(/^Ana \d+% through Nov 20 \(7 OOO days\)/);
    for (let i = 1; i < risks.length; i++) expect(risks[i - 1].score).toBeGreaterThanOrEqual(risks[i].score);
  });

  it('counts teams and people and flags projects without a target date', () => {
    const billing = risks.find((r) => r.project.name === 'Billing revamp')!;
    expect(billing.teamIds.sort()).toEqual(['team-plt', 'team-web']);
    expect(billing.people.map((p) => p.personId)).toContain('u-dana');
    const obs = risks.find((r) => r.project.name === 'Observability')!;
    expect(obs.noTargetDate).toBe(true);
    expect(obs.drivers).toContain('No target date');
  });

  it('builds the score from weighted factors', () => {
    for (const r of risks) {
      expect(r.factors.map((f) => f.weight).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      expect(r.score).toBe(Math.round(r.factors.reduce((a, f) => a + f.contribution, 0)));
      for (const f of r.factors) expect(f.contribution).toBeCloseTo(RISK_WEIGHTS[f.key] * f.value * 100);
    }
    const api = risks[0];
    expect(api.latePoints).toBeGreaterThan(0);
    expect(api.unassignedPoints).toBe(3);
  });
});

describe('reserve detail', () => {
  it('exposes the inputs of the unplanned reserve, only for future cycles', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner({ unplannedBuffers: { T: 0.2 } }), range, today: TODAY });
    const future = m.personWindow('A', '2026-11-16', '2026-11-29');
    const d = future.reserveDetail.T;
    expect(d).toMatchObject({ days: 10, share: 1, buffer: 0.2, bufferSource: 'override' });
    expect(d.velocity * d.days * d.share * d.buffer).toBeCloseTo(future.loadByTeam.T.reserve);
    expect(d.points).toBeCloseTo(future.loadByTeam.T.reserve);
    expect(m.personWindow('A', '2026-11-02', '2026-11-15').reserveDetail).toEqual({});
  });
});
