import { describe, expect, it } from 'vitest';
import { periodBuckets } from '../shared/calendar';
import { buildModel, classify, DEFAULT_SETTINGS, teamWindow } from '../shared/capacity';
import type { Project, VelocityMode } from '../shared/types';
import { fixture, issue, ooo, planner, TODAY } from './fixtures';

const range = { from: TODAY, to: '2026-11-29' };
const build = (snap = fixture(), opts: { bufferPct?: number; velocityMode?: VelocityMode; ooo?: ReturnType<typeof ooo> } = {}) =>
  buildModel({ snapshot: snap, ooo: opts.ooo ?? null, planner: planner(), range, today: TODAY, bufferPct: opts.bufferPct ?? 0, velocityMode: opts.velocityMode });
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

describe('velocity', () => {
  it('measures points per available day from completed cycles, excluding past OOO', () => {
    expect(build().velocity.get('A')!).toMatchObject({ source: 'history', points: 20, availableDays: 20, value: 1 });
    const v = build(fixture(), { ooo: ooo([{ start: '2026-10-08', end: '2026-10-09' }]) }).velocity.get('A')!;
    expect(v.oooDays).toBe(2);
    expect(v.value).toBeCloseTo(20 / 18);
  });

  it('falls back to the team average of members with a velocity above zero, and says so', () => {
    // C has completed issues worth 0 points: no usable velocity, and not part of the average.
    const snap = fixture([0, 0, 0].map(() => issue({ teamId: 'T', cycleId: 'c2', assigneeId: 'C', estimate: 0, stateType: 'completed' })));
    snap.people.push({ id: 'C', name: 'Cy C', displayName: 'Cy', email: 'cy@x.dev', avatarUrl: null, active: true, teamIds: ['T'] });
    snap.teams[0].memberIds.push('C');
    const m = build(snap);
    for (const id of ['B', 'C']) {
      const v = m.velocity.get(id)!;
      expect(v.source).toBe('team-average');
      expect(v.value).toBeCloseTo(1); // A's 1.0 only; C's zero is excluded
      expect(v.fallbackNote).toMatch(/Not enough history .* using Team T team average, 5 pts\/wk/);
    }
    expect(m.velocity.get('A')!.fallbackNote).toBeNull();
  });

  it('supports team-average and manual points-per-week modes', () => {
    expect(build(fixture(), { velocityMode: { kind: 'team-average' } }).velocity.get('B')!).toMatchObject({ source: 'team-average', value: 1 });
    const m = build(fixture(), { velocityMode: { kind: 'manual', pointsPerWeek: 10 } });
    expect(m.velocity.get('A')!).toMatchObject({ source: 'manual', value: 2 });
    expect(m.personWindow('A', '2026-11-02', '2026-11-29').baseline).toBe(2 * m.personWindow('A', '2026-11-02', '2026-11-15').baseline);
  });
});

describe('capacity formula', () => {
  it('computes baseline → available (OOO share) → plannable (buffer) → utilization, in that order', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 6 })]);
    const m = build(snap, { bufferPct: 0.2, ooo: ooo([{ start: '2026-11-02', end: '2026-11-03' }]) });
    const w = m.personWindow('A', '2026-11-02', '2026-11-15');
    expect(w.baseline).toBe(10); // 1 pt/day × 10 working days
    expect(w.oooShare).toBeCloseTo(0.2); // 2 of 10 days
    expect(w.available).toBeCloseTo(8); // 10 × (1 − 0.2)
    expect(w.plannable).toBeCloseTo(6.4); // 8 × (1 − 0.2)
    expect(w.load).toBeCloseTo(6);
    expect(w.utilization).toBeCloseTo(6 / 6.4);
  });

  it('counts half days and caps overlapping company holidays at one day', () => {
    const data = ooo([
      { start: '2026-11-03', end: '2026-11-04', fraction: 0.5 },
      { email: '*', personId: null, start: '2026-11-04', end: '2026-11-04', type: 'holiday' },
    ]);
    const m = build(fixture(), { ooo: data });
    expect(m.personWindow('A', '2026-11-02', '2026-11-08').oooDays).toBe(1.5);
    expect(m.personWindow('B', '2026-11-02', '2026-11-08').oooDays).toBe(1);
  });

  it('classifies utilization with thresholds', () => {
    expect(classify(5, 10, DEFAULT_SETTINGS).status).toBe('under');
    expect(classify(9, 10, DEFAULT_SETTINGS).status).toBe('healthy');
    expect(classify(11, 10, DEFAULT_SETTINGS).status).toBe('at-risk');
    expect(classify(12, 10, DEFAULT_SETTINGS).status).toBe('over');
    expect(classify(1, 0, DEFAULT_SETTINGS).status).toBe('over');
  });

  it('counts capacity from the start of the range, even before today', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner(), range: { from: '2026-10-26', to: '2026-11-15' }, today: TODAY });
    expect(m.from).toBe('2026-10-26');
    expect(m.personWindow('A', '2026-10-26', '2026-11-08').workingDays).toBe(10);
  });
});

