import { formatRange, maxDay, type Bucket } from './calendar';
import { HAS_ROOM, isNotStarted, teamWindow, type CapacityModel } from './capacity';
import type { Day } from './types';

// Reassignments and remaining overflow.
//
// Moves spread the load: for each period (in order) and each person over plannable
// capacity, most over first, their not-started issues (lowest priority first) go to
// whoever ends up least loaded, as long as the move narrows the gap between the two:
//   - afterwards the recipient is within capacity, or no more over it than the donor, this
//     period and in every other period (and the cycle or spread window) the work reaches, and
//   - the gap between them shrinks by at least MIN_GAIN points.
// Recipients who stay at or under HAS_ROOM (90%) are preferred, but both people may still
// be over afterwards: spreading the load still helps. Whoever is still over then gets
// defer suggestions (their lowest-priority not-started work to push to a later cycle), and
// each team gets its share of what's left over.
// Same-team moves come first; then cross-team borrows, to people on other teams that work
// on the same project. A period that started in the past is judged on its remaining days.

const EPS = 0.05;
const MIN_GAIN = 1;

export type ReassignmentKind = 'same-team' | 'borrow';

export interface Reassignment {
  kind: ReassignmentKind;
  issueId: string;
  /** The issue's team. For a borrow, the recipient's team is `toTeamId`. */
  teamId: string;
  toTeamId: string;
  from: string;
  to: string;
  bucketIndex: number;
  /** Remaining points of the issue that fall in this period. */
  periodPoints: number;
  /** All remaining points of the issue. */
  remainingPoints: number;
  /** Utilization this period, before and after the move. */
  fromBefore: number | null;
  fromAfter: number | null;
  toBefore: number | null;
  toAfter: number | null;
  /** Both people are still over capacity after the move (it only spreads the load). */
  bothStillOver: boolean;
  evidence: ReassignmentEvidence;
}

export interface ConstraintCheck {
  label: string;
  detail: string;
  /** False for a preference that wasn't met (e.g. the recipient goes over 90%). */
  ok: boolean;
}

/** Everything a reassignment was decided on, shown behind "Show evidence". */
export interface ReassignmentEvidence {
  /** The days judged: the period, from today when it started in the past. */
  window: { start: string; end: string };
  /** The from-person just before this move. */
  trigger: { load: number; plannable: number };
  checks: ConstraintCheck[];
  whyIssue: string;
  whyRecipient: string;
}

/**
 * A scope or timeline suggestion for someone still over capacity after every move: defer
 * one of their lowest-priority not-started issues to a later cycle, or (when only started
 * work is left) re-plan it. Suggestions only; nothing is applied.
 */
export interface Deferral {
  kind: 'defer' | 'replan';
  personId: string;
  /** The issue's team for a defer; the team holding most of the person's load for a re-plan. */
  teamId: string;
  issueId: string | null;
  bucketIndex: number;
  /** Points this frees in the period. */
  periodPoints: number;
  /** The person's utilization this period before and after (after earlier deferrals). */
  before: number | null;
  after: number | null;
  /** Still over after this deferral, in points (0 when it covers the overage). */
  stillOverBy: number;
  evidence: DeferralEvidence;
}

export interface DeferralEvidence {
  window: { start: string; end: string };
  trigger: { load: number; plannable: number };
  whyIssue: string;
  /** Points the issue frees in later periods in view, by period label. */
  later: { label: string; points: number }[];
  /** The team's projects driving its load this period, and others on the team still over. */
  projects: { projectId: string | null; points: number }[];
  othersOver: string[];
  /** For a re-plan: the started issues that can't be moved. */
  startedIssueIds: string[];
}

/** A team's share of the overload left after every move. Shared people aren't counted twice. */
export interface Overflow {
  teamId: string;
  bucketIndex: number;
  /** Points over attributed to this team's work. */
  share: number;
  window: { start: string; end: string };
}

