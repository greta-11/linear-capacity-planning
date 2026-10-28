import { formatRange, maxDay, type Bucket } from './calendar';
import { isNotStarted, round1, teamWindow, type CapacityModel } from './capacity';
import type { Day } from './types';

// Reassignments and remaining overflow.
//
// For each period (in order) and each person over plannable capacity, move their
// not-started issues — lowest priority first — to the teammate with the most headroom,
// as long as the teammate:
//   - is on the issue's team (same team),
//   - stays within plannable capacity over the issue's cycle (or its spread window),
//   - stays within plannable capacity this period, and
//   - isn't pushed over plannable capacity next period (or in any other period the
//     issue's work reaches, so earlier periods stay balanced).
// What can't be resolved is reported per person, and per team and period as overflow.
// A period that started in the past is judged on its remaining days (today onward): work
// already done can't be moved.

const EPS = 0.05;

export interface Reassignment {
  issueId: string;
  teamId: string;
  from: string;
  to: string;
  bucketIndex: number;
  /** Remaining points of the issue that fall in this period. */
  periodPoints: number;
  /** All remaining points of the issue. */
  remainingPoints: number;
  fromBefore: number | null;
  fromAfter: number | null;
  toBefore: number | null;
  toAfter: number | null;
  /** Recipient's headroom this period and next, before the move. */
  headroom: number;
  headroomNext: number | null;
  rationale: string;
  evidence: ReassignmentEvidence;
}

export interface ConstraintCheck {
  label: string;
  detail: string;
}

/** Everything a reassignment was decided on, shown behind "Show evidence". */
export interface ReassignmentEvidence {
  /** The days judged: the period, from today when it started in the past. */
  window: { start: string; end: string };
  /** The from-person just before this move. */
  trigger: { load: number; plannable: number };
  /** The recipient's numbers that passed each constraint. */
  checks: ConstraintCheck[];
  whyIssue: string;
  whyRecipient: string;
}

export interface Unresolved {
  personId: string;
  teamId: string;
  bucketIndex: number;
  overBy: number;
  reason: string;
  window: { start: string; end: string };
  /** Teammates on the person's teams with their headroom in the window (negative = over). */
  teammates: { personId: string; teamId: string; headroom: number }[];
}

export interface Overflow {
  teamId: string;
  bucketIndex: number;
  teamLoad: number;
  teamPlannable: number;
  /** Points over plannable capacity for the team (≤ 0 when the team has room overall). */
  teamOverBy: number;
  peopleOver: { personId: string; overBy: number }[];
  projects: { projectId: string | null; points: number }[];
  issueIds: string[];
  label: string;
  window: { start: string; end: string };
}

export interface ReassignmentPlan {
  buckets: Bucket[];
  reassignments: Reassignment[];
  unresolved: Unresolved[];
  overflow: Overflow[];
}