describe('load', () => {
  it('weights remaining work by status: Todo 100%, In Progress 50%, In Review 25%', () => {
    const snap = fixture([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'unstarted', stateName: 'Todo' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'started', stateName: 'In Progress' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'started', stateName: 'In Review' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'completed' }),
    ]);
    const w = build(snap).personWindow('A', '2026-11-02', '2026-11-15');
    expect(w.items.map((i) => i.weight).sort()).toEqual([0.25, 0.5, 1]);
    expect(w.load).toBeCloseTo(4 + 2 + 1);
  });

  it('spreads cycle work over the cycle and splits planned from added mid-cycle', () => {
    const snap = fixture([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 10, addedToCycleAt: '2026-11-02T09:00:00Z' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 2, addedToCycleAt: '2026-11-03T09:00:00Z' }),
    ]);
    const week1 = build(snap).personWindow('A', '2026-11-02', '2026-11-08');
    expect(week1.loadByTeam.T.planned).toBeCloseTo(5);
    expect(week1.loadByTeam.T.unplanned).toBeCloseTo(1);
  });

  it('spreads unscheduled work to its due date, else its project target; no date means no load', () => {
    const snap = fixture(
      [
        issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 10, projectId: 'P' }), // to project target Nov 13
        issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 4, dueDate: '2026-11-06', projectId: 'P' }), // due date wins
        issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 5 }), // no date: not load
      ],
      [project()],
    );
    const m = build(snap);
    const w = m.personWindow('A', '2026-11-02', '2026-11-08');
    expect(w.loadByTeam.T.unscheduled).toBeCloseTo(5 + 4);
    expect(w.items.map((i) => i.dateSource).sort()).toEqual(['due', 'project']);
    expect(m.personWindow('A', '2026-11-16', '2026-11-22').load).toBe(0);
  });

  it('puts overdue unscheduled work on the current week', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: null, assigneeId: 'A', estimate: 5, dueDate: '2026-10-20' })]);
    const w = build(snap).personWindow('A', '2026-11-02', '2026-11-08');
    expect(w.load).toBeCloseTo(5);
    expect(w.items[0].overdue).toBe(true);
  });

  it('counts unestimated issues at the team median and issues as 1 for teams without estimates', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: null }), issue({ teamId: 'U', cycleId: 'u3', assigneeId: 'B', estimate: null })]);
    const m = build(snap);
    expect(m.personWindow('A', '2026-11-02', '2026-11-15').items[0]).toMatchObject({ unestimated: true, fullPoints: 5 });
    expect(m.personWindow('B', '2026-11-02', '2026-11-15').items[0]).toMatchObject({ unestimated: false, fullPoints: 1 });
  });
});

describe('teams and projects', () => {
  it('splits a shared person by scheduled work and reports their plannable time per team', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'B', estimate: 3 }), issue({ teamId: 'U', cycleId: 'u3', assigneeId: 'B' })]);
    const m = build(snap, { bufferPct: 0.1 });
    expect(m.allocation.get('B')!).toMatchObject({ source: 'planned', shares: { T: 0.75, U: 0.25 } });
    const t = teamWindow(m, 'T', '2026-11-02', '2026-11-15');
    // A has no work in range, so only B counts: 10 available × 75% → 7.5, 10% buffer → 6.75 plannable
    expect(t.available).toBeCloseTo(7.5);
    expect(t.plannable).toBeCloseTo(6.75);
    expect(t.sharedLost).toBeCloseTo(2.5);
    expect(t.load).toBeCloseTo(3);
  });

  it('leaves out people with no planned work in the range (0% everywhere): no capacity, no row', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c4', assigneeId: 'B', estimate: 3 })]);
    const m = build(snap);
    expect([...m.idlePeople]).toEqual(['A']);
    expect(m.inPlan('A')).toBe(false);
    expect(m.inPlan('B')).toBe(true);
    // B's only work is in c4, but anywhere in the range is enough to count in c3 too.
    expect(teamWindow(m, 'T', '2026-11-02', '2026-11-15').members.map((x) => x.personId)).toEqual(['B']);
    // With work, A counts again.
    const busy = build(fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 1 })]));
    expect(busy.inPlan('A')).toBe(true);
  });

  it('breaks team load down by project, including unassigned work', () => {
    const snap = fixture(
      [
        issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, projectId: 'P' }),
        issue({ teamId: 'T', cycleId: 'c3', assigneeId: null, estimate: 2, projectId: 'P' }),
        issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 3 }),
      ],
      [project()],
    );
    const t = teamWindow(build(snap), 'T', '2026-11-02', '2026-11-15');
    expect(t.byProject.P.points).toBeCloseTo(6);
    expect(t.byProject.none.points).toBeCloseTo(3);
    expect(t.unassigned).toBeCloseTo(2);
    expect(Object.values(t.byProject).reduce((a, p) => a + p.points, 0)).toBeCloseTo(t.load);
  });
});

describe('periodBuckets', () => {
  it('starts at the anchor: weeks step from it, months and quarters end on calendar boundaries', () => {
    expect(periodBuckets('2026-10-15', 'week', 2, 2).map((x) => [x.start, x.end, x.label])).toEqual([
      ['2026-10-15', '2026-10-28', 'Oct 15 – Oct 28'],
      ['2026-10-29', '2026-11-11', 'Oct 29 – Nov 11'],
    ]);
    expect(periodBuckets('2026-10-15', 'month', 1, 3).map((x) => [x.start, x.end, x.label])).toEqual([
      ['2026-10-15', '2026-10-31', 'Oct 2026'],
      ['2026-11-01', '2026-11-30', 'Nov 2026'],
      ['2026-12-01', '2026-12-31', 'Dec 2026'],
    ]);
    expect(periodBuckets('2026-12-15', 'month', 2, 1)[0].label).toBe('Dec 2026 – Jan 2027');
    expect(periodBuckets('2026-11-15', 'quarter', 1, 2).map((x) => [x.start, x.label])).toEqual([
      ['2026-11-15', 'Q4 2026'],
      ['2027-01-01', 'Q1 2027'],
    ]);
  });
});