export interface ReassignmentPlan {
  buckets: Bucket[];
  reassignments: Reassignment[];
  deferrals: Deferral[];
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
  const excess = (l: { load: number; plannable: number }) => l.load - l.plannable;
  const assigneeOf = (issueId: string) => moved.get(issueId) ?? model.issues.get(issueId)!.assigneeId;

  const members = (teamId: string) => model.teams.get(teamId)!.memberIds.filter((id) => model.inPlan(id));

  // Teams working on each project: those with its work in any period in view, plus the
  // project's own team list in Linear.
  const projectTeams = new Map<string, Set<string>>();
  for (const id of model.teams.keys()) {
    for (const b of buckets) {
      for (const i of model.teamItems(id, b.start, b.end)) {
        if (!i.projectId) continue;
        const set = projectTeams.get(i.projectId) ?? new Set<string>();
        set.add(id);
        projectTeams.set(i.projectId, set);
      }
    }
  }
  for (const p of model.projects.values()) {
    const set = projectTeams.get(p.id) ?? new Set<string>();
    for (const t of p.teamIds) if (model.teams.has(t)) set.add(t);
    projectTeams.set(p.id, set);
  }

  /** The team holding most of a person's load in a window. */
  const mainTeam = (personId: string, start: Day, end: Day) => {
    const w = model.personWindow(personId, start, end);
    const byTeam = new Map<string, number>();
    for (const i of w.items) byTeam.set(i.teamId, (byTeam.get(i.teamId) ?? 0) + i.points);
    const top = [...byTeam.entries()].sort((a, b) => b[1] - a[1])[0];
    return top?.[0] ?? model.people.get(personId)!.teamIds[0];
  };

  const reassignments: Reassignment[] = [];
  const stillOver: { personId: string; bi: number; bucket: { start: Day; end: Day; label: string } }[] = [];

  interface Option {
    to: string;
    toTeamId: string;
    issueId: string;
    toAfterUtil: number | null;
    room: boolean;
    checks: ConstraintCheck[];
  }

