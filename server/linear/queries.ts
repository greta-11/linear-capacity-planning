import { addDays } from '../../shared/calendar';
import type { Day, Snapshot } from '../../shared/types';
import { gql, paginate } from './client';
import { normalizeSnapshot, type RawCycle, type RawIssue, type RawTeam } from './normalize';

// Page sizes are kept small enough to stay well under Linear's query complexity limit.

const ORG = /* GraphQL */ `
  query Org {
    organization { name urlKey }
    viewer { id name email }
  }
`;

const TEAMS = /* GraphQL */ `
  query Teams($after: String) {
    teams(first: 50, after: $after) {
      nodes {
        id key name cyclesEnabled cycleDuration issueEstimationType timezone
        members(first: 250) { nodes { id name displayName email avatarUrl active } }
      }
      pageInfo { hasNextPage endCursor }
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
        id identifier title url priority estimate createdAt updatedAt completedAt canceledAt
        state { type name }
        assignee { id name displayName email avatarUrl active }
        team { id }
        cycle { id }
        project { name }
        labels(first: 10) { nodes { name } }
        history(first: 25) @include(if: $withHistory) { nodes { createdAt toCycleId } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUE = /* GraphQL */ `
  query Issue($id: String!) {
    issue(id: $id) { id identifier updatedAt estimate state { type } assignee { id } cycle { id } }
  }
`;

const UPDATE = /* GraphQL */ `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id updatedAt } }
  }
`;

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
  const teams = await paginate<{ teams: Conn<RawTeam> }, RawTeam>(apiKey, TEAMS, {}, (d) => d.teams);
  onProgress?.(`${teams.length} teams`);

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
  onProgress?.(`${issues.length} issues`);

  return normalizeSnapshot({ organization, teams, cycles, issues, fetchedAt: new Date().toISOString() });
}

export interface LiveIssue {
  id: string;
  identifier: string;
  updatedAt: string;
  estimate: number | null;
  state: { type: string };
  assignee: { id: string } | null;
  cycle: { id: string } | null;
}

export async function fetchIssue(apiKey: string, id: string): Promise<LiveIssue | null> {
  const data = await gql<{ issue: LiveIssue | null }>(apiKey, ISSUE, { id });
  return data.issue;
}

export async function updateIssue(apiKey: string, id: string, input: { cycleId?: string; assigneeId?: string; estimate?: number }) {
  const data = await gql<{ issueUpdate: { success: boolean; issue: { id: string; updatedAt: string } | null } }>(apiKey, UPDATE, { id, input });
  return data.issueUpdate;
}
