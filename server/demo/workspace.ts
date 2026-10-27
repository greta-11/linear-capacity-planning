import { localToday } from '../../shared/calendar';
import { SNAPSHOT_VERSION, type Snapshot } from '../../shared/types';
import { readJson, writeJson } from '../store';
import { demoSnapshot } from './seed';

// Stand-in for the Linear workspace in demo mode. It lives in data/demo-workspace.json,
// so you can edit it to simulate changes in Linear and see them after a sync.

const FILE = 'demo-workspace.json';

export function loadDemoWorkspace(): Snapshot {
  let ws: Snapshot | null;
  try {
    ws = readJson<Snapshot>(FILE);
  } catch (err) {
    throw new Error(`Could not read the demo workspace (data/${FILE}): ${(err as Error).message}`);
  }
  if (!ws || ws.version !== SNAPSHOT_VERSION) {
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
