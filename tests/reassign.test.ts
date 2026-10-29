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
  it('moves the lowest-priority not-started issue to the teammate with headroom, within the same team only', () => {
    const { reassignments, unresolved } = plan(
      workspace([work('HIGH', 'Pat', 8, 2), work('LOW', 'Pat', 3, 4), work('MED', 'Pat', 3, 3), work('Q1', 'Quinn', 5, 3)]),
    );
    expect(reassignments).toHaveLength(1);
    const r = reassignments[0];
    expect(r).toMatchObject({ issueId: 'LOW', from: 'Pat', to: 'Quinn', teamId: 'R', bucketIndex: 0 });
    expect(r.periodPoints).toBeCloseTo(3);
    expect(r.rationale).toBe("Quinn has 5 pts of headroom this period and 10 next; they'd be at 80% this period and 0% next. Pat goes from 140% to 110%.");
    // Sam (team S) has room but is never used. Pat is still over and is reported, not omitted.
    expect(reassignments.some((x) => x.to === 'Sam')).toBe(false);
    expect(unresolved).toEqual([expect.objectContaining({ personId: 'Pat', bucketIndex: 0, reason: 'no remaining issue fits within a teammate’s headroom' })]);
    expect(unresolved[0].overBy).toBeCloseTo(1);
  });

  it('never moves work that has started', () => {
    const { reassignments, unresolved } = plan(workspace([work('WIP', 'Pat', 30, 4, 'r3', { stateType: 'started', stateName: 'In Progress' })]));
    expect(reassignments).toHaveLength(0);
    expect(unresolved[0].reason).toMatch(/only work already in progress/);
  });

  it('says explicitly when no teammate has headroom', () => {
    const { reassignments, unresolved } = plan(workspace([work('P1', 'Pat', 14, 4), work('Q1', 'Quinn', 12, 3)]));
    expect(reassignments).toHaveLength(0);
    expect(unresolved.find((u) => u.personId === 'Pat')!.reason).toBe('no Team R teammate has headroom this period');
  });

  it('rejects a move that would overload the teammate next period', () => {
    // UN spreads to Nov 27, half in each period; Quinn has room now but is full next period.
    const { reassignments, unresolved } = plan(
      workspace([work('P1', 'Pat', 10, 3), work('UN', 'Pat', 4, 4, null, { dueDate: '2026-11-27' }), work('Q1', 'Quinn', 2, 3), work('Q2', 'Quinn', 10, 3, 'r4')]),
    );
    expect(reassignments).toHaveLength(0);
    expect(unresolved[0].reason).toBe('teammates with room this period would go over capacity next period');
  });

  it('rejects a move that would overload the teammate within the issue’s cycle', () => {
    // Weekly periods: Quinn has room in week 1 but is out all of week 2, so the 2-week cycle is full.
    const { reassignments, unresolved } = plan(workspace([work('P1', 'Pat', 12, 3), work('P2', 'Pat', 2, 4), work('Q1', 'Quinn', 5, 3)]), {
      unit: 'week',
      size: 1,
      ooo: ooo([{ email: 'quinn@x.dev', personId: 'Quinn', start: '2026-11-09', end: '2026-11-13' }]),
    });
    expect(reassignments).toHaveLength(0);
    expect(unresolved[0].reason).toBe('teammates with room this period would go over capacity within the issue’s cycle');
  });

  it('reports remaining team overflow with a scope-or-timeline label, projects and issues', () => {
    const { overflow } = plan(workspace([work('P1', 'Pat', 14, 4, 'r3', { projectId: 'X' }), work('Q1', 'Quinn', 12, 3)]));
    const o = overflow.find((x) => x.teamId === 'R' && x.bucketIndex === 0)!;
    expect(o.teamOverBy).toBeCloseTo(6);
    expect(o.label).toBe('Team R exceeds capacity by 6 pts in Oct 26 – Nov 8 after reassignment. Requires a scope or timeline decision.'.replace('Oct 26 – Nov 8', 'Nov 2 – Nov 15'));
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
      expect(model.teams.get(issue.teamId)!.memberIds).toContain(r.to);
      expect(r.toAfter!).toBeLessThanOrEqual(1.01);
      expect(r.fromAfter!).toBeLessThan(r.fromBefore!);
      expect(r.rationale).toMatch(/has [\d.]+ pts of headroom this period/);
    }
  });

  it('lists people it could not help once per period, and labels team overflow', () => {
    const keys = result.unresolved.map((u) => `${u.personId}|${u.bucketIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.overflow.some((o) => /Requires a scope or timeline decision\.$/.test(o.label))).toBe(true);
  });
});
