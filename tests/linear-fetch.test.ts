import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshot } from '../server/linear/queries';
import { DEFAULT_VIEW_URL, parseViewRef } from '../server/linear/view';
import { BUDGET, estimateComplexity } from './complexity';

// Runs the real sync against a fake Linear API: checks that members are fetched per team
// (with pagination) and that every query sent stays within the complexity budget.

const user = (id: string) => ({ id, name: `User ${id}`, displayName: id, email: `${id}@x.dev`, avatarUrl: null, active: true });
const rawIssue = (id: string, teamId: string, assignee: string) => ({
  id,
  identifier: id,
  title: id,
  url: `https://linear.app/x/issue/${id}`,
  priority: 3,
  estimate: 2,
  dueDate: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  completedAt: null,
  canceledAt: null,
  state: { type: 'unstarted', name: 'Todo' },
  assignee: user(assignee),
  team: { id: teamId },
  cycle: null,
  project: null,
  labels: { nodes: [] },
  history: { nodes: [] },
});
const page = <T,>(nodes: T[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next != null, endCursor: next } });

function fakeLinear() {
  const sent: { op: string; query: string; variables: Record<string, unknown> }[] = [];
  const handler = async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    const op = /(?:query|mutation) (\w+)/.exec(query)![1];
    sent.push({ op, query, variables });
    const data = (() => {
      switch (op) {
        case 'Org':
          return { organization: { name: 'Acme', urlKey: 'acme' }, viewer: { id: 'u1', name: 'Me', email: 'me@x.dev' } };
        case 'Teams':
          return {
            teams: page([
              { id: 'T1', key: 'ONE', name: 'One', cyclesEnabled: false, cycleDuration: 2, issueEstimationType: 'fibonacci', timezone: 'UTC' },
              { id: 'T2', key: 'TWO', name: 'Two', cyclesEnabled: false, cycleDuration: 2, issueEstimationType: 'notUsed', timezone: 'UTC' },
            ]),
          };
        case 'TeamMembers':
          if (variables.teamId === 'T1') {
            return { team: { members: variables.after ? page([user('c')]) : page([user('a'), user('b')], 'cursor-1') } };
          }
          return { team: { members: page([user('b'), user('d')]) } };
        case 'Projects':
          return { projects: page([]) };
        case 'LooseIssues':
          return { issues: page([]) };
        case 'View':
          return { customView: { id: 'view-uuid', name: 'GX demo subset', slugId: variables.id, modelName: 'Issue' } };
        case 'ViewIssues':
          return { customView: { issues: variables.after ? page([rawIssue('V2', 'T1', 'c')]) : page([rawIssue('V1', 'T1', 'a')], 'cursor-v') } };
        case 'Cycles':
          return { cycles: page([]) };
        case 'TeamHistory':
          return { issues: page([]) };
        case 'ProjectsById':
          return { projects: page([]) };
        default:
          throw new Error(`unexpected operation ${op}`);
      }
    })();
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, handler };
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchSnapshot against a fake Linear API', () => {
  it('fetches each team’s members in their own paginated query and merges people across teams', async () => {
    const fake = fakeLinear();
    vi.stubGlobal('fetch', vi.fn(fake.handler));
    const snapshot = await fetchSnapshot('lin_api_test', '2026-11-02', 3);

    const memberCalls = fake.sent.filter((s) => s.op === 'TeamMembers');
    expect(memberCalls.map((c) => [c.variables.teamId, c.variables.after ?? null])).toEqual([
      ['T1', null],
      ['T1', 'cursor-1'],
      ['T2', null],
    ]);
    expect(snapshot.teams.find((t) => t.id === 'T1')!.memberIds).toEqual(['a', 'b', 'c']);
    expect(snapshot.teams.find((t) => t.id === 'T2')!.memberIds).toEqual(['b', 'd']);
    expect(snapshot.people.find((p) => p.id === 'b')!.teamIds).toEqual(['T1', 'T2']);
    expect(snapshot.people).toHaveLength(4);
  });

  it('in view mode, syncs the view’s issues and only the teams they belong to', async () => {
    const fake = fakeLinear();
    vi.stubGlobal('fetch', vi.fn(fake.handler));
    const snapshot = await fetchSnapshot('lin_api_test', '2026-11-02', 3, undefined, parseViewRef(DEFAULT_VIEW_URL));

    expect(fake.sent.find((s) => s.op === 'View')!.variables).toEqual({ id: '30b9a718498a' });
    expect(fake.sent.filter((s) => s.op === 'ViewIssues').map((s) => [s.variables.id, s.variables.after ?? null])).toEqual([
      ['view-uuid', null],
      ['view-uuid', 'cursor-v'],
    ]);
    expect(fake.sent.some((s) => s.op === 'Issues' || s.op === 'Projects' || s.op === 'LooseIssues')).toBe(false);
    expect(snapshot.teams.map((t) => t.id)).toEqual(['T1']);
    expect(snapshot.issues.map((i) => i.id)).toEqual(['V1', 'V2']);
    expect(snapshot.view).toMatchObject({ id: 'view-uuid', name: 'GX demo subset', issueIds: ['V1', 'V2'] });
    for (const s of fake.sent) expect(estimateComplexity(s.query), s.op).toBeLessThanOrEqual(BUDGET);
  });

  it('never sends a query over the complexity budget', async () => {
    const fake = fakeLinear();
    vi.stubGlobal('fetch', vi.fn(fake.handler));
    await fetchSnapshot('lin_api_test', '2026-11-02', 3);
    for (const s of fake.sent) expect(estimateComplexity(s.query), s.op).toBeLessThanOrEqual(BUDGET);
  });
});
