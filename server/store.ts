import fs from 'node:fs';
import path from 'node:path';
import { emptyPlanner, DEFAULT_SETTINGS } from '../shared/capacity';
import type { PlannerState, Snapshot, SyncRecord } from '../shared/types';

// Local JSON persistence under ./data (gitignored). Writes are atomic so a crash
// mid-write never leaves a half-written file.

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');

export interface StoredOoo {
  fileName: string;
  uploadedAt: string;
  csv: string;
}

function file(name: string) {
  return path.join(DATA_DIR, name);
}

export function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeJson(name: string, value: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

export const store = {
  snapshot: () => readJson<Snapshot>('snapshot.json'),
  saveSnapshot: (s: Snapshot) => writeJson('snapshot.json', s),

  ooo: () => readJson<StoredOoo>('ooo.json'),
  saveOoo: (o: StoredOoo) => writeJson('ooo.json', o),

  planner(): PlannerState {
    const saved = readJson<Partial<PlannerState>>('planner.json');
    const base = emptyPlanner();
    if (!saved) return base;
    return {
      ...base,
      ...saved,
      settings: { ...DEFAULT_SETTINGS, ...saved.settings, thresholds: { ...DEFAULT_SETTINGS.thresholds, ...saved.settings?.thresholds } },
    };
  },
  savePlanner: (p: PlannerState) => writeJson('planner.json', p),

  workdaySyncedAt: () => readJson<{ at: string }>('workday.json')?.at ?? null,
  saveWorkdaySync: (at: string) => writeJson('workday.json', { at }),

  syncHistory: () => readJson<SyncRecord[]>('sync-history.json') ?? [],
  addSync(record: SyncRecord) {
    writeJson('sync-history.json', [record, ...this.syncHistory()].slice(0, 20));
  },
};