  /**
   * The best recipient for one issue among `pool`, or null when no move narrows the gap.
   * `bucket` is the period's remaining window.
   */
  const bestOption = (
    personId: string,
    issueId: string,
    pool: { id: string; teamId: string }[],
    bi: number,
    bucket: { start: Day; end: Day; label: string },
    kind: ReassignmentKind,
  ): Option | null => {
    const spread = model.spreadOf(issueId)!;
    const issue = model.issues.get(issueId)!;
    const points = model.issuePoints(issueId, bucket.start, bucket.end);
    const fromNow = loadOf(personId, bucket.start, bucket.end);
    // Every other window the issue's work reaches: the other periods, and its cycle or spread.
    const others = [
      ...buckets
        .map((x, j) => ({ ...windowOf(x), label: x.label, j }))
        .filter((x) => x.j !== bi && x.start <= x.end && model.issuePoints(issueId, x.start, x.end) > 0),
      { start: spread.start, end: spread.end, label: spread.cycle ? model.cycleLabel(spread.cycle.id) : 'its spread window', j: -1 },
    ];
    let best: Option | null = null;
    for (const { id: m, teamId } of pool) {
      if (m === personId) continue;
      const toNow = loadOf(m, bucket.start, bucket.end);
      const fromAfter = { load: fromNow.load - points, plannable: fromNow.plannable };
      const toAfter = { load: toNow.load + points, plannable: toNow.plannable };
      // Narrow the gap this period, by at least MIN_GAIN: the recipient ends within capacity
      // or no more over it than the donor.
      if (excess(toAfter) > Math.max(excess(fromAfter), 0) + EPS) continue;
      const gain = excess(fromNow) - excess(toNow) - Math.abs(excess(fromAfter) - excess(toAfter));
      if (gain < MIN_GAIN - EPS) continue;
      // ...and never leave the recipient more over than the donor anywhere else it lands.
      const spills = others.some((x) => {
        const add = model.issuePoints(issueId, x.start, x.end);
        if (add <= 0) return false;
        const f = loadOf(personId, x.start, x.end);
        const t = loadOf(m, x.start, x.end);
        return excess({ load: t.load + add, plannable: t.plannable }) > Math.max(excess({ load: f.load - add, plannable: f.plannable }), 0) + EPS;
      });
      if (spills) continue;
      const toAfterUtil = util(toAfter);
      const room = toAfterUtil != null && toAfterUtil <= HAS_ROOM + 1e-9;
      const better = !best || (room && !best.room) || (room === best.room && (toAfterUtil ?? Infinity) < (best.toAfterUtil ?? Infinity));
      if (!better) continue;
      const project = issue.projectId ? model.projects.get(issue.projectId)?.name : null;
      best = {
        to: m,
        toTeamId: teamId,
        issueId,
        toAfterUtil,
        room,
        checks: [
          kind === 'same-team'
            ? { label: 'Same team', detail: `${name(m)} is on ${model.teamName(teamId)}, the issue's team.`, ok: true }
            : { label: 'Works on the same project', detail: `${name(m)} is on ${model.teamName(teamId)}, which works on ${project ?? 'this project'}.`, ok: true },
          {
            label: 'Narrows the gap this period',
            detail: `${formatRange(bucket.start, bucket.end)}: ${name(m)} ${pct(util(toNow))} → ${pct(toAfterUtil)}, ${name(personId)} ${pct(util(fromNow))} → ${pct(util(fromAfter))}.`,
            ok: true,
          },
          {
            label: 'Narrows the gap in every period the issue reaches',
            detail:
              others.length > 1
                ? `Checked ${others
                    .filter((x) => x.j >= 0)
                    .map((x) => x.label)
                    .join(', ') || 'no other period'} and ${others[others.length - 1].label}: ${name(m)} is never left more over capacity than ${name(personId)}.`
                : 'The issue has no work in other periods.',
            ok: true,
          },
          room
            ? { label: 'Has room (≤ 90%)', detail: `${name(m)} ends at ${pct(toAfterUtil)}.`, ok: true }
            : { label: 'Has room (≤ 90%)', detail: `No: ${name(m)} ends at ${pct(toAfterUtil)}. Nobody could take it and stay at or under 90%; this move spreads the load.`, ok: false },
        ],
      };
    }
    return best;
  };

