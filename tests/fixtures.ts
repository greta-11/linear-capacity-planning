import { emptyPlanner } from '../shared/capacity';
import type { Cycle, Issue, OooDataset, OooEntry, PlannerState, Snapshot } from '../shared/types';

// Small hand-built workspace. Today is Monday 2026-11-02, the first day of T's
// active cycle c3. A is on team T; B is on T and U.

export const TODAY = '2026-11-02';

const cycle = (id: string, teamId: string, number: number, startDate: string, endDate: string, completed: boolean): Cycle => ({
  id,
  teamId,
  number,
  name: null,
  startDate,
  endDate,
  completedAt: completed ? `${endDate}T23:59:00.000Z` : null,
});

let n = 0;
export function issue(partial: Partial<Issue> & Pick<Issue, 'teamId' | 'cycleId'>): Issue {
  n++;
  return {
    id: `i${n}`,
    identifier: `T-${n}`,
    title: `Issue ${n}`,
    url: `https://linear.app/x/issue/T-${n}`,
    assigneeId: null,
    estimate: 1,
    priority: 3,
    stateType: 'unstarted',
    stateName: 'Todo',
    projectName: null,
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    canceledAt: null,
    addedToCycleAt: null,
    ...partial,
  };
}

export function fixture(extraIssues: Issue[] = []): Snapshot {
  const done = (cycleId: string, assigneeId: string, estimate: number, teamId = 'T') =>
    issue({ teamId, cycleId, assigneeId, estimate, stateType: 'completed', completedAt: '2026-10-10T00:00:00.000Z' });
  return {
    source: 'demo',
    organizationName: 'Test',
    urlKey: 'x',
    fetchedAt: '2026-11-02T08:00:00.000Z',
    teams: [
      { id: 'T', key: 'T', name: 'Team T', cyclesEnabled: true, cycleDuration: 2, estimationType: 'fibonacci', timezone: 'UTC', memberIds: ['A', 'B'] },
      { id: 'U', key: 'U', name: 'Team U', cyclesEnabled: true, cycleDuration: 2, estimationType: 'notUsed', timezone: 'UTC', memberIds: ['B'] },
    ],
    people: [
      { id: 'A', name: 'Alice A', displayName: 'Alice', email: 'alice@x.dev', avatarUrl: null, active: true, teamIds: ['T'] },
      { id: 'B', name: 'Bob B', displayName: 'Bob', email: 'bob@x.dev', avatarUrl: null, active: true, teamIds: ['T', 'U'] },
    ],
    cycles: [
      cycle('c1', 'T', 1, '2026-10-05', '2026-10-18', true),
      cycle('c2', 'T', 2, '2026-10-19', '2026-11-01', true),
      cycle('c3', 'T', 3, '2026-11-02', '2026-11-15', false),
      cycle('c4', 'T', 4, '2026-11-16', '2026-11-29', false),
      cycle('u3', 'U', 3, '2026-11-02', '2026-11-15', false),
    ],
    issues: [done('c1', 'A', 5), done('c1', 'A', 5), done('c2', 'A', 5), done('c2', 'A', 5), ...extraIssues],
  };
}

export function ooo(entries: Partial<OooEntry>[]): OooDataset {
  return {
    fileName: 'test.csv',
    uploadedAt: '2026-11-01T00:00:00.000Z',
    problems: [],
    entries: entries.map((e, i) => ({ id: `o${i + 1}`, email: 'alice@x.dev', personId: 'A', start: TODAY, end: TODAY, type: 'vacation', fraction: 1, note: '', row: i + 1, ...e })),
  };
}

export function planner(patch: Partial<PlannerState> = {}): PlannerState {
  return { ...emptyPlanner(), ...patch };
}
