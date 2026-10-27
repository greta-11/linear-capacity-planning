import { overlap } from './calendar';
import { cycleName, round1, summarizeTeam, type CapacityModel } from './capacity';
import type { Cycle, Evidence, Issue, OooDataset, Recommendation, RuleId } from './types';

// Rule-based recommendations. Every recommendation carries the evidence it was
// built from: the metric that tripped the rule, the source rows (issues, OOO
// rows, cycles) and the reasoning for the specific action chosen.

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const pts = (n: number) => `${round1(n)} pts`;

/** Lower number = more important. "No priority" (0) sorts as least important. */
const priorityRank = (p: number) => (p === 0 ? 5 : p);
export const PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

const RULE_TEXT: Record<RuleId, string> = {
  defer: 'Person over capacity in a cycle → move their lowest-priority unstarted issues to the nearest later cycle with room, until they are back at or under the at-risk threshold.',
  reassign: 'Person over capacity in a cycle while a teammate has room → hand their lowest-priority unstarted issues to the teammate with the most room, without pushing that teammate past the at-risk threshold.',
  estimate: 'Cycle at risk with unestimated issues → estimate them so the load is real, not assumed.',
  'rebalance-allocation': "Person on several teams whose time split differs from where their scheduled work is by more than 20 points → align the split.",
  'unplanned-buffer': 'Team whose measured unplanned work differs from its reserved buffer by 5+ points → adjust the buffer.',
  'velocity-override': 'Velocity based on too little history → set an explicit velocity.',
  'ooo-data': 'OOO rows that could not be applied → fix in the HR source and re-import.',
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export function generateRecommendations(model: CapacityModel, ooo: OooDataset | null): Recommendation[] {
  const { snapshot, planner } = model.input;
  const settings = planner.settings;
  const recs: Recommendation[] = [];

  const evidence = (partial: Partial<Evidence> & Pick<Evidence, 'metric' | 'rationale'>, rule: RuleId): Evidence => ({
    rule: RULE_TEXT[rule],
    facts: [],
    issues: [],
    oooEntryIds: [],
    oooProblemRows: [],
    cycles: [],
    freshness: {
      snapshotFetchedAt: snapshot.fetchedAt,
      snapshotSource: snapshot.source,
      oooFile: ooo?.fileName ?? null,
      oooUploadedAt: ooo?.uploadedAt ?? null,
    },
    ...partial,
  });

  const name = (personId: string) => model.people.get(personId)?.displayName ?? 'Unknown';
  const inRange = (c: Cycle) => overlap(c.startDate, c.endDate, model.from, model.to);

  // --- defer / reassign -------------------------------------------------------
  // For each person over capacity in a cycle, pick unstarted issues (lowest priority
  // first) until they are back at or under the at-risk threshold, then offer two
  // alternatives: move them to a later cycle, or hand them to the teammate with the
  // most room.
  for (const person of model.people.values()) {
    if (!person.active) continue;
    for (const teamId of person.teamIds) {
      const team = model.teams.get(teamId)!;
      const upcoming = model.upcomingCyclesOf(teamId);
      for (const cycle of upcoming) {
        const ov = inRange(cycle);
        if (!ov) continue;
        const w = model.personWindow(person.id, ov[0], ov[1]);
        if (w.status !== 'over') continue;
        const excess = w.load - w.capacity * settings.thresholds.atRisk;
        const mine = w.items.filter((i) => i.cycleId === cycle.id);
        const candidates = mine
          .filter((item) => item.kind === 'planned')
          .map((item) => ({ item, issue: model.issues.get(item.issueId)! }))
          .filter(({ issue }) => ['triage', 'backlog', 'unstarted'].includes(issue.stateType))
          .sort((a, b) => priorityRank(b.issue.priority) - priorityRank(a.issue.priority) || b.item.points - a.item.points);
        if (!candidates.length) continue;

        /** Greedily selects candidates until the excess is covered, within `room` points (full-issue points for a target). */
        const select = (room: number, size: (c: (typeof candidates)[number]) => number) => {
          const picked: typeof candidates = [];
          let freed = 0;
          let used = 0;
          for (const c of candidates) {
            if (freed >= excess - 0.01) break;
            if (used + size(c) > room + 0.01) continue;
            picked.push(c);
            freed += c.item.points;
            used += size(c);
          }
          return { picked, freed, used };
        };

        const label = cycleName(cycle, team);
        const outHeavy = w.oooDays >= 1 && w.absence >= 0.3 * w.gross;
        const severity = outHeavy || (w.utilization ?? 2) > settings.thresholds.over + 0.3 ? 'high' : 'medium';
        const group = `overload:${person.id}:${cycle.id}`;
        const metric = {
          label: `${name(person.id)} in ${label}`,
          value: `${pts(w.load)} load vs ${pts(w.capacity)} capacity = ${pct(w.utilization)}`,
          threshold: `over above ${pct(settings.thresholds.over)}; target ≤ ${pct(settings.thresholds.atRisk)}`,
        };
        const facts = [
          { label: 'Window', value: `${ov[0]} → ${ov[1]} (${w.workingDays} working days)` },
          { label: 'Velocity', value: `${round1(model.velocity.get(person.id)!.value)} pts/day (${model.velocity.get(person.id)!.source})` },
          { label: 'OOO in window', value: `${round1(w.oooDays)} days (−${pts(w.absence)})` },
          { label: 'Points to free', value: `${pts(Math.max(0, excess))} to reach ${pct(settings.thresholds.atRisk)}` },
          ...Object.entries(w.loadByTeam).map(([t, l]) => ({
            label: `Load · ${model.teamName(t)}`,
            value: `planned ${pts(l.planned)}, unplanned ${pts(l.unplanned)}, reserve ${pts(l.reserve)}`,
          })),
        ];
        const describe = (picked: typeof candidates) => picked.map((c) => `${c.issue.identifier} (${PRIORITY_LABEL[c.issue.priority]}, ${pts(c.item.fullPoints)}${c.item.unestimated ? ' assumed' : ''})`).join(', ');
        const subject = (picked: typeof candidates) => (picked.length === 1 ? picked[0].issue.identifier : `${picked.length} issues`);
        const baseRationale = (picked: typeof candidates, freed: number) => [
          ...(outHeavy ? [`${name(person.id)} is out ${round1(w.oooDays)} working days in this window, which removes ${pts(w.absence)} of capacity — the main reason ${label} is over.`] : []),
          `Picked the lowest-priority unstarted issues first: ${describe(picked)}.`,
          `That frees ${pts(freed)} in this window and brings ${name(person.id)} from ${pct(w.utilization)} to ${pct(w.capacity > 0 ? (w.load - freed) / w.capacity : null)}${freed < excess - 0.01 ? ` — not all the way to ${pct(settings.thresholds.atRisk)}; there wasn't room for more` : ''}.`,
          'Started issues and issues added mid-cycle (usually urgent) are never suggested.',
        ];
        const evidenceIssues = (picked: typeof candidates) => {
          const ids = new Set(picked.map((c) => c.issue.id));
          return mine.map((m) => ({ issueId: m.issueId, highlight: ids.has(m.issueId) }));
        };

        // Defer: the first later cycle of the same team that can absorb the most.
        let bestDefer: { target: Cycle; tw: ReturnType<typeof model.personWindow>; sel: ReturnType<typeof select> } | null = null;
        for (const target of upcoming.filter((c) => c.startDate > cycle.endDate).slice(0, 3)) {
          const tw = model.personWindow(person.id, target.startDate, target.endDate);
          const room = tw.capacity * settings.thresholds.atRisk - tw.load;
          if (room <= 0) continue;
          const sel = select(room, (c) => c.item.fullPoints);
          if (!sel.picked.length) continue;
          if (!bestDefer || sel.freed > bestDefer.sel.freed + 0.01) bestDefer = { target, tw, sel };
          if (sel.freed >= excess - 0.01) break;
        }
        if (bestDefer) {
          const { target, tw, sel } = bestDefer;
          const targetLabel = cycleName(target, team);
          const tAfter = tw.capacity > 0 ? (tw.load + sel.used) / tw.capacity : null;
          const after = w.capacity > 0 ? (w.load - sel.freed) / w.capacity : null;
          recs.push({
            id: `defer:${person.id}:${cycle.id}:${target.id}:${sel.picked.map((c) => c.issue.identifier).join(',')}`,
            rule: 'defer',
            destination: 'linear',
            severity,
            title: outHeavy
              ? `${name(person.id)} is out ${round1(w.oooDays)} days in ${label} — move ${subject(sel.picked)} to ${targetLabel}`
              : `Move ${subject(sel.picked)} from ${label} to ${targetLabel}`,
            summary: `${name(person.id)} is at ${pct(w.utilization)} in ${label}. Deferring ${sel.picked.length === 1 ? `"${sel.picked[0].issue.title}"` : `${sel.picked.length} unstarted issues (${pts(sel.used)})`} brings them to ${pct(after)}; ${targetLabel} goes from ${pct(tw.utilization)} to ${pct(tAfter)}.`,
            group,
            changes: sel.picked.map((c) => ({ kind: 'issue.cycle', issueId: c.issue.id, identifier: c.issue.identifier, from: cycle.id, to: target.id })),
            personId: person.id,
            teamId,
            cycleId: cycle.id,
            evidence: evidence(
              {
                metric,
                rationale: [
                  ...baseRationale(sel.picked, sel.freed),
                  `${targetLabel} is the nearest later ${team.key} cycle with room: ${name(person.id)} goes from ${pts(tw.load)} to ${pts(tw.load + sel.used)} of ${pts(tw.capacity)} (stays ≤ ${pct(settings.thresholds.atRisk)}).`,
                ],
                facts,
                issues: evidenceIssues(sel.picked),
                oooEntryIds: w.oooEntries.map((e) => e.entryId),
                cycles: [
                  { cycleId: cycle.id, points: w.load, note: `${pct(w.utilization)} → ${pct(after)} after move` },
                  { cycleId: target.id, points: tw.load, note: `${pct(tw.utilization)} → ${pct(tAfter)} after move` },
                ],
              },
              'defer',
            ),
          });
        }

        // Reassign: the teammate on the same team with the most room in the same window.
        const options = team.memberIds
          .filter((id) => id !== person.id && model.people.get(id)?.active && (model.allocation.get(id)!.shares[teamId] ?? 0) > 0)
          .map((id) => {
            const ow = model.personWindow(id, ov[0], ov[1]);
            return { id, ow, room: ow.capacity * settings.thresholds.atRisk - ow.load };
          })
          .filter((o) => o.room > 0)
          .sort((a, b) => (a.ow.utilization ?? 0) - (b.ow.utilization ?? 0));
        const best = options[0];
        const sel = best ? select(best.room, (c) => c.item.points) : null;
        if (best && sel?.picked.length) {
          const v = model.velocity.get(best.id)!;
          const after = w.capacity > 0 ? (w.load - sel.freed) / w.capacity : null;
          const oAfter = best.ow.capacity > 0 ? (best.ow.load + sel.used) / best.ow.capacity : null;
          recs.push({
            id: `reassign:${person.id}:${cycle.id}:${best.id}:${sel.picked.map((c) => c.issue.identifier).join(',')}`,
            rule: 'reassign',
            destination: 'linear',
            severity,
            title: `Reassign ${subject(sel.picked)} in ${label} from ${name(person.id)} to ${name(best.id)}`,
            summary: `${name(person.id)} is at ${pct(w.utilization)} in ${label} and would be at ${pct(after)}; ${name(best.id)} is at ${pct(best.ow.utilization)} in the same window and would be at ${pct(oAfter)}.`,
            group,
            changes: sel.picked.map((c) => ({ kind: 'issue.assignee', issueId: c.issue.id, identifier: c.issue.identifier, from: person.id, to: best.id })),
            personId: person.id,
            teamId,
            cycleId: cycle.id,
            evidence: evidence(
              {
                metric,
                rationale: [
                  ...baseRationale(sel.picked, sel.freed),
                  `${name(best.id)} has the most room on ${team.name} in this window: ${pts(best.ow.load)} of ${pts(best.ow.capacity)} (${pct(best.ow.utilization)}), ${round1(best.ow.oooDays)} OOO days.`,
                  `${name(best.id)}'s velocity is ${round1(v.value)} pts/day (${v.source}${v.source === 'history' ? `, ${v.completedIssues} issues completed in the lookback` : ''}).`,
                  ...(options.length > 1 ? [`Other teammates with room: ${options.slice(1, 3).map((o) => `${name(o.id)} (${pct(o.ow.utilization)})`).join(', ')}.`] : []),
                  'Only members of the same team are considered, so the issues stay in their cycle.',
                ],
                facts,
                issues: evidenceIssues(sel.picked),
                oooEntryIds: w.oooEntries.map((e) => e.entryId),
                cycles: [{ cycleId: cycle.id, points: w.load, note: `${pct(w.utilization)} → ${pct(after)} after reassigning` }],
              },
              'reassign',
            ),
          });
        }
      }
    }
  }

  // --- team-level rules ------------------------------------------------------
  for (const team of model.teams.values()) {
    const summary = summarizeTeam(model, team.id);

    // Estimate
    if (team.estimationType !== 'notUsed') {
      const median = Math.max(1, Math.round(summary.medianEstimate));
      for (const c of summary.cycles) {
        if (!c.unestimatedIssueIds.length) continue;
        const assumed = c.unestimatedIssueIds.length * summary.medianEstimate;
        const risky = c.status === 'at-risk' || c.status === 'over';
        if (!risky && assumed < 0.2 * c.load) continue;
        const label = cycleName(c.cycle, team);
        const issues = c.unestimatedIssueIds.map((id) => model.issues.get(id)!) as Issue[];
        recs.push({
          id: `estimate:${c.cycle.id}`,
          rule: 'estimate',
          destination: 'linear',
          severity: risky ? 'high' : 'low',
          title: `Estimate ${issues.length} issue${issues.length === 1 ? '' : 's'} in ${label}`,
          summary: `${label} is at ${pct(c.utilization)}, and ${pts(assumed)} of its load is assumed (team median × ${issues.length}). Real estimates tell you whether it is actually over.`,
          group: `estimate:${c.cycle.id}`,
          editable: true,
          changes: issues.map((i) => ({ kind: 'issue.estimate', issueId: i.id, identifier: i.identifier, from: null, to: median })),
          teamId: team.id,
          cycleId: c.cycle.id,
          evidence: evidence(
            {
              metric: { label, value: `${pts(c.load)} load vs ${pts(c.capacity)} capacity = ${pct(c.utilization)}`, threshold: `at risk above ${pct(settings.thresholds.atRisk)}` },
              rationale: [
                `${issues.length} open issue${issues.length === 1 ? ' has' : 's have'} no estimate; each is counted at the ${team.key} median of ${round1(summary.medianEstimate)} pts.`,
                `Assumed points are ${pct(c.load > 0 ? assumed / c.load : 0)} of this cycle's load.`,
                `Proposed values default to the median (${median}); edit them before accepting.`,
              ],
              facts: [
                { label: 'Team median estimate', value: `${round1(summary.medianEstimate)} pts (from all estimated ${team.key} issues)` },
                { label: 'Cycle window', value: `${c.start} → ${c.end}` },
              ],
              issues: issues.map((i) => ({ issueId: i.id, highlight: true })),
            },
            'estimate',
          ),
        });
      }
    }

    // Unplanned buffer
    const u = summary.unplanned;
    if (u.ratio != null && u.cycles.length >= 2 && Math.abs(u.ratio - u.buffer) >= 0.05) {
      const target = Math.min(0.5, Math.round(u.ratio * 20) / 20);
      if (target !== u.buffer) {
        const raise = target > u.buffer;
        recs.push({
          id: `buffer:${team.id}:${target}`,
          rule: 'unplanned-buffer',
          destination: 'planner',
          severity: raise && u.ratio - u.buffer >= 0.1 ? 'high' : 'medium',
          title: `${raise ? 'Raise' : 'Lower'} ${team.name}'s unplanned buffer from ${pct(u.buffer)} to ${pct(target)}`,
          summary: `Over the last ${u.cycles.length} cycles, ${pct(u.ratio)} of ${team.name}'s cycle work was added after the cycle started. Future cycles currently reserve ${pct(u.buffer)}.`,
          group: `buffer:${team.id}`,
          editable: true,
          changes: [{ kind: 'planner.unplannedBuffer', teamId: team.id, from: planner.unplannedBuffers[team.id] ?? null, to: target }],
          teamId: team.id,
          evidence: evidence(
            {
              metric: { label: `${team.name} unplanned share`, value: `${pct(u.ratio)} measured vs ${pct(u.buffer)} reserved (${u.bufferSource})`, threshold: 'differs by 5+ points' },
              rationale: [
                'An issue counts as unplanned when it entered the cycle after the cycle\'s first day (from Linear issue history).',
                raise
                  ? 'Reserving the measured share keeps future cycles from looking healthier than they turn out.'
                  : 'Reserving more than the team historically needs hides real capacity.',
                'This is a planning assumption, so it stays in the planner — Linear has no field for it.',
              ],
              cycles: u.cycles.map((c) => ({ cycleId: c.cycleId, points: c.unplanned, note: `${pts(c.unplanned)} of ${pts(c.total)} unplanned (${pct(c.total ? c.unplanned / c.total : 0)})` })),
              issues: u.cycles.flatMap((c) => c.issueIds).slice(0, 12).map((id) => ({ issueId: id })),
            },
            'unplanned-buffer',
          ),
        });
      }
    }
  }

  // --- person-level planner rules ----------------------------------------------
  const teamAvg = new Map<string, number>();
  for (const team of model.teams.values()) {
    const vals = team.memberIds.map((id) => model.velocity.get(id)).filter((v) => v && v.historyValue != null && v.completedIssues >= 5).map((v) => v!.historyValue!);
    if (vals.length) teamAvg.set(team.id, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  for (const person of model.people.values()) {
    if (!person.active) continue;
    const alloc = model.allocation.get(person.id)!;

    // Rebalance allocation
    const plannedTotal = Object.values(alloc.plannedPoints).reduce((a, b) => a + b, 0);
    if (person.teamIds.length > 1 && plannedTotal > 0 && alloc.source !== 'planned') {
      const plannedShare = Object.fromEntries(person.teamIds.map((t) => [t, (alloc.plannedPoints[t] ?? 0) / plannedTotal]));
      const maxDiff = Math.max(...person.teamIds.map((t) => Math.abs((alloc.shares[t] ?? 0) - plannedShare[t])));
      if (maxDiff > 0.2) {
        const rounded = Object.fromEntries(person.teamIds.map((t) => [t, Math.round(plannedShare[t] * 20) / 20]));
        const sum = Object.values(rounded).reduce((a, b) => a + b, 0) || 1;
        const to = Object.fromEntries(Object.entries(rounded).map(([t, v]) => [t, round1((v / sum) * 100) / 100]));
        const fmt = (s: Record<string, number>) => person.teamIds.map((t) => `${model.teams.get(t)!.key} ${pct(s[t] ?? 0)}`).join(' / ');
        recs.push({
          id: `alloc:${person.id}:${person.teamIds.map((t) => to[t]).join('-')}`,
          rule: 'rebalance-allocation',
          destination: 'planner',
          severity: 'medium',
          title: `Set ${name(person.id)}'s split to ${fmt(to)}`,
          summary: `Team capacity assumes ${name(person.id)} splits time ${fmt(alloc.shares)} (${alloc.source}), but scheduled work in this range is ${fmt(plannedShare)}. Each team's capacity view over- or under-counts them.`,
          group: `alloc:${person.id}`,
          changes: [{ kind: 'planner.allocation', personId: person.id, from: planner.allocations[person.id] ?? null, to }],
          personId: person.id,
          evidence: evidence(
            {
              metric: { label: `${name(person.id)} time split`, value: `assumed ${fmt(alloc.shares)} vs scheduled ${fmt(plannedShare)}`, threshold: 'differs by more than 20 points' },
              rationale: [
                alloc.source === 'history'
                  ? 'The assumed split comes from completed points per team over the lookback cycles.'
                  : alloc.source === 'override'
                    ? 'The assumed split is a planner override set earlier.'
                    : 'With no history the split defaults to even.',
                'Shared people are the most common hidden overcommitment: each team plans as if it has them.',
                'Time splits have no Linear field, so this stays in the planner and only changes team-level capacity.',
              ],
              facts: person.teamIds.map((t) => ({
                label: model.teams.get(t)!.name,
                value: `assumed ${pct(alloc.shares[t] ?? 0)} · history ${pts(alloc.historyPoints[t] ?? 0)} · scheduled in range ${pts(alloc.plannedPoints[t] ?? 0)}`,
              })),
            },
            'rebalance-allocation',
          ),
        });
      }
    }

    // Velocity override
    const v = model.velocity.get(person.id)!;
    if (v.source !== 'override' && plannedTotal > 0) {
      const avgs = person.teamIds.map((t) => teamAvg.get(t)).filter((x): x is number => x != null);
      const avg = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
      let to: number | null = null;
      let why: string[] = [];
      if ((v.source === 'team-average' || v.source === 'default') && v.completedIssues < 3) {
        to = round1(v.value * 0.6) || 0.1;
        why = [
          `${name(person.id)} completed ${v.completedIssues} issue${v.completedIssues === 1 ? '' : 's'} in the lookback window, too few to measure, so capacity uses the ${v.source === 'default' ? 'default' : 'team average'} velocity of ${round1(v.value)} pts/day.`,
          'New joiners typically ramp over their first cycles; the proposed value is a 60% ramp-up assumption — edit it before accepting.',
        ];
      } else if (v.source === 'history' && v.completedIssues < 5 && avg && Math.abs(v.value - avg) / avg > 0.4) {
        to = round1(avg);
        why = [
          `Velocity of ${round1(v.value)} pts/day is measured from only ${v.completedIssues} completed issues and differs from the team average (${round1(avg)}) by ${pct(Math.abs(v.value - avg) / avg)}.`,
          'Small samples swing widely; the team average is a steadier assumption until more history exists.',
        ];
      }
      if (to != null && to > 0) {
        recs.push({
          id: `velocity:${person.id}:${to}`,
          rule: 'velocity-override',
          destination: 'planner',
          severity: 'low',
          title: `Set ${name(person.id)}'s velocity to ${to} pts/day`,
          summary: `Capacity for ${name(person.id)} is based on too little history (${v.completedIssues} completed issues).`,
          group: `velocity:${person.id}`,
          editable: true,
          changes: [{ kind: 'planner.velocity', personId: person.id, from: planner.velocityOverrides[person.id] ?? null, to }],
          personId: person.id,
          evidence: evidence(
            {
              metric: { label: `${name(person.id)} velocity`, value: `${round1(v.value)} pts/day (${v.source})`, threshold: 'needs 3+ completed issues and 5+ available days' },
              rationale: [...why, 'Velocity is a planning assumption, so it stays in the planner.'],
              facts: [
                { label: 'Lookback window', value: v.window ? `${v.window.start} → ${v.window.end}` : 'no completed cycles' },
                { label: 'Completed', value: `${v.completedIssues} issues, ${pts(v.points)}` },
                { label: 'Available days', value: `${round1(v.availableDays)} (after ${round1(v.oooDays)} OOO days)` },
              ],
              cycles: v.cycles,
              issues: v.issueIds.map((id) => ({ issueId: id })),
            },
            'velocity-override',
          ),
        });
      }
    }
  }

  // --- OOO data quality --------------------------------------------------------
  if (ooo) {
    const byEmail = new Map<string, typeof ooo.problems>();
    for (const p of ooo.problems) {
      const key = p.email ?? `row ${p.row}`;
      byEmail.set(key, [...(byEmail.get(key) ?? []), p]);
    }
    for (const [email, problems] of byEmail) {
      const rows = problems.map((p) => p.row);
      const hasError = problems.some((p) => p.severity === 'error');
      recs.push({
        id: `ooo:${email}:${rows.join('-')}`,
        rule: 'ooo-data',
        destination: 'csv',
        severity: hasError ? 'high' : 'low',
        title: `Fix OOO data for ${email} (row${rows.length === 1 ? '' : 's'} ${rows.join(', ')})`,
        summary: problems.map((p) => p.message).join(' '),
        group: `ooo:${email}`,
        changes: [{ kind: 'csv.ooo', email, rows, note: problems.map((p) => p.message).join(' ') }],
        evidence: evidence(
          {
            metric: { label: ooo.fileName, value: `${problems.length} problem${problems.length === 1 ? '' : 's'}` },
            rationale: [
              hasError
                ? 'These rows were skipped, so the absence is not reflected in anyone\'s capacity.'
                : 'These rows were applied, but look wrong; double-check them in the source.',
              'OOO is read-only here: fix it in your HR system, export a new CSV, and import it.',
            ],
            oooProblemRows: rows,
          },
          'ooo-data',
        ),
      });
    }
  }

  // Hide what was dismissed or already acted on.
  const dismissed = new Set(planner.dismissed);
  const activeGroups = new Set<string>();
  const activeIds = new Set<string>();
  for (const e of planner.ledger) {
    if (e.status === 'reverted' || e.status === 'failed') continue;
    activeIds.add(e.recommendationId);
    activeGroups.add(e.group);
  }
  return recs
    .filter((r) => !dismissed.has(r.id) && !activeIds.has(r.id) && !activeGroups.has(r.group))
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