  buckets.forEach((b, bi) => {
    const bucket = { ...b, ...windowOf(b) };
    if (bucket.start > bucket.end) return;
    const over = [...model.people.values()]
      .filter((p) => model.inPlan(p.id) && p.teamIds.length)
      .map((p) => ({ id: p.id, ...loadOf(p.id, bucket.start, bucket.end) }))
      .filter((m) => m.load > m.plannable + EPS)
      .sort((x, y) => y.load - y.plannable - (x.load - x.plannable));

    for (const { id: personId } of over) {
      const person = model.people.get(personId)!;
      for (const kind of ['same-team', 'borrow'] as const) {
        while (loadOf(personId, bucket.start, bucket.end).load > loadOf(personId, bucket.start, bucket.end).plannable + EPS) {
          const candidates = person.teamIds
            .flatMap((t) => model.teamItems(t, bucket.start, bucket.end))
            .filter((i) => i.kind !== 'done' && assigneeOf(i.issueId) === personId && !moved.has(i.issueId) && isNotStarted(model.issues.get(i.issueId)!))
            .sort((x, y) => priorityRank(model.issues.get(y.issueId)!.priority) - priorityRank(model.issues.get(x.issueId)!.priority) || y.points - x.points);
          if (!candidates.length) break;
          let option: Option | null = null;
          for (const item of candidates) {
            const issue = model.issues.get(item.issueId)!;
            const pool =
              kind === 'same-team'
                ? members(item.teamId).map((id) => ({ id, teamId: item.teamId }))
                : [...(issue.projectId ? projectTeams.get(issue.projectId) ?? [] : [])]
                    .filter((t) => t !== item.teamId)
                    .flatMap((t) => members(t).filter((id) => !model.teams.get(item.teamId)!.memberIds.includes(id)).map((id) => ({ id, teamId: t })));
            option = bestOption(personId, item.issueId, pool, bi, bucket, kind);
            if (option) break;
          }
          if (!option) break;
          const issue = model.issues.get(option.issueId)!;
          const before = loadOf(personId, bucket.start, bucket.end);
          const toBefore = util(loadOf(option.to, bucket.start, bucket.end));
          movedFrom.set(issue.id, personId);
          moved.set(issue.id, option.to);
          const fromAfterL = loadOf(personId, bucket.start, bucket.end);
          const toAfterL = loadOf(option.to, bucket.start, bucket.end);
          reassignments.push({
            kind,
            issueId: issue.id,
            teamId: issue.teamId,
            toTeamId: option.toTeamId,
            from: personId,
            to: option.to,
            bucketIndex: bi,
            periodPoints: model.issuePoints(issue.id, bucket.start, bucket.end),
            remainingPoints: model.spreadOf(issue.id)!.points,
            fromBefore: util(before),
            fromAfter: util(fromAfterL),
            toBefore,
            toAfter: util(toAfterL),
            bothStillOver: excess(fromAfterL) > EPS && excess(toAfterL) > EPS,
            evidence: {
              window: { start: bucket.start, end: bucket.end },
              trigger: { load: before.load, plannable: before.plannable },
              checks: option.checks,
              whyIssue: `${issue.stateName} (not started) and ${PRIORITY[issue.priority] ?? 'No priority'} priority: ${name(personId)}'s lowest-priority not-started issue in this period that someone could take. Work already started isn't moved.`,
              whyRecipient:
                kind === 'same-team'
                  ? `Ends up least loaded among ${model.teamName(issue.teamId)} teammates, preferring anyone who stays at or under 90%.`
                  : `No ${model.teamName(issue.teamId)} teammate could take it; ${name(option.to)} ends up least loaded among people on other teams working on this project.`,
            },
          });
        }
        if (loadOf(personId, bucket.start, bucket.end).load <= loadOf(personId, bucket.start, bucket.end).plannable + EPS) break;
      }
      const after = loadOf(personId, bucket.start, bucket.end);
      if (after.load > after.plannable + EPS) stillOver.push({ personId, bi, bucket });
    }
  });

