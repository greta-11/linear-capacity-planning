import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localToday } from '../shared/calendar';
import { SNAPSHOT_VERSION, type OooDataset, type Snapshot, type SyncRecord } from '../shared/types';
import { demoOooCsv } from './demo/seed';
import { loadDemoWorkspace } from './demo/workspace';
import { fetchSnapshot } from './linear/queries';
import { configuredView, DEFAULT_VIEW_OOO } from './linear/view';
import { parseOooCsv } from './ooo/csv';
import { store } from './store';

export type Mode = 'linear' | 'demo';

export const apiKey = () => process.env.LINEAR_API_KEY?.trim() || '';
export const mode = (): Mode => (apiKey() ? 'linear' : 'demo');

// ---------------------------------------------------------------------------
// Snapshot

let pulling: Promise<PullResult> | null = null;

export interface PullResult {
  ok: boolean;
  record: SyncRecord;
  snapshot: Snapshot | null;
}

/** Re-syncs from Linear (or the demo workspace). On failure the previous snapshot stays in place. */
export function pull(): Promise<PullResult> {
  pulling ??= doPull().finally(() => {
    pulling = null;
  });
  return pulling;
}

async function doPull(): Promise<PullResult> {
  const source = mode();
  const at = new Date().toISOString();
  try {
    const snapshot =
      source === 'linear'
        ? await fetchSnapshot(apiKey(), localToday(), store.planner().settings.lookbackCycles, undefined, configuredView())
        : { ...structuredClone(loadDemoWorkspace()), fetchedAt: at };
    store.saveSnapshot(snapshot);
    const record: SyncRecord = {
      at,
      source,
      ok: true,
      counts: { teams: snapshot.teams.length, people: snapshot.people.length, cycles: snapshot.cycles.length, issues: snapshot.issues.length },
    };
    store.addSync(record);
    return { ok: true, record, snapshot };
  } catch (err) {
    const record: SyncRecord = { at, source, ok: false, error: (err as Error).message };
    store.addSync(record);
    return { ok: false, record, snapshot: store.snapshot() };
  }
}

/** Returns the stored snapshot, pulling first when there is none or it came from the other mode. */
export async function ensureSnapshot(): Promise<Snapshot | null> {
  const s = store.snapshot();
  // Snapshots saved by an older version of the planner are pulled again.
  if (s && s.source === mode() && s.version === SNAPSHOT_VERSION && (mode() === 'demo' || viewMatches(s))) return s;
  const res = await pull();
  return res.snapshot;
}

/** A stored Linear snapshot is reused only if it was pulled for the view configured now. */
function viewMatches(s: Snapshot): boolean {
  const ref = configuredView();
  if (!ref) return !s.view;
  return !!s.view && (s.view.id === ref.id || s.view.url?.includes(ref.id) === true);
}

// ---------------------------------------------------------------------------
// OOO

const viewSamplePath = fileURLToPath(new URL(`../${DEFAULT_VIEW_OOO}`, import.meta.url));

export function currentOoo(snapshot: Snapshot | null): OooDataset | null {
  const people = snapshot?.people ?? [];
  const saved = store.ooo();
  if (saved) return parseOooCsv(saved.csv, saved.fileName, people, saved.uploadedAt);
  if (mode() === 'demo') {
    // Generated for the day the demo workspace was seeded so the stories line up.
    const anchor = snapshot?.demoSeedDay ?? localToday();
    return { ...parseOooCsv(demoOooCsv(anchor), 'demo-ooo.csv', people, snapshot?.fetchedAt), generated: true };
  }
  // The default view ships with an OOO export for its people. An imported CSV replaces it.
  if (configuredView()?.isDefault && fs.existsSync(viewSamplePath)) {
    return { ...parseOooCsv(fs.readFileSync(viewSamplePath, 'utf8'), DEFAULT_VIEW_OOO.split('/').pop()!, people, snapshot?.fetchedAt), generated: true };
  }
  return null;
}
