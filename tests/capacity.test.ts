import { describe, expect, it } from 'vitest';
import { breakdown, buildModel, classify, summarizePeople, summarizeTeam, DEFAULT_SETTINGS } from '../shared/capacity';
import { fixture, issue, ooo, planner, TODAY } from './fixtures';

const range = { from: TODAY, to: '2026-11-29' };

describe('velocity', () => {
  it('measures points per available day from completed cycles', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner(), range, today: TODAY });
    const v = m.velocity.get('A')!;
    expect(v.source).toBe('history');
    expect(v.points).toBe(20);
    expect(v.availableDays).toBe(20);
    expect(v.value).toBeCloseTo(1);
    expect(v.cycles.map((c) => c.cycleId)).toEqual(['c1', 'c2']);
  });

  it('excludes past absences from the denominator', () => {
    const m = buildModel({ snapshot: fixture(), ooo: ooo([{ start: '2026-10-08', end: '2026-10-09' }]), planner: planner(), range, today: TODAY });
    const v = m.velocity.get('A')!;
    expect(v.oooDays).toBe(2);
    expect(v.value).toBeCloseTo(20 / 18);
  });

  it('falls back to team average, and honours overrides', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner({ velocityOverrides: {} }), range, today: TODAY });
    expect(m.velocity.get('B')!.source).toBe('team-average');
    expect(m.velocity.get('B')!.value).toBeCloseTo(1);
    const o = buildModel({ snapshot: fixture(), ooo: null, planner: planner({ velocityOverrides: { B: 0.5 } }), range, today: TODAY });
    expect(o.velocity.get('B')!.source).toBe('override');
    expect(o.velocity.get('B')!.value).toBe(0.5);
  });
});

describe('absences', () => {
  it('counts half days and caps overlapping company holidays at one day', () => {
    const data = ooo([
      { start: '2026-11-03', end: '2026-11-04', fraction: 0.5 },
      { email: '*', personId: null, start: '2026-11-04', end: '2026-11-04', type: 'holiday' },
    ]);
    const m = buildModel({ snapshot: fixture(), ooo: data, planner: planner(), range, today: TODAY });
    const w = m.personWindow('A', '2026-11-02', '2026-11-08');
    expect(w.workingDays).toBe(5);
    expect(w.oooDays).toBe(1.5);
    expect(w.capacity).toBeCloseTo(3.5);
    expect(w.oooEntries.map((e) => e.entryId).sort()).toEqual(['o1', 'o2']);
    // The company holiday applies to Bob too.
    expect(m.personWindow('B', '2026-11-02', '2026-11-08').oooDays).toBe(1);
  });

  it('ignores weekend absences and absences outside the window', () => {
    const data = ooo([{ start: '2026-11-07', end: '2026-11-08' }, { start: '2026-12-01', end: '2026-12-05' }]);
    const m = buildModel({ snapshot: fixture(), ooo: data, planner: planner(), range, today: TODAY });
    expect(m.personWindow('A', '2026-11-02', '2026-11-15').oooDays).toBe(0);
  });
});

describe('load', () => {
  it('spreads open issues over the cycle and splits planned from unplanned', () => {
    const snap = fixture([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 10, addedToCycleAt: '2026-11-02T09:00:00Z' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 2, addedToCycleAt: '2026-11-03T09:00:00Z' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8, stateType: 'completed' }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8, stateType: 'canceled' }),
    ]);
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner({ settings: { ...DEFAULT_SETTINGS, defaultUnplannedBuffer: 0 } }), range, today: TODAY });
    const week1 = m.personWindow('A', '2026-11-02', '2026-11-08');
    expect(week1.loadByTeam.T.planned).toBeCloseTo(5);
    expect(week1.loadByTeam.T.unplanned).toBeCloseTo(1);
    expect(week1.items).toHaveLength(2);
  });

  it('reserves the unplanned buffer on future cycles only', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner({ unplannedBuffers: { T: 0.2 } }), range, today: TODAY });
    expect(m.personWindow('A', '2026-11-02', '2026-11-15').loadByTeam.T.reserve).toBe(0);
    expect(m.personWindow('A', '2026-11-16', '2026-11-29').loadByTeam.T.reserve).toBeCloseTo(10 * 1 * 0.2);
  });

  it('counts unestimated issues at the team median and issues as 1 for teams without estimates', () => {
    const snap = fixture([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: null }),
      issue({ teamId: 'U', cycleId: 'u3', assigneeId: 'B', estimate: null }),
    ]);
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY });
    const a = m.personWindow('A', '2026-11-02', '2026-11-15').items[0];
    expect(a.unestimated).toBe(true);
    expect(a.fullPoints).toBe(5); // median of the fixture's estimates
    const b = m.personWindow('B', '2026-11-02', '2026-11-15').items[0];
    expect(b.unestimated).toBe(false);
    expect(b.fullPoints).toBe(1);
  });
});

