import { addDays } from '../../shared/calendar';
import type { Day, Snapshot } from '../../shared/types';
import { gql, paginate } from './client';
import { normalizeSnapshot, type RawCycle, type RawIssue, type RawProject, type RawTeam, type RawUser } from './normalize';

// Linear caps every query at 10,000 complexity points, scored from the requested page
// sizes (not the data returned): 0.1 per field, 1 per object, and each connection
// multiplies its children by `first` (default 50). Nested connections multiply, so
// each query keeps at most one large page and fetches anything else in its own query.
// tests/linear-queries.test.ts estimates every query below and fails past 5,000.

const ORG = /* GraphQL */ `
  query Org {
    organization { name urlKey }
    viewer { id name email }
  }
`;

// Teams without members: nesting members inside the teams page multiplied the two page
// sizes (50 × 250) and exceeded the limit. Members are fetched per team below.
const TEAMS = /* GraphQL */ `
  query Teams($after: String) {
    teams(first: 50, after: $after) {
      nodes { id key name cyclesEnabled cycleDuration issueEstimationType timezone }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const TEAM_MEMBERS = /* GraphQL */ `
  query TeamMembers($teamId: String!, $after: String) {
    team(id: $teamId) {
      members(first: 100, after: $after) {
        nodes { id name displayName email avatarUrl active }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const CYCLES = /* GraphQL */ `
  query Cycles($teamId: ID!, $since: DateTimeOrDuration!, $after: String) {
    cycles(first: 50, after: $after, filter: { team: { id: { eq: $teamId } }, endsAt: { gt: $since } }) {
      nodes { id number name startsAt endsAt completedAt team { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES = /* GraphQL */ `
  query Issues($cycleIds: [ID!], $withHistory: Boolean!, $after: String) {
    issues(first: 50, after: $after, filter: { cycle: { id: { in: $cycleIds } } }) {
      nodes {
        id identifier title url priority estimate dueDate createdAt updatedAt completedAt canceledAt
        state { type name }
        assignee { id name displayName email avatarUrl active }
        team { id }
        cycle { id }
        project { id name }
        labels(first: 10) { nodes { name } }
        history(first: 25) @include(if: $withHistory) { nodes { createdAt toCycleId } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Open projects (not completed or canceled), for target dates and project risk.
const PROJECTS = /* GraphQL */ `
  query Projects($after: String) {
    projects(first: 50, after: $after, filter: { completedAt: { null: true }, canceledAt: { null: true } }) {
      nodes {
        id name url targetDate startDate progress health
        status { type name }
        lead { id }
        teams(first: 20) { nodes { id } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Open issues of those projects, including backlog issues with no cycle.
const PROJECT_ISSUES = /* GraphQL */ `
  query ProjectIssues($projectIds: [ID!], $after: String) {
    issues(first: 50, after: $after, filter: { project: { id: { in: $projectIds } }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes {
        id identifier title url priority estimate dueDate createdAt updatedAt completedAt canceledAt
        state { type name }
        assignee { id name displayName email avatarUrl active }
        team { id }
        cycle { id }
        project { id name }
        labels(first: 10) { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Open, assigned work with no cycle and no project. Without a due date it can't be placed
// in time, so Data hygiene flags it; with one, it counts as unscheduled load.
const LOOSE_ISSUES = /* GraphQL */ `
  query LooseIssues($teamIds: [ID!], $after: String) {
    issues(
      first: 50
      after: $after
      filter: { team: { id: { in: $teamIds } }, cycle: { null: true }, project: { null: true }, assignee: { null: false }, state: { type: { in: ["unstarted", "started"] } } }
    ) {
      nodes {
        id identifier title url priority estimate dueDate createdAt updatedAt completedAt canceledAt
        state { type name }
        assignee { id name displayName email avatarUrl active }
        team { id }
        cycle { id }
        project { id name }
        labels(first: 10) { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Every query, for the complexity budget test. */
export const QUERIES = { ORG, TEAMS, TEAM_MEMBERS, CYCLES, ISSUES, PROJECTS, PROJECT_ISSUES, LOOSE_ISSUES };

interface Conn<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export async function fetchViewer(apiKey: string) {
  return gql<{ organization: { name: string; urlKey: string }; viewer: { id: string; name: string; email: string } }>(apiKey, ORG);
}

/** Pulls teams, members, recent + upcoming cycles and their issues. */
export async function fetchSnapshot(apiKey: string, today: Day, lookbackCycles: number, onProgress?: (msg: string) => void): Promise<Snapshot> {
  const { organization } = await fetchViewer(apiKey);
  const teamList = await paginate<{ teams: Conn<Omit<RawTeam, 'members'>> }, Omit<RawTeam, 'members'>>(apiKey, TEAMS, {}, (d) => d.teams);
  const teams: RawTeam[] = [];
  for (const team of teamList) {
    const members = await paginate<{ team: { members: Conn<RawUser> } }, RawUser>(apiKey, TEAM_MEMBERS, { teamId: team.id }, (d) => d.team.members);
    teams.push({ ...team, members: { nodes: members } });
  }
  onProgress?.(`${teams.length} teams, ${new Set(teams.flatMap((t) => t.members.nodes.map((m) => m.id))).size} members`);

  const cycles: RawCycle[] = [];
  for (const team of teams.filter((t) => t.cyclesEnabled)) {
    // Enough history for the velocity lookback plus a margin, and every upcoming cycle.
    const since = `${addDays(today, -7 * Math.max(1, team.cycleDuration ?? 1) * (lookbackCycles + 3))}T00:00:00.000Z`;
    cycles.push(...(await paginate<{ cycles: Conn<RawCycle> }, RawCycle>(apiKey, CYCLES, { teamId: team.id, since }, (d) => d.cycles)));
  }
  onProgress?.(`${cycles.length} cycles`);

  // History is only needed where we classify planned vs unplanned: started cycles.
  const started = cycles.filter((c) => c.startsAt.slice(0, 10) <= today).map((c) => c.id);
  const future = cycles.filter((c) => c.startsAt.slice(0, 10) > today).map((c) => c.id);
  const issues: RawIssue[] = [];
  for (const [ids, withHistory] of [
    [started, true],
    [future, false],
  ] as const) {
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, ISSUES, { cycleIds: chunk, withHistory }, (d) => d.issues)));
    }
  }
  const projects = await paginate<{ projects: Conn<RawProject> }, RawProject>(apiKey, PROJECTS, {}, (d) => d.projects);
  onProgress?.(`${projects.length} open projects`);
  const projectIds = projects.map((p) => p.id);
  for (let i = 0; i < projectIds.length; i += 10) {
    const chunk = projectIds.slice(i, i + 10);
    issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, PROJECT_ISSUES, { projectIds: chunk }, (d) => d.issues)));
  }
  const teamIds = teams.map((t) => t.id);
  for (let i = 0; i < teamIds.length; i += 10) {
    const chunk = teamIds.slice(i, i + 10);
    issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, LOOSE_ISSUES, { teamIds: chunk }, (d) => d.issues)));
  }
  onProgress?.(`${issues.length} issues (cycle, project and other assigned work)`);

  return normalizeSnapshot({ organization, teams, cycles, issues, projects, fetchedAt: new Date().toISOString() });
}
