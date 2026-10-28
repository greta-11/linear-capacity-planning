import { addDays } from '../../shared/calendar';
import type { Day, Snapshot } from '../../shared/types';
import { gql, paginate } from './client';
import { normalizeSnapshot, type RawCycle, type RawIssue, type RawProject, type RawTeam, type RawUser } from './normalize';
import type { ViewRef } from './view';

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

// --- View mode: a saved Linear issue view defines the work in scope -----------------

const VIEW = /* GraphQL */ `
  query View($id: String!) {
    customView(id: $id) { id name slugId modelName }
  }
`;

// Every issue the view's filter matches, completed and canceled ones included (showing
// them is a display setting). History tells planned from added-mid-cycle work.
const VIEW_ISSUES = /* GraphQL */ `
  query ViewIssues($id: String!, $after: String) {
    customView(id: $id) {
      issues(first: 50, after: $after) {
        nodes {
          id identifier title url priority estimate dueDate createdAt updatedAt completedAt canceledAt
          state { type name }
          assignee { id name displayName email avatarUrl active }
          team { id }
          cycle { id }
          project { id name }
          labels(first: 10) { nodes { name } }
          history(first: 25) { nodes { createdAt toCycleId } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const PROJECTS_BY_ID = /* GraphQL */ `
  query ProjectsById($ids: [ID!], $after: String) {
    projects(first: 50, after: $after, filter: { id: { in: $ids } }) {
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

// Completed work in the teams' recent cycles, for velocity. A person's throughput isn't
// limited to the view, so this isn't either; completed issues never count as load.
const TEAM_HISTORY = /* GraphQL */ `
  query TeamHistory($cycleIds: [ID!], $after: String) {
    issues(first: 50, after: $after, filter: { cycle: { id: { in: $cycleIds } }, state: { type: { eq: "completed" } } }) {
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
export const QUERIES = { ORG, TEAMS, TEAM_MEMBERS, CYCLES, ISSUES, PROJECTS, PROJECT_ISSUES, LOOSE_ISSUES, VIEW, VIEW_ISSUES, PROJECTS_BY_ID, TEAM_HISTORY };

interface Conn<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export async function fetchViewer(apiKey: string) {
  return gql<{ organization: { name: string; urlKey: string }; viewer: { id: string; name: string; email: string } }>(apiKey, ORG);
}

const chunks = <T,>(list: T[], size = 10) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

async function fetchTeams(apiKey: string, only: Set<string> | null, onProgress?: (msg: string) => void): Promise<RawTeam[]> {
  const teamList = (await paginate<{ teams: Conn<Omit<RawTeam, 'members'>> }, Omit<RawTeam, 'members'>>(apiKey, TEAMS, {}, (d) => d.teams)).filter(
    (t) => !only || only.has(t.id),
  );
  const teams: RawTeam[] = [];
  for (const team of teamList) {
    const members = await paginate<{ team: { members: Conn<RawUser> } }, RawUser>(apiKey, TEAM_MEMBERS, { teamId: team.id }, (d) => d.team.members);
    teams.push({ ...team, members: { nodes: members } });
  }
  onProgress?.(`${teams.length} teams, ${new Set(teams.flatMap((t) => t.members.nodes.map((m) => m.id))).size} members`);
  return teams;
}

async function fetchCycles(apiKey: string, teams: RawTeam[], today: Day, lookbackCycles: number, onProgress?: (msg: string) => void): Promise<RawCycle[]> {
  const cycles: RawCycle[] = [];
  for (const team of teams.filter((t) => t.cyclesEnabled)) {
    // Enough history for the velocity lookback plus a margin, and every upcoming cycle.
    const since = `${addDays(today, -7 * Math.max(1, team.cycleDuration ?? 1) * (lookbackCycles + 3))}T00:00:00.000Z`;
    cycles.push(...(await paginate<{ cycles: Conn<RawCycle> }, RawCycle>(apiKey, CYCLES, { teamId: team.id, since }, (d) => d.cycles)));
  }
  onProgress?.(`${cycles.length} cycles`);
  return cycles;
}

/** Pulls teams, members, recent + upcoming cycles and their issues: from one view, or the whole workspace. */
export async function fetchSnapshot(
  apiKey: string,
  today: Day,
  lookbackCycles: number,
  onProgress?: (msg: string) => void,
  view: ViewRef | null = null,
): Promise<Snapshot> {
  if (view) return fetchViewSnapshot(apiKey, today, lookbackCycles, view, onProgress);
  const { organization } = await fetchViewer(apiKey);
  const teams = await fetchTeams(apiKey, null, onProgress);
  const cycles = await fetchCycles(apiKey, teams, today, lookbackCycles, onProgress);

  // History is only needed where we classify planned vs unplanned: started cycles.
  const started = cycles.filter((c) => c.startsAt.slice(0, 10) <= today).map((c) => c.id);
  const future = cycles.filter((c) => c.startsAt.slice(0, 10) > today).map((c) => c.id);
  const issues: RawIssue[] = [];
  for (const [ids, withHistory] of [
    [started, true],
    [future, false],
  ] as const) {
    for (const chunk of chunks(ids)) {
      issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, ISSUES, { cycleIds: chunk, withHistory }, (d) => d.issues)));
    }
  }
  const projects = await paginate<{ projects: Conn<RawProject> }, RawProject>(apiKey, PROJECTS, {}, (d) => d.projects);
  onProgress?.(`${projects.length} open projects`);
  for (const chunk of chunks(projects.map((p) => p.id))) {
    issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, PROJECT_ISSUES, { projectIds: chunk }, (d) => d.issues)));
  }
  for (const chunk of chunks(teams.map((t) => t.id))) {
    issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, LOOSE_ISSUES, { teamIds: chunk }, (d) => d.issues)));
  }
  onProgress?.(`${issues.length} issues (cycle, project and other assigned work)`);

  return normalizeSnapshot({ organization, teams, cycles, issues, projects, fetchedAt: new Date().toISOString() });
}

/** One saved issue view: its issues are the work in scope; their teams, members, cycles and projects come along. */
async function fetchViewSnapshot(apiKey: string, today: Day, lookbackCycles: number, ref: ViewRef, onProgress?: (msg: string) => void): Promise<Snapshot> {
  const { organization } = await fetchViewer(apiKey);
  const { customView } = await gql<{ customView: { id: string; name: string; slugId: string; modelName: string } }>(apiKey, VIEW, { id: ref.id });
  if (customView.modelName !== 'Issue') throw new Error(`Linear view "${customView.name}" shows ${customView.modelName.toLowerCase()}s, not issues. Set LINEAR_VIEW to an issue view.`);
  const viewIssues = await paginate<{ customView: { issues: Conn<RawIssue> } }, RawIssue>(apiKey, VIEW_ISSUES, { id: customView.id }, (d) => d.customView.issues);
  onProgress?.(`view "${customView.name}": ${viewIssues.length} issues`);

  const teams = await fetchTeams(apiKey, new Set(viewIssues.map((i) => i.team.id)), onProgress);
  const teamIds = new Set(teams.map((t) => t.id));
  const cycles = await fetchCycles(apiKey, teams, today, lookbackCycles, onProgress);

  const inScope = viewIssues.filter((i) => teamIds.has(i.team.id));
  const issues: RawIssue[] = [];
  const completedCycles = cycles.filter((c) => c.completedAt || c.endsAt.slice(0, 10) <= today).map((c) => c.id);
  for (const chunk of chunks(completedCycles)) {
    issues.push(...(await paginate<{ issues: Conn<RawIssue> }, RawIssue>(apiKey, TEAM_HISTORY, { cycleIds: chunk }, (d) => d.issues)));
  }
  const projectIds = [...new Set(viewIssues.map((i) => i.project?.id).filter((id): id is string => !!id))];
  const projects: RawProject[] = [];
  for (const chunk of chunks(projectIds, 50)) {
    projects.push(...(await paginate<{ projects: Conn<RawProject> }, RawProject>(apiKey, PROJECTS_BY_ID, { ids: chunk }, (d) => d.projects)));
  }
  onProgress?.(`${projects.length} projects, ${issues.length} completed issues in recent cycles for velocity`);
  // View issues last, so they win the de-duplication in normalizeSnapshot (they carry history).
  issues.push(...inScope);

  const url = ref.url ?? `https://linear.app/${organization.urlKey}/view/${customView.slugId}`;
  return {
    ...normalizeSnapshot({ organization, teams, cycles, issues, projects, fetchedAt: new Date().toISOString() }),
    view: { id: customView.id, name: customView.name, url, issueIds: inScope.map((i) => i.id) },
  };
}
