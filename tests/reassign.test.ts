import { describe, expect, it } from 'vitest';
import { periodBuckets } from '../shared/calendar';
import { buildModel, defaultRange } from '../shared/capacity';
import { planReassignments } from '../shared/reassign';
import type { Cycle, Issue, Person, Snapshot } from '../shared/types';
import { demoOooCsv, demoSnapshot } from '../server/demo/seed';
import { parseOooCsv } from '../server/ooo/csv';
import { issue, ooo, planner, TODAY } from './fixtures';

// Team R: Pat (over), Quinn (has room), Sam (on team S only, has room).
// Every person completed 20 pts over the last two cycles → 1 pt/day → 10 pts per 2-week period.

const cycle = (id: string, teamId: string, startDate: string, endDate: string, done = false): Cycle => ({
  id,
  teamId,
  number: Number(id.slice(-1)),
  name: null,
  startDate,
  endDate,
  completedAt: done ? `${endDate}T23:00:00Z` : null,
});
const person = (id: string, teamIds: string[]): Person => ({ id, name: `${id} Person`, displayName: id, email: `${id}@x.dev`, avatarUrl: null, active: true, teamIds });

function workspace(work: Issue[]): Snapshot {
  const history = ['Pat', 'Quinn', 'Sam'].flatMap((p) =>
    [0, 1, 2, 3].map(() => issue({ teamId: p === 'Sam' ? 'S' : 'R', cycleId: p === 'Sam' ? 's1' : 'r1', assigneeId: p, estimate: 5, stateType: 'completed' })),
  );
  return {
    source: 'demo',
    organizationName: 'Test',
    urlKey: 'x',
    fetchedAt: '2026-11-02T08:00:00.000Z',
    teams: [
      { id: 'R', key: 'R', name: 'Team R', cyclesEnabled: true, cycleDuration: 2, estimationType: 'fibonacci', timezone: 'UTC', memberIds: ['Pat', 'Quinn'] },
      { id: 'S', key: 'S', name: 'Team S', cyclesEnabled: true, cycleDuration: 2, estimationType: 'fibonacci', timezone: 'UTC', memberIds: ['Sam'] },
    ],
    people: [person('Pat', ['R']), person('Quinn', ['R']), person('Sam', ['S'])],
    cycles: [
      cycle('r1', 'R', '2026-10-05', '2026-11-01', true),
      cycle('r3', 'R', '2026-11-02', '2026-11-15'),
      cycle('r4', 'R', '2026-11-16', '2026-11-29'),
      cycle('s1', 'S', '2026-10-05', '2026-11-01', true),
      cycle('s3', 'S', '2026-11-02', '2026-11-15'),
    ],
    issues: [...history, ...work],
    projects: [],
  };
}
const work = (id: string, assigneeId: string, estimate: number, priority: number, cycleId: string | null = 'r3', extra: Partial<Issue> = {}) =>
  issue({ id, identifier: id, teamId: 'R', cycleId, assigneeId, estimate, priority, ...extra });
const plan = (snap: Snapshot, opts: { ooo?: ReturnType<typeof ooo>; unit?: 'week'; size?: number } = {}) => {
  const model = buildModel({ snapshot: snap, ooo: opts.ooo ?? null, planner: planner(), range: defaultRange(TODAY), today: TODAY, bufferPct: 0 });
  return { model, ...planReassignments(model, periodBuckets(TODAY, opts.unit ?? 'week', opts.size ?? 2, 2)) };
};

