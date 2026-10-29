import { isOpen, type CapacityModel } from './capacity';

// Data hygiene: open issues missing what the planner needs. These are fixed in Linear,
// not here; the app only points at them.

export type HygieneFlag = 'noDate' | 'noEstimate' | 'noProject';

export const HYGIENE_FLAGS: HygieneFlag[] = ['noDate', 'noEstimate', 'noProject'];

export const HYGIENE_INFO: Record<HygieneFlag, { label: string; short: string; why: string; fix: string }> = {
  noDate: {
    label: 'No date',
    short: 'no date',
    why: "Not in a cycle, with no due date and no project target date. The planner can't place it in time, so it isn't counted in anyone's capacity.",
    fix: 'Add it to a cycle, set a due date, or put it in a project with a target date.',
  },
  noEstimate: {
    label: 'No estimate',
    short: 'no estimate',
    why: "Left out of capacity until it's estimated.",
    fix: 'Estimate it.',
  },
  noProject: {
    label: 'No project',
    short: 'no project',
    why: "Can't be attributed to a project in the heat map's project view or in remaining overflow.",
    fix: 'Add it to a project.',
  },
};

export interface HygieneIssue {
  issueId: string;
  teamId: string;
  assigneeId: string | null;
  flags: HygieneFlag[];
}

export interface HygieneSummary {
  /** Open issues checked. */
  checked: number;
  /** Issues with at least one flag. */
  flagged: number;
  counts: Record<HygieneFlag, number>;
  byTeam: { teamId: string; checked: number; counts: Record<HygieneFlag, number> }[];
  issues: HygieneIssue[];
}

const zero = (): Record<HygieneFlag, number> => ({ noDate: 0, noEstimate: 0, noProject: 0 });

export function issueFlags(model: CapacityModel, issueId: string): HygieneFlag[] {
  const issue = model.issues.get(issueId)!;
  const flags: HygieneFlag[] = [];
  const cycle = issue.cycleId ? model.cycles.get(issue.cycleId) : undefined;
  const inCycle = cycle != null && !model.isCompletedCycle(cycle);
  const target = issue.projectId ? model.projects.get(issue.projectId)?.targetDate : null;
  if (!inCycle && !issue.dueDate && !target) flags.push('noDate');
  if (model.teams.get(issue.teamId)?.estimationType !== 'notUsed' && issue.estimate == null) flags.push('noEstimate');
  if (!issue.projectId) flags.push('noProject');
  return flags;
}

export function summarizeHygiene(model: CapacityModel): HygieneSummary {
  const counts = zero();
  const teams = new Map<string, { checked: number; counts: Record<HygieneFlag, number> }>();
  const issues: HygieneIssue[] = [];
  let checked = 0;
  for (const issue of model.issues.values()) {
    if (!isOpen(issue)) continue;
    checked++;
    const t = teams.get(issue.teamId) ?? { checked: 0, counts: zero() };
    t.checked++;
    teams.set(issue.teamId, t);
    const flags = issueFlags(model, issue.id);
    if (!flags.length) continue;
    for (const f of flags) {
      counts[f]++;
      t.counts[f]++;
    }
    issues.push({ issueId: issue.id, teamId: issue.teamId, assigneeId: issue.assigneeId, flags });
  }
  return {
    checked,
    flagged: issues.length,
    counts,
    byTeam: [...teams.entries()].map(([teamId, v]) => ({ teamId, ...v })).sort((a, b) => model.teamName(a.teamId).localeCompare(model.teamName(b.teamId))),
    issues: issues.sort((a, b) => b.flags.length - a.flags.length || model.issues.get(a.issueId)!.identifier.localeCompare(model.issues.get(b.issueId)!.identifier, undefined, { numeric: true })),
  };
}