  // Defer suggestions for whoever is still over: their lowest-priority not-started work in
  // the period, at most two issues, stopping once the overage is covered.
  const MAX_DEFERRALS = 2;
  const deferrals: Deferral[] = [];
  for (const { personId, bi, bucket } of stillOver) {
    const start = loadOf(personId, bucket.start, bucket.end);
    const items = model
      .personWindow(personId, bucket.start, bucket.end)
      .items.filter((i) => i.kind !== 'done' && !moved.has(i.issueId));
    const startedIds = [...new Set(items.filter((i) => !isNotStarted(model.issues.get(i.issueId)!)).map((i) => i.issueId))];
    const candidates = items
      .filter((i) => isNotStarted(model.issues.get(i.issueId)!))
      .sort((x, y) => priorityRank(model.issues.get(y.issueId)!.priority) - priorityRank(model.issues.get(x.issueId)!.priority) || y.points - x.points);
    // Moved-in work counts too: the recipient may defer what they were given.
    for (const [issueId, to] of moved) {
      if (to !== personId) continue;
      const pts = model.issuePoints(issueId, bucket.start, bucket.end);
      if (pts > 0 && !candidates.some((c) => c.issueId === issueId)) {
        const issue = model.issues.get(issueId)!;
        candidates.push({ issueId, teamId: issue.teamId, points: pts } as (typeof candidates)[number]);
      }
    }
    const context = (teamId: string) => {
      const tw = teamWindow(model, teamId, bucket.start, bucket.end);
      return {
        projects: Object.entries(tw.byProject)
          .map(([projectId, v]) => ({ projectId: projectId === 'none' ? null : projectId, points: v.points }))
          .sort((x, y) => y.points - x.points),
        othersOver: members(teamId)
          .filter((id) => id !== personId && stillOver.some((o) => o.personId === id && o.bi === bi))
          .map(name),
      };
    };
    const trigger = { load: start.load, plannable: start.plannable };
    const window = { start: bucket.start, end: bucket.end };
    if (!candidates.length) {
      const teamId = mainTeam(personId, bucket.start, bucket.end);
      deferrals.push({
        kind: 'replan',
        personId,
        teamId,
        issueId: null,
        bucketIndex: bi,
        periodPoints: 0,
        before: util(start),
        after: util(start),
        stillOverBy: start.load - start.plannable,
        evidence: {
          window,
          trigger,
          whyIssue: `Only work already in progress remains for ${name(personId)} in this period, and started work isn't moved. Re-plan it: move a date, cut scope, or get help.`,
          later: [],
          ...context(teamId),
          startedIssueIds: startedIds,
        },
      });
      continue;
    }
    let load = start.load;
    for (const item of candidates.slice(0, MAX_DEFERRALS)) {
      if (load <= start.plannable + EPS) break;
      const issue = model.issues.get(item.issueId)!;
      const pts = model.issuePoints(issue.id, bucket.start, bucket.end) || item.points;
      const before = { load, plannable: start.plannable };
      load -= pts;
      const after = { load, plannable: start.plannable };
      deferrals.push({
        kind: 'defer',
        personId,
        teamId: issue.teamId,
        issueId: issue.id,
        bucketIndex: bi,
        periodPoints: pts,
        before: util(before),
        after: util(after),
        stillOverBy: Math.max(0, load - start.plannable),
        evidence: {
          window,
          trigger,
          whyIssue: `${issue.stateName} (not started) and ${PRIORITY[issue.priority] ?? 'No priority'} priority: ${name(personId)}'s lowest-priority not-started work in this period. Nobody on their teams or projects could take it without ending up more loaded.`,
          later: buckets
            .map((x, j) => ({ label: x.label, points: j > bi ? model.issuePoints(issue.id, x.start, x.end) : 0 }))
            .filter((x) => x.points > EPS),
          ...context(issue.teamId),
          startedIssueIds: [],
        },
      });
    }
  }

  // What's left over after all moves, per team and period. Each over-capacity person's
  // excess is split across their teams by where their load is, so a person on three teams
  // isn't counted three times; unassigned team work that pushes the team over adds to it.
  const overflow: Overflow[] = [];
  buckets.forEach((b, bi) => {
    const bucket = { ...b, ...windowOf(b) };
    if (bucket.start > bucket.end) return;
    const shares = new Map<string, number>();
    const add = (teamId: string, pts: number) => shares.set(teamId, (shares.get(teamId) ?? 0) + pts);
    for (const p of model.people.values()) {
      if (!model.inPlan(p.id)) continue;
      const l = loadOf(p.id, bucket.start, bucket.end);
      const over = l.load - l.plannable;
      if (over <= EPS || l.load <= 0) continue;
      const byTeam = new Map<string, number>();
      for (const t of model.teams.keys()) {
        for (const i of model.teamItems(t, bucket.start, bucket.end)) {
          if (assigneeOf(i.issueId) === p.id) byTeam.set(t, (byTeam.get(t) ?? 0) + i.points);
        }
      }
      const total = [...byTeam.values()].reduce((a, x) => a + x, 0);
      for (const [t, pts] of byTeam) if (total > 0) add(t, (over * pts) / total);
    }
    for (const team of model.teams.values()) {
      const tw = teamWindow(model, team.id, bucket.start, bucket.end);
      if (tw.unassigned > EPS) {
        const people = members(team.id).map((id) => loadOf(id, bucket.start, bucket.end));
        const room = people.reduce((a, x) => a + Math.max(0, x.plannable - x.load), 0);
        if (tw.unassigned > room) add(team.id, tw.unassigned - room);
      }
    }
    for (const [teamId, share] of shares) {
      if (share > 0.5) overflow.push({ teamId, bucketIndex: bi, share, window: { start: bucket.start, end: bucket.end } });
    }
  });
  return { buckets, reassignments, deferrals, overflow };
}
