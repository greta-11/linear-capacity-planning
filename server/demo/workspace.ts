import { localToday } from '../../shared/calendar';
import type { Issue, Snapshot } from '../../shared/types';
import { readJson, writeJson } from '../store';
import { demoSnapshot } from './seed';

// Stand-in for the Linear workspace in demo mode. It lives in data/demo-workspace.json
// so "Apply to Linear" writes survive restarts and "Sync from Linear" reads them back.

const FILE = 'demo-workspace.json';

export function loadDemoWorkspace(): Snapshot {
  let ws: Snapshot | null;
  try {
    ws = readJson<Snapshot>(FILE);
  } catch (err) {
    throw new Error(`Could not read the demo workspace (data/${FILE}): ${(err as Error).message}`);
  }
  if (!ws) {
    ws = demoSnapshot(localToday());
    writeJson(FILE, ws);
  }
  return ws;
}

export function resetDemoWorkspace(): Snapshot {
  const ws = demoSnapshot(localToday());
  writeJson(FILE, ws);
  return ws;
}

export function updateDemoIssue(id: string, patch: Partial<Pick<Issue, 'cycleId' | 'assigneeId' | 'estimate'>>): Issue | null {
  const ws = loadDemoWorkspace();
  const issue = ws.issues.find((i) => i.id === id);
  if (!issue) return null;
  Object.assign(issue, patch, { updatedAt: new Date().toISOString() });
  if (patch.cycleId) issue.addedToCycleAt = new Date().toISOString();
  writeJson(FILE, ws);
  return issue;
}