describe('allocation and shared commitments', () => {
  const snap = fixture([
    issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'B', estimate: 3 }),
    issue({ teamId: 'U', cycleId: 'u3', assigneeId: 'B' }),
  ]);

  it('splits a shared person by scheduled work when there is no history', () => {
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY });
    const a = m.allocation.get('B')!;
    expect(a.source).toBe('planned');
    expect(a.shares.T).toBeCloseTo(0.75);
    expect(a.shares.U).toBeCloseTo(0.25);
  });

  it('reports other teams as shared commitments', () => {
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner({ settings: { ...DEFAULT_SETTINGS, defaultUnplannedBuffer: 0 } }), range, today: TODAY });
    const w = m.personWindow('B', '2026-11-02', '2026-11-15');
    const b = breakdown(w, 'T');
    expect(b.planned).toBeCloseTo(3);
    expect(b.shared).toBeCloseTo(1);
    expect(b.sharedByTeam).toEqual({ U: 1 });
  });

  it('uses allocation overrides for team capacity', () => {
    const m = buildModel({ snapshot: snap, ooo: null, planner: planner({ allocations: { B: { T: 1, U: 1 } } }), range, today: TODAY });
    expect(m.allocation.get('B')!.shares).toEqual({ T: 0.5, U: 0.5 });
    const t = summarizeTeam(m, 'T');
    const c3 = t.cycles.find((c) => c.cycle.id === 'c3')!;
    // A: 10 days × 1.0; B: 10 days × 1.0 × 50%
    expect(c3.capacity).toBeCloseTo(15);
    expect(c3.sharedLost).toBeCloseTo(5);
  });
});

describe('summaries', () => {
  it('classifies utilization with thresholds', () => {
    expect(classify(5, 10, DEFAULT_SETTINGS).status).toBe('under');
    expect(classify(9, 10, DEFAULT_SETTINGS).status).toBe('healthy');
    expect(classify(11, 10, DEFAULT_SETTINGS).status).toBe('at-risk');
    expect(classify(12, 10, DEFAULT_SETTINGS).status).toBe('over');
    expect(classify(1, 0, DEFAULT_SETTINGS).status).toBe('over');
    expect(classify(0, 0, DEFAULT_SETTINGS).status).toBe('none');
  });

  it('explains an overloaded person with absence and shared work', () => {
    const snap = fixture([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8 }),
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8 }),
    ]);
    const m = buildModel({ snapshot: snap, ooo: ooo([{ start: '2026-11-02', end: '2026-11-06' }]), planner: planner(), range: { from: TODAY, to: '2026-11-15' }, today: TODAY });
    const a = summarizePeople(m, null).find((p) => p.person.id === 'A')!;
    expect(a.total.status).toBe('over');
    expect(a.why[0]).toMatch(/5 OOO days \(vacation\)/);
    expect(a.why.some((w) => /planned Team T work alone/.test(w))).toBe(true);
    expect(a.weeks).toHaveLength(2);
  });

  it('never computes capacity before today', () => {
    const m = buildModel({ snapshot: fixture(), ooo: null, planner: planner(), range: { from: '2026-10-01', to: '2026-11-15' }, today: TODAY });
    expect(m.from).toBe(TODAY);
  });
});
