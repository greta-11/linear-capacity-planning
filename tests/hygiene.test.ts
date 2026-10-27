import { describe, expect, it } from 'vitest';
import { buildModel } from '../shared/capacity';
import { summarizeHygiene } from '../shared/hygiene';
import { demoOooCsv, demoSnapshot } from '../server/demo/seed';
import { parseOooCsv } from '../server/ooo/csv';
import { fixture, issue, planner, TODAY } from './fixtures';

const range = { from: TODAY, to: '2026-11-29' };

describe('data hygiene', () => {
  it('flags open issues with no date, no estimate, or no project', () => {
    const snap = fixture(
      [
        issue({ id: 'ok', teamId: 'T', cycleId: 'c3', estimate: 2, projectId: 'P' }),
        issue({ id: 'nodate', teamId: 'T', cycleId: null, estimate: 2, projectId: 'Q' }), // project without target
        issue({ id: 'dated', teamId: 'T', cycleId: null, estimate: 2, projectId: 'Q', dueDate: '2026-11-20' }),
        issue({ id: 'all3', teamId: 'T', cycleId: null, estimate: null }),
        issue({ id: 'u-noest', teamId: 'U', cycleId: 'u3', estimate: null, projectId: 'P' }), // U doesn't estimate
        issue({ id: 'done', teamId: 'T', cycleId: null, estimate: null, stateType: 'completed' }),
      ],
      [
        { id: 'P', name: 'P', url: '', targetDate: '2026-12-01', startDate: null, statusType: 'started', statusName: '', health: null, progress: 0, leadId: null, teamIds: ['T'] },
        { id: 'Q', name: 'Q', url: '', targetDate: null, startDate: null, statusType: 'started', statusName: '', health: null, progress: 0, leadId: null, teamIds: ['T'] },
      ],
    );
    const h = summarizeHygiene(buildModel({ snapshot: snap, ooo: null, planner: planner(), range, today: TODAY }));
    const flags = Object.fromEntries(h.issues.map((i) => [i.issueId, i.flags]));
    expect(flags).toEqual({ nodate: ['noDate'], all3: ['noDate', 'noEstimate', 'noProject'] });
    expect(h.counts).toEqual({ noDate: 2, noEstimate: 1, noProject: 1 });
    expect(h.checked).toBe(5);
    expect(h.flagged).toBe(2);
  });

  it('finds the seeded problems in the demo workspace', () => {
    const today = '2026-10-27';
    const snapshot = demoSnapshot(today, '2026-10-27T08:00:00.000Z');
    const h = summarizeHygiene(
      buildModel({ snapshot, ooo: parseOooCsv(demoOooCsv(today), 'x.csv', snapshot.people), planner: planner(), range: { from: today, to: '2027-01-17' }, today }),
    );
    // 4 loose assigned issues with no due date + 2 backlog issues in Observability (no target date).
    expect(h.counts.noDate).toBe(6);
    expect(h.counts.noEstimate).toBeGreaterThan(0);
    expect(h.counts.noProject).toBeGreaterThan(0);
  });
});