describe('reassignments', () => {
  it('moves the lowest-priority not-started issue to a teammate, preferring room, within the same team first', () => {
    const { reassignments, unresolved } = plan(
      workspace([work('HIGH', 'Pat', 8, 2), work('LOW', 'Pat', 3, 4), work('MED', 'Pat', 3, 3), work('Q1', 'Quinn', 5, 3)]),
    );
    expect(reassignments).toHaveLength(1);
    const r = reassignments[0];
    expect(r).toMatchObject({ kind: 'same-team', issueId: 'LOW', from: 'Pat', to: 'Quinn', teamId: 'R', toTeamId: 'R', bucketIndex: 0, bothStillOver: false });
    expect(r.periodPoints).toBeCloseTo(3);
    expect([r.fromBefore, r.fromAfter, r.toBefore, r.toAfter].map((x) => Math.round(x! * 100))).toEqual([140, 110, 50, 80]);
    expect(r.evidence.checks.map((c) => [c.label, c.ok])).toEqual([
      ['Same team', true],
      ['Narrows the gap this period', true],
      ['Narrows the gap in every period the issue reaches', true],
      ['Has room (≤ 90%)', true],
    ]);
    // Moving MED would leave Quinn more over than Pat: not a spread. Sam (no shared project) is never used.
    expect(reassignments.some((x) => x.to === 'Sam')).toBe(false);
    expect(unresolved).toEqual([expect.objectContaining({ personId: 'Pat', bucketIndex: 0 })]);
    expect(unresolved[0].overBy).toBeCloseTo(1);
  });

  it('spreads the load even when both people stay over capacity', () => {
    const { reassignments } = plan(workspace([work('BIG', 'Pat', 16, 2), work('B', 'Pat', 2, 4), work('C', 'Pat', 2, 4), work('Q1', 'Quinn', 11, 3)]));
    expect(reassignments.map((r) => r.issueId).sort()).toEqual(['B', 'C']);
    expect(reassignments.every((r) => r.bothStillOver)).toBe(true);
    const last = reassignments[reassignments.length - 1];
    expect(Math.round(last.fromAfter! * 100)).toBe(160);
    expect(Math.round(last.toAfter! * 100)).toBe(150);
    expect(last.evidence.checks.find((c) => c.label.startsWith('Has room'))!.ok).toBe(false);
  });

  it('never moves work that has started', () => {
    const { reassignments, unresolved } = plan(workspace([work('WIP', 'Pat', 30, 4, 'r3', { stateType: 'started', stateName: 'In Progress' })]));
    expect(reassignments).toHaveLength(0);
    expect(unresolved[0].reason).toMatch(/only work already in progress/);
  });

  it('never leaves the recipient over capacity in another period where the donor is not', () => {
    // UN spreads to Nov 27, half in each period; Quinn is full next period, Pat isn't.
    const { reassignments } = plan(
      workspace([work('P1', 'Pat', 10, 3), work('UN', 'Pat', 4, 4, null, { dueDate: '2026-11-27' }), work('Q1', 'Quinn', 2, 3), work('Q2', 'Quinn', 10, 3, 'r4')]),
    );
    expect(reassignments).toHaveLength(0);
  });

  it('checks every period the issue reaches (recipient out next week)', () => {
    const { reassignments } = plan(workspace([work('P1', 'Pat', 12, 3), work('P2', 'Pat', 2, 4), work('Q1', 'Quinn', 5, 3)]), {
      unit: 'week',
      size: 1,
      ooo: ooo([{ email: 'quinn@x.dev', personId: 'Quinn', start: '2026-11-09', end: '2026-11-13' }]),
    });
    expect(reassignments).toHaveLength(0);
  });

  it('borrows across teams only to people on a team working on the same project', () => {
    const snap = workspace([
      work('P1', 'Pat', 10, 2),
      work('LOW', 'Pat', 3, 4, 'r3', { projectId: 'X' }),
      work('Q1', 'Quinn', 9, 3),
      issue({ id: 'S1', identifier: 'S1', teamId: 'S', cycleId: 's3', assigneeId: 'Sam', estimate: 2, projectId: 'X' }),
    ]);
    const { reassignments } = plan(snap);
    expect(reassignments).toHaveLength(1);
    expect(reassignments[0]).toMatchObject({ kind: 'borrow', issueId: 'LOW', from: 'Pat', to: 'Sam', teamId: 'R', toTeamId: 'S' });
    expect(reassignments[0].evidence.checks[0].label).toBe('Works on the same project');
  });

  it('reports remaining team overflow with a scope-or-timeline label, projects and issues', () => {
    const { overflow } = plan(workspace([work('P1', 'Pat', 14, 4, 'r3', { projectId: 'X' }), work('Q1', 'Quinn', 12, 3)]));
    const o = overflow.find((x) => x.teamId === 'R' && x.bucketIndex === 0)!;
    expect(o.teamOverBy).toBeCloseTo(6);
    expect(o.label).toBe('Team R exceeds capacity by 6 pts in Nov 2 – Nov 15 after reassignment. Requires a scope or timeline decision.');
    expect(o.projects[0]).toEqual({ projectId: 'X', points: 14 });
    expect(o.issueIds).toEqual(['P1', 'Q1']);
  });
});

describe('reassignments on the demo workspace', () => {
  const today = '2026-10-27';
  const snapshot = demoSnapshot(today, '2026-10-27T08:00:00.000Z');
  const model = buildModel({ snapshot, ooo: parseOooCsv(demoOooCsv(today), 'x.csv', snapshot.people), planner: planner(), range: defaultRange(today), today, bufferPct: 0.1 });
  const buckets = periodBuckets(today, 'week', 2, 6);
  const result = planReassignments(model, buckets);

  it('only moves not-started work within a team, and never overloads the recipient', () => {
    expect(result.reassignments.length).toBeGreaterThan(0);
    for (const r of result.reassignments) {
      const issue = model.issues.get(r.issueId)!;
      expect(['triage', 'backlog', 'unstarted']).toContain(issue.stateType);
      if (r.kind === 'same-team') expect(model.teams.get(issue.teamId)!.memberIds).toContain(r.to);
      else expect(model.teams.get(r.toTeamId)!.memberIds).toContain(r.to);
      expect(r.fromAfter!).toBeLessThan(r.fromBefore!);
      // Recipients end within capacity, or still over but only spreading the load.
      expect(r.toAfter! <= 1.01 || r.bothStillOver).toBe(true);
      expect(r.evidence.checks).toHaveLength(4);
    }
  });

  it('lists people it could not help once per period, and labels team overflow', () => {
    const keys = result.unresolved.map((u) => `${u.personId}|${u.bucketIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.overflow.some((o) => /Requires a scope or timeline decision\.$/.test(o.label))).toBe(true);
  });
});
