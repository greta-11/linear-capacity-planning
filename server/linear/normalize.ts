import { dayInTimezone } from '../../shared/calendar';
import type { Cycle, Issue, Person, Snapshot, StateType, Team } from '../../shared/types';

// Raw GraphQL shapes → domain model.

export interface RawUser {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  active: boolean;
}

export interface RawTeam {
  id: string;
  key: string;
  name: string;
  cyclesEnabled: boolean;
  cycleDuration: number | null;
  issueEstimationType: string;
  timezone: string | null;
  members: { nodes: RawUser[] };
}

export interface RawCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  team: { id: string };
}

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number | null;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  state: { type: string; name: string } | null;
  assignee: RawUser | null;
  team: { id: string };
  cycle: { id: string } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string }[] } | null;
  history?: { nodes: { createdAt: string; toCycleId: string | null }[] };
}

const STATE_TYPES: StateType[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

export function normalizeSnapshot(raw: {
  organization: { name: string; urlKey: string };
  teams: RawTeam[];
  cycles: RawCycle[];
  issues: RawIssue[];
  fetchedAt: string;
}): Snapshot {
  const people = new Map<string, Person>();
  const addPerson = (u: RawUser, teamId: string | null) => {
    const p = people.get(u.id) ?? {
      id: u.id,
      name: u.name,
      displayName: u.displayName || u.name,
      email: (u.email ?? '').toLowerCase(),
      avatarUrl: u.avatarUrl,
      active: u.active,
      teamIds: [],
    };
    if (teamId && !p.teamIds.includes(teamId)) p.teamIds.push(teamId);
    people.set(u.id, p);
  };

  const teams: Team[] = raw.teams.map((t) => {
    for (const m of t.members.nodes) addPerson(m, t.id);
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      cyclesEnabled: t.cyclesEnabled,
      cycleDuration: t.cycleDuration ?? 1,
      estimationType: t.issueEstimationType,
      timezone: t.timezone || 'UTC',
      memberIds: t.members.nodes.map((m) => m.id),
    };
  });
  const tzOf = new Map(teams.map((t) => [t.id, t.timezone]));

  const cycles: Cycle[] = raw.cycles.map((c) => {
    const tz = tzOf.get(c.team.id) ?? 'UTC';
    // endsAt is the instant the cycle ends, so its last day is the day of the moment just before.
    const lastInstant = new Date(Date.parse(c.endsAt) - 60_000).toISOString();
    return {
      id: c.id,
      teamId: c.team.id,
      number: c.number,
      name: c.name,
      startDate: dayInTimezone(c.startsAt, tz),
      endDate: dayInTimezone(lastInstant, tz),
      completedAt: c.completedAt,
    };
  });

  const issues: Issue[] = raw.issues.map((i) => {
    if (i.assignee) addPerson(i.assignee, null);
    const cycleId = i.cycle?.id ?? null;
    const entered = (i.history?.nodes ?? []).filter((h) => cycleId && h.toCycleId === cycleId).map((h) => h.createdAt).sort();
    const stateType = STATE_TYPES.includes(i.state?.type as StateType) ? (i.state!.type as StateType) : 'backlog';
    return {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      teamId: i.team.id,
      cycleId,
      assigneeId: i.assignee?.id ?? null,
      estimate: i.estimate,
      priority: i.priority ?? 0,
      stateType,
      stateName: i.state?.name ?? stateType,
      projectName: i.project?.name ?? null,
      labels: (i.labels?.nodes ?? []).map((l) => l.name),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      completedAt: i.completedAt,
      canceledAt: i.canceledAt,
      // Latest time it entered this cycle; fall back to creation when history has no cycle event.
      addedToCycleAt: entered.length ? entered[entered.length - 1] : i.history ? i.createdAt : null,
    };
  });

  return {
    source: 'linear',
    organizationName: raw.organization.name,
    urlKey: raw.organization.urlKey,
    fetchedAt: raw.fetchedAt,
    teams,
    people: [...people.values()],
    cycles,
    issues,
  };
}