const priorityRank = (p: number) => (p === 0 ? 5 : p);
const PRIORITY = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export function planReassignments(model: CapacityModel, buckets: Bucket[]): ReassignmentPlan {
  const name = (id: string) => model.people.get(id)?.displayName ?? 'Unknown';
  const today = model.input.today;
  /** The part of a period still ahead: from today when it started in the past. */
  const windowOf = (b: Bucket) => ({ start: maxDay(b.start, today), end: b.end });
  const label = (b: Bucket) => {
    const w = windowOf(b);
    return w.start > b.start ? `${b.label} (remaining days, ${formatRange(w.start, w.end)})` : b.label;
  };

  // Current assignee of each moved issue.
  const moved = new Map<string, string>();
  const movedFrom = new Map<string, string>();
  const windowCache = new Map<string, { load: number; plannable: number }>();
  const base = (personId: string, start: Day, end: Day) => {
    const key = `${personId}|${start}|${end}`;
    let w = windowCache.get(key);
    if (!w) {
      const pw = model.personWindow(personId, start, end);
      w = { load: pw.load, plannable: pw.plannable };
      windowCache.set(key, w);
    }
    return w;
  };
  /** Load and plannable capacity in a window, with the moves made so far applied. */
  const loadOf = (personId: string, start: Day, end: Day) => {
    const w = base(personId, start, end);
    let load = w.load;
    for (const [issueId, to] of moved) {
      const from = movedFrom.get(issueId)!;
      if (from === to) continue;
      if (from === personId) load -= model.issuePoints(issueId, start, end);
      if (to === personId) load += model.issuePoints(issueId, start, end);
    }
    return { load, plannable: w.plannable };
  };
  const util = (l: { load: number; plannable: number }) => (l.plannable > 0 ? l.load / l.plannable : null);
  const assigneeOf = (issueId: string) => moved.get(issueId) ?? model.issues.get(issueId)!.assigneeId;

  const reassignments: Reassignment[] = [];
  const unresolved: Unresolved[] = [];

  const eligible = (teamId: string) =>
    model.teams.get(teamId)!.memberIds.filter((id) => model.people.get(id)?.active && (model.allocation.get(id)!.shares[teamId] ?? 0) > 0);
  const primaryTeam = (personId: string) => {
    const shares = model.allocation.get(personId)!.shares;
    return [...model.people.get(personId)!.teamIds].sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0))[0];
  };

  buckets.forEach((b, bi) => {
    const bucket = { ...b, ...windowOf(b) };
    if (bucket.start > bucket.end) return;
    const next = buckets[bi + 1];
    // Everyone over plannable capacity this period, most over first. People on several
    // teams are handled once; each issue can only move within its own team.
    const over = [...model.people.values()]
      .filter((p) => p.active && p.teamIds.length)
      .map((p) => ({ id: p.id, ...loadOf(p.id, bucket.start, bucket.end) }))
      .filter((m) => m.load > m.plannable + EPS)
      .sort((a, b) => b.load - b.plannable - (a.load - a.plannable));

    for (const { id: personId } of over) {
      const person = model.people.get(personId)!;
      const before = loadOf(personId, bucket.start, bucket.end);
      let reason: string | null = null;
      while (loadOf(personId, bucket.start, bucket.end).load > before.plannable + EPS) {
        // Not-started issues that land in this period, lowest priority first.
        const candidates = person.teamIds
          .flatMap((t) => model.teamItems(t, bucket.start, bucket.end))
          .filter((i) => i.kind !== 'done' && assigneeOf(i.issueId) === personId && !moved.has(i.issueId) && isNotStarted(model.issues.get(i.issueId)!))
          .sort((a, b) => priorityRank(model.issues.get(b.issueId)!.priority) - priorityRank(model.issues.get(a.issueId)!.priority) || b.points - a.points);
        if (!candidates.length) {
          reason = 'only work already in progress remains in this period, which isn’t moved';
          break;
        }
        const hasRoom = (m: string) => {
          const l = loadOf(m, bucket.start, bucket.end);
          return l.plannable - l.load > EPS;
        };
        const teamsWithRoom = person.teamIds.filter((t) => eligible(t).some((m) => m !== personId && hasRoom(m)));
        if (!teamsWithRoom.length) {
          reason = `no ${person.teamIds.map((t) => model.teamName(t)).join(' or ')} teammate has headroom this period`;
          break;
        }
        let best: { to: string; teamId: string; issueId: string; headroom: number; headroomNext: number | null; checks: ConstraintCheck[]; considered: number } | null = null;
        let blockedNext = 0;
        let blockedCycle = 0;
        for (const item of candidates) {
          const spread = model.spreadOf(item.issueId)!;
          const team = model.teamName(item.teamId);
          const fmt = (load: number, add: number, cap: number) => `${round1(load)} + ${round1(add)} = ${round1(load + add)} ≤ ${round1(cap)} pts plannable`;
          const candidates = eligible(item.teamId).filter((m) => m !== personId && hasRoom(m));
          for (const m of candidates) {
            const now = loadOf(m, bucket.start, bucket.end);
            const headroom = now.plannable - now.load;
            if (now.load + item.points > now.plannable + EPS) continue;
            const cyc = loadOf(m, spread.start, spread.end);
            const cycAdd = model.issuePoints(item.issueId, spread.start, spread.end);
            if (cyc.load + cycAdd > cyc.plannable + EPS) {
              blockedCycle++;
              continue;
            }
            // Other periods the issue's work reaches (e.g. an earlier one, already balanced).
            const spills = buckets.some((x, j) => {
              if (j === bi || j === bi + 1) return false;
              const xw = windowOf(x);
              if (xw.start > xw.end) return false;
              const add = model.issuePoints(item.issueId, xw.start, xw.end);
              if (add <= 0) return false;
              const l = loadOf(m, xw.start, xw.end);
              return l.load + add > l.plannable + EPS;
            });
            if (spills) {
              blockedCycle++;
              continue;
            }
            let headroomNext: number | null = null;
            let nextCheck: ConstraintCheck = { label: 'No new overload next period', detail: 'No later period in view.' };
            if (next) {
              const n = loadOf(m, next.start, next.end);
              headroomNext = n.plannable - n.load;
              const add = model.issuePoints(item.issueId, next.start, next.end);
              if (add > 0 && n.load + add > n.plannable + EPS) {
                blockedNext++;
                continue;
              }
              nextCheck = {
                label: 'No new overload next period',
                detail: add > 0 ? `${next.label}: ${fmt(n.load, add, n.plannable)}` : `${next.label}: the issue has no work there; ${name(m)} is at ${round1(n.load)} of ${round1(n.plannable)} pts.`,
              };
            }
            if (!best || headroom > best.headroom) {
              best = {
                to: m,
                teamId: item.teamId,
                issueId: item.issueId,
                headroom,
                headroomNext,
                considered: candidates.length,
                checks: [
                  { label: 'Same team', detail: `${name(m)} is a member of ${team}, the issue's team.` },
                  {
                    label: spread.cycle ? "Within limit over the issue's cycle" : "Within limit over the issue's spread window",
                    detail: `${spread.cycle ? model.cycleLabel(spread.cycle.id) : 'To its due/target date'} (${formatRange(spread.start, spread.end)}): ${fmt(cyc.load, cycAdd, cyc.plannable)}`,
                  },
                  { label: 'Within limit this period', detail: `${formatRange(bucket.start, bucket.end)}: ${fmt(now.load, item.points, now.plannable)}` },
                  nextCheck,
                ],
              };
            }
          }
          if (best) break;
        }
        if (!best) {
          reason = blockedNext
            ? 'teammates with room this period would go over capacity next period'
            : blockedCycle
              ? 'teammates with room this period would go over capacity within the issue’s cycle'
              : 'no remaining issue fits within a teammate’s headroom';
          break;
        }
        const issue = model.issues.get(best.issueId)!;
        const trigger = loadOf(personId, bucket.start, bucket.end);
        const fromBefore = util(trigger);
        const toBefore = util(loadOf(best.to, bucket.start, bucket.end));
        movedFrom.set(issue.id, personId);
        moved.set(issue.id, best.to);
        const fromAfter = util(loadOf(personId, bucket.start, bucket.end));
        const toAfter = util(loadOf(best.to, bucket.start, bucket.end));
        const nextAfter = next ? util(loadOf(best.to, next.start, next.end)) : null;
        const room = `${name(best.to)} has ${round1(best.headroom)} pts of headroom this period${best.headroomNext != null ? ` and ${round1(Math.max(0, best.headroomNext))} next` : ''}`;
        reassignments.push({
          issueId: issue.id,
          teamId: best.teamId,
          from: personId,
          to: best.to,
          bucketIndex: bi,
          periodPoints: model.issuePoints(issue.id, bucket.start, bucket.end),
          remainingPoints: model.spreadOf(issue.id)!.points,
          fromBefore,
          fromAfter,
          toBefore,
          toAfter,
          headroom: best.headroom,
          headroomNext: best.headroomNext,
          rationale: `${room}; they'd be at ${pct(toAfter)}${next ? ` this period and ${pct(nextAfter)} next` : ''}. ${name(personId)} goes from ${pct(fromBefore)} to ${pct(fromAfter)}.`,
          evidence: {
            window: { start: bucket.start, end: bucket.end },
            trigger: { load: trigger.load, plannable: trigger.plannable },
            checks: best.checks,
            whyIssue: `${issue.stateName} (not started) and ${PRIORITY[issue.priority] ?? 'No priority'} priority: ${name(personId)}'s lowest-priority not-started issue in this period that fits a teammate's headroom. Work already started isn't moved.`,
            whyRecipient: `Most headroom this period among ${best.considered} ${model.teamName(best.teamId)} teammate${best.considered === 1 ? '' : 's'} with room who pass every check.`,
          },
        });
      }
      const after = loadOf(personId, bucket.start, bucket.end);
      if (after.load > after.plannable + EPS) {
        unresolved.push({
          personId,
          teamId: primaryTeam(personId),
          bucketIndex: bi,
          overBy: after.load - after.plannable,
          reason: reason ?? 'no remaining issue fits within a teammate’s headroom',
          window: { start: bucket.start, end: bucket.end },
          teammates: person.teamIds.flatMap((t) =>
            eligible(t)
              .filter((m) => m !== personId)
              .map((m) => {
                const l = loadOf(m, bucket.start, bucket.end);
                return { personId: m, teamId: t, headroom: l.plannable - l.load };
              }),
          ),
        });
      }
    }
  });

  // Remaining overflow after all reassignments, per team and period.
  const overflow: Overflow[] = [];
  buckets.forEach((b, bi) => {
    const bucket = { ...b, ...windowOf(b) };
    if (bucket.start > bucket.end) return;
    for (const team of model.teams.values()) {
      const tw = teamWindow(model, team.id, bucket.start, bucket.end);
      const teamOverBy = tw.load - tw.plannable;
      const peopleOver = team.memberIds
        .filter((id) => model.people.get(id)?.active)
        .map((id) => {
          const l = loadOf(id, bucket.start, bucket.end);
          return { personId: id, overBy: l.load - l.plannable };
        })
        .filter((p) => p.overBy > EPS)
        .sort((a, b) => b.overBy - a.overBy);
      if (teamOverBy <= EPS && !peopleOver.length) continue;
      const projects = Object.entries(tw.byProject)
        .map(([projectId, v]) => ({ projectId: projectId === 'none' ? null : projectId, points: v.points }))
        .sort((a, b) => b.points - a.points);
      const overIds = new Set(peopleOver.map((p) => p.personId));
      const pointsById = new Map<string, number>();
      for (const i of tw.items) {
        if (teamOverBy <= EPS && !overIds.has(assigneeOf(i.issueId) ?? '')) continue;
        pointsById.set(i.issueId, (pointsById.get(i.issueId) ?? 0) + i.points);
      }
      const issueIds = [...pointsById.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const names = peopleOver.map((p) => name(p.personId));
      const text =
        teamOverBy > EPS
          ? `${team.name} exceeds capacity by ${round1(teamOverBy)} pts in ${label(b)} after reassignment. Requires a scope or timeline decision.`
          : `${team.name} has capacity overall in ${label(b)}, but ${names.join(', ')} ${names.length === 1 ? 'remains' : 'remain'} over (${peopleOver
              .map((p) => `${round1(p.overBy)} pts`)
              .join(', ')}) after reassignment. Their remaining work can't be moved within the constraints.`;
      overflow.push({
        teamId: team.id,
        bucketIndex: bi,
        teamLoad: tw.load,
        teamPlannable: tw.plannable,
        teamOverBy,
        peopleOver,
        projects,
        issueIds,
        label: text,
        window: { start: bucket.start, end: bucket.end },
      });
    }
  });

  return { buckets, reassignments, unresolved, overflow };
}
