import { describe, expect, it } from 'vitest';
import { buildModel, defaultRange, emptyPlanner } from '../shared/capacity';
import { applyPlannerChange, destinationOf } from '../shared/changes';
import { generateRecommendations } from '../shared/recommendations';
import type { Recommendation } from '../shared/types';
import { demoOooCsv, demoSnapshot } from '../server/demo/seed';
import { parseOooCsv } from '../server/ooo/csv';

const today = '2026-10-27';
const snapshot = demoSnapshot(today, '2026-10-27T08:00:00.000Z');
const ooo = parseOooCsv(demoOooCsv(today), 'demo-ooo.csv', snapshot.people);
const run = (planner = emptyPlanner()) => generateRecommendations(buildModel({ snapshot, ooo, planner, range: defaultRange(today), today }), ooo);
const recs = run();
const byRule = (rule: Recommendation['rule']) => recs.filter((r) => r.rule === rule);

describe('recommendations on the demo workspace', () => {
  it('fires every rule', () => {
    for (const rule of ['defer', 'reassign', 'estimate', 'rebalance-allocation', 'unplanned-buffer', 'velocity-override', 'ooo-data'] as const) {
      expect(byRule(rule).length, rule).toBeGreaterThan(0);
    }
  });

  it("defers Ana's work out of the cycle she's mostly out for, citing her vacation", () => {
    const rec = byRule('defer').find((r) => r.personId === 'u-ana' && /out/.test(r.title))!;
    expect(rec).toBeDefined();
    expect(rec.destination).toBe('linear');
    const anaVacation = ooo.entries.find((e) => e.email === 'ana@acme.dev')!;
    expect(rec.evidence.oooEntryIds).toContain(anaVacation.id);
    const highlighted = new Set(rec.evidence.issues.filter((i) => i.highlight).map((i) => i.issueId));
    for (const change of rec.changes) {
      expect(change.kind).toBe('issue.cycle');
      const issue = snapshot.issues.find((i) => i.id === (change as { issueId: string }).issueId)!;
      expect(issue.assigneeId).toBe('u-ana');
      expect(['triage', 'backlog', 'unstarted']).toContain(issue.stateType);
      expect(highlighted.has(issue.id)).toBe(true);
    }
    expect(highlighted.size).toBe(rec.changes.length);
    expect(rec.evidence.cycles).toHaveLength(2);
  });

  it('never suggests moving started or mid-cycle (unplanned) issues', () => {
    for (const r of [...byRule('defer'), ...byRule('reassign')]) {
      for (const c of r.changes) {
        const issue = snapshot.issues.find((i) => i.id === (c as { issueId: string }).issueId)!;
        expect(issue.stateType).not.toBe('started');
        expect(issue.labels).not.toContain('Bug');
      }
    }
  });

  it('offers reassigning to the teammate with the most room as an alternative', () => {
    const rec = byRule('reassign').find((r) => r.personId === 'u-ana')!;
    expect(byRule('defer').some((d) => d.group === rec.group)).toBe(true);
    expect(rec.changes.every((c) => c.kind === 'issue.assignee' && c.from === 'u-ana' && c.to === 'u-ben')).toBe(true);
    expect(rec.evidence.rationale.join(' ')).toMatch(/Ben has the most room/);
  });

  it("estimates Web's unestimated issues with the team median", () => {
    const rec = byRule('estimate')[0];
    expect(rec.teamId).toBe('team-web');
    expect(rec.changes).toHaveLength(4);
    expect(rec.changes.every((c) => c.kind === 'issue.estimate' && c.to >= 1)).toBe(true);
    expect(rec.evidence.issues.every((i) => snapshot.issues.find((x) => x.id === i.issueId)!.estimate === null)).toBe(true);
  });

  it("rebalances Dana's split toward Web with per-team evidence", () => {
    const rec = byRule('rebalance-allocation')[0];
    expect(rec.personId).toBe('u-dana');
    const to = (rec.changes[0] as { to: Record<string, number> }).to;
    expect(to['team-web']).toBeGreaterThan(to['team-plt']);
    expect(rec.evidence.facts.map((f) => f.label)).toEqual(['Platform', 'Web']);
  });

  it("raises Mobile's unplanned buffer and cites the cycles it measured", () => {
    const rec = byRule('unplanned-buffer').find((r) => r.teamId === 'team-mob')!;
    expect(rec.title).toMatch(/Raise/);
    expect(rec.evidence.cycles).toHaveLength(3);
    expect(rec.evidence.issues.length).toBeGreaterThan(0);
  });

  it('suggests a ramp-up velocity for the new joiner', () => {
    expect(byRule('velocity-override').map((r) => r.personId)).toContain('u-gus');
  });

  it('turns OOO problems into CSV to-dos with row references', () => {
    const rec = byRule('ooo-data').find((r) => r.title.includes('contractor@acme.dev'))!;
    expect(rec.destination).toBe('csv');
    expect(rec.evidence.oooProblemRows).toEqual([9]);
  });

  it('routes every change to the destination of its recommendation', () => {
    for (const r of recs) for (const c of r.changes) expect(destinationOf(c)).toBe(r.destination);
  });

  it('hides dismissed recommendations and alternatives for accepted ones', () => {
    const rec = byRule('reassign').find((r) => r.personId === 'u-ana')!;
    const planner = emptyPlanner();
    planner.ledger.push({
      id: 'l1', recommendationId: rec.id, group: rec.group, rule: rec.rule, destination: 'linear', title: rec.title, reason: '', changes: rec.changes,
      status: 'pending', acceptedAt: '', acceptedBy: 'me', updatedAt: '',
    });
    planner.dismissed.push(byRule('estimate')[0].id);
    const after = run(planner);
    expect(after.some((r) => r.group === rec.group)).toBe(false);
    expect(after.some((r) => r.rule === 'estimate')).toBe(false);
  });

  it('applies and reverts planner changes', () => {
    const rec = byRule('unplanned-buffer').find((r) => r.teamId === 'team-mob')!;
    const planner = emptyPlanner();
    applyPlannerChange(planner, rec.changes[0]);
    expect(planner.unplannedBuffers['team-mob']).toBe((rec.changes[0] as { to: number }).to);
    applyPlannerChange(planner, rec.changes[0], true);
    expect(planner.unplannedBuffers['team-mob']).toBeUndefined();
  });
});
