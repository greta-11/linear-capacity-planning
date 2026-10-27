import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshot } from '../server/linear/queries';
import { BUDGET, estimateComplexity } from './complexity';

// Runs the real sync against a fake Linear API: checks that members are fetched per team
// (with pagination) and that every query sent stays within the complexity budget.

const user = (id: string) => ({ id, name: `User ${id}`, displayName: id, email: `${id}@x.dev`, avatarUrl: null, active: true });
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

  it('never sends a query over the complexity budget', async () => {
    const fake = fakeLinear();
    vi.stubGlobal('fetch', vi.fn(fake.handler));
    await fetchSnapshot('lin_api_test', '2026-11-02', 3);
    for (const s of fake.sent) expect(estimateComplexity(s.query), s.op).toBeLessThanOrEqual(BUDGET);
  });
});
