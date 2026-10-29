import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { periodBuckets } from '../shared/calendar';
import { buildModel, planningStart } from '../shared/capacity';
import { planReassignments } from '../shared/reassign';
import type { Person } from '../shared/types';
import { demoOooCsv, demoSnapshot } from '../server/demo/seed';
import { DEFAULT_VIEW_OOO, DEFAULT_VIEW_URL, parseViewRef } from '../server/linear/view';
import { parseOooCsv } from '../server/ooo/csv';
import { fixture, issue, planner } from './fixtures';

// Periods anchored to the earliest open cycle, full-cycle accounting, the Linear view
// source and its OOO sample.

// Monday of the second week of T's cycle c3 (Nov 2 – Nov 15).
const MID = '2026-11-09';
const c3 = { start: '2026-11-02', end: '2026-11-15' };
const build = (extra = fixture().issues.slice(0, 0), today = MID) =>
  buildModel({ snapshot: fixture(extra), ooo: null, planner: planner(), range: { from: c3.start, to: '2026-11-29' }, today, bufferPct: 0 });

describe('planningStart', () => {
  it("is the start of the earliest cycle holding open work, even in the past", () => {
    expect(planningStart(fixture([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A' })]), MID)).toBe(c3.start);
  });
  it('ignores completed work and completed cycles, and falls back to today', () => {
    const snap = fixture([issue({ teamId: 'T', cycleId: 'c2', assigneeId: 'A' }), issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', stateType: 'completed' })]);
    expect(planningStart(snap, MID)).toBe(MID);
  });
});

describe('a cycle under way counts in full', () => {
  const m = build([
    issue({ id: 'DONE', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'completed', completedAt: '2026-11-04T10:00:00Z' }),
    issue({ id: 'PROG', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'started', stateName: 'In Progress' }),
    issue({ id: 'TODO', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4 }),
    issue({ id: 'GONE', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 4, stateType: 'canceled' }),
  ]);

  it('puts done work on the elapsed days and remaining work on the rest, adding up to the full estimates', () => {
    const full = m.personWindow('A', c3.start, c3.end);
    expect(full.workingDays).toBe(10);
    expect(full.baseline).toBeCloseTo(10);
    expect(full.load).toBeCloseTo(12); // 4 completed + 4 in progress + 4 todo; canceled excluded
    const past = m.personWindow('A', c3.start, '2026-11-08');
    expect(past.items.every((i) => i.kind === 'done')).toBe(true);
    expect(past.load).toBeCloseTo(4 + 2); // completed + the done half of In Progress
    const ahead = m.personWindow('A', MID, c3.end);
    expect(ahead.items.some((i) => i.kind === 'done')).toBe(false);
    expect(ahead.load).toBeCloseTo(2 + 4);
    expect(full.loadByTeam.T.done).toBeCloseTo(6);
  });

  it('keeps done work out of the reassignable spread', () => {
    expect(m.spreadOf('DONE')).toBeNull();
    expect(m.doneSpreadOf('DONE')!.points).toBe(4);
    expect(m.issuePoints('PROG', c3.start, c3.end)).toBeCloseTo(2);
  });

  it('judges a period under way in full, so a card starts from the same % as its cell', () => {
    const m2 = build([
      issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 6, stateType: 'completed', completedAt: '2026-11-04T10:00:00Z' }),
      issue({ id: 'BIG', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 8 }),
      issue({ id: 'LOW', teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 2, priority: 4 }),
      issue({ teamId: 'T', cycleId: 'c4', assigneeId: 'B', estimate: 1 }),
    ]);
    const cell = m2.personWindow('A', c3.start, c3.end);
    expect(cell.utilization).toBeCloseTo(1.6); // 6 done + 10 to do, against 10 plannable
    const plan = planReassignments(m2, periodBuckets(c3.start, 'week', 2, 2));
    const first = plan.reassignments[0];
    expect(m2.issues.get(first.issueId)!.id).toBe('LOW');
    expect(first.fromBefore).toBeCloseTo(cell.utilization!);
    expect(first.evidence.window).toEqual(c3);
  });

  it('makes no suggestion for someone over only on work already done', () => {
    // 30 pts already done this cycle: over on the full period, but nothing left to act on.
    const busy = build([issue({ teamId: 'T', cycleId: 'c3', assigneeId: 'A', estimate: 30, stateType: 'completed', completedAt: '2026-11-05T10:00:00Z' })]);
    expect(busy.personWindow('A', c3.start, c3.end).status).toBe('over');
    const plan = planReassignments(busy, periodBuckets(c3.start, 'week', 2, 2));
    expect(plan.deferrals.filter((d) => d.personId === 'A')).toEqual([]);
  });
});

describe('reassignment evidence on the demo workspace', () => {
  const today = '2026-10-27';
  const snapshot = demoSnapshot(today, '2026-10-27T08:00:00.000Z');
  const model = buildModel({
    snapshot,
    ooo: parseOooCsv(demoOooCsv(today), 'x.csv', snapshot.people),
    planner: planner(),
    range: { from: planningStart(snapshot, today), to: '2027-01-31' },
    today,
    bufferPct: 0.1,
  });
  const buckets = periodBuckets(planningStart(snapshot, today), 'week', 2, 6);
  const plan = planReassignments(model, buckets);

  it('starts the first period at the earliest open cycle, before today', () => {
    expect(buckets[0].start < today).toBe(true);
  });

  it('records the trigger, all four constraint checks and why, for every reassignment', () => {
    expect(plan.reassignments.length).toBeGreaterThan(0);
    for (const r of plan.reassignments) {
      expect(r.evidence.trigger.load).toBeGreaterThan(r.evidence.trigger.plannable);
      expect(r.evidence.checks.map((c) => c.label)).toEqual([
        expect.stringMatching(/^(Same team|Works on the same project)$/),
        'Narrows the gap this period',
        "Within capacity over the issue's cycle",
        'Has room (≤ 90%)',
      ]);
      // Judged on the whole period, as its heat map cell shows it.
      expect(r.evidence.window).toEqual({ start: buckets[r.bucketIndex].start, end: buckets[r.bucketIndex].end });
      expect(r.evidence.whyIssue).toMatch(/not started/);
    }
  });

  it('only leaves someone over who was over already, or took work while spreading the load', () => {
    for (const d of plan.deferrals) {
      const b = buckets[d.bucketIndex];
      const w = { start: b.start, end: b.end };
      for (const p of [d]) {
        const before = model.personWindow(p.personId, w.start, w.end);
        const wasOver = before.load > before.plannable + 0.05;
        const received = plan.reassignments.some((r) => r.to === p.personId && model.issuePoints(r.issueId, w.start, w.end) > 0);
        expect(wasOver || received).toBe(true);
      }
    }
  });
});

describe('Linear view source', () => {
  it('parses the default view URL to its slug', () => {
    expect(parseViewRef(DEFAULT_VIEW_URL)).toEqual({
      id: '30b9a718498a',
      url: 'https://linear.app/rideshare-company/view/gx-capacity-planning-demo-subset-30b9a718498a',
      isDefault: true,
    });
  });
  it('accepts a slug, an ID, or `all` for the whole workspace', () => {
    expect(parseViewRef('30b9a718498a')!.isDefault).toBe(true);
    expect(parseViewRef('https://linear.app/x/view/5f1c2a9e-1111-4222-8333-944455556666')!.id).toBe('5f1c2a9e-1111-4222-8333-944455556666');
    expect(parseViewRef('all')).toBeNull();
    expect(parseViewRef('')).toBeNull();
  });
});

describe('OOO sample for the GX view', () => {
  // Assignees in the view's export (GX capacity planning demo subset).
  const emails = [
    'meg', 'maciek', 'mel', 'steven.molchanov', 'aaron', 'lena', 'paco', 'tyler', 'shannon.hu', 'simone', 'eitan', 'sarah', 'lauren', 'brian',
    'craig', 'jaden.schmeisser', 'allie', 'jack', 'anthony', 'chris.maggio', 'gino', 'liam', 'jesse', 'stephanie.yung', 'luke',
  ].map((n) => `${n}@linear.app`);
  const people: Person[] = [...emails, 'eclairemoy@gmail.com'].map((email, i) => ({
    id: `p${i}`,
    name: email,
    displayName: email,
    email,
    avatarUrl: null,
    active: true,
    teamIds: [],
  }));

  it('parses cleanly against the view’s people', () => {
    const data = parseOooCsv(fs.readFileSync(DEFAULT_VIEW_OOO, 'utf8'), 'ooo-gx-capacity-demo.csv', people);
    expect(data.problems).toEqual([]);
    expect(data.entries.length).toBeGreaterThan(20);
    expect(data.entries.some((e) => e.email === '*')).toBe(true);
  });
});
