import os from 'node:os';
import { applyPlannerChange, destinationOf, isValidChange } from '../shared/changes';
import { localToday } from '../shared/calendar';
import { isOpen } from '../shared/capacity';
import type { Change, ChangeResult, LedgerEntry, OooDataset, PlannerState, Snapshot, SyncRecord } from '../shared/types';
import { demoOooCsv } from './demo/seed';
import { loadDemoWorkspace, updateDemoIssue } from './demo/workspace';
import { fetchIssue, fetchSnapshot, updateIssue } from './linear/queries';
import { parseOooCsv } from './ooo/csv';
import { store } from './store';

export type Mode = 'linear' | 'demo';

export const apiKey = () => process.env.LINEAR_API_KEY?.trim() || '';
export const mode = (): Mode => (apiKey() ? 'linear' : 'demo');
export const currentUser = () => {
  try {
    return os.userInfo().username;
  } catch {
    return 'local user';
  }
};

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
        ? await fetchSnapshot(apiKey(), localToday(), store.planner().settings.lookbackCycles)
        : { ...structuredClone(loadDemoWorkspace()), fetchedAt: at };
    store.saveSnapshot(snapshot);
    const planner = store.planner();
    const stale = refreshLedger(planner, snapshot);
    store.savePlanner(planner);
    const record: SyncRecord = {
      at,
      source,
      ok: true,
      counts: { teams: snapshot.teams.length, people: snapshot.people.length, cycles: snapshot.cycles.length, issues: snapshot.issues.length },
      staleEntries: stale,
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
  if (s && s.source === mode()) return s;
  const res = await pull();
  return res.snapshot;
}

// ---------------------------------------------------------------------------
// OOO

export function currentOoo(snapshot: Snapshot | null): OooDataset | null {
  const people = snapshot?.people ?? [];
  const saved = store.ooo();
  if (saved) return parseOooCsv(saved.csv, saved.fileName, people, saved.uploadedAt);
  if (mode() === 'demo') {
    // Generated for the day the demo workspace was seeded so the stories line up.
    const anchor = snapshot?.demoSeedDay ?? localToday();
    return { ...parseOooCsv(demoOooCsv(anchor), 'demo-ooo.csv', people, snapshot?.fetchedAt), generated: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger

const ACTIVE_LINEAR = new Set(['pending', 'stale']);

function currentValue(snapshot: Snapshot, change: Change): { ok: boolean; reason?: string } {
  if (!('issueId' in change)) return { ok: true };
  const issue = snapshot.issues.find((i) => i.id === change.issueId);
  if (!issue) return { ok: false, reason: `${change.identifier} is no longer in a synced cycle.` };
  if (!isOpen(issue)) return { ok: false, reason: `${change.identifier} is ${issue.stateName} in Linear now.` };
  const now = change.kind === 'issue.cycle' ? issue.cycleId : change.kind === 'issue.assignee' ? issue.assigneeId : issue.estimate;
  if (now !== change.from) return { ok: false, reason: `${change.identifier} changed in Linear since this was accepted.` };
  return { ok: true };
}

/** Flags pending Linear changes whose issue changed upstream; un-flags them if it changed back. */
export function refreshLedger(planner: PlannerState, snapshot: Snapshot): number {
  let stale = 0;
  for (const entry of planner.ledger) {
    if (entry.destination !== 'linear' || !ACTIVE_LINEAR.has(entry.status)) continue;
    const problems = entry.changes.map((c) => currentValue(snapshot, c)).filter((r) => !r.ok);
    if (problems.length) {
      entry.status = 'stale';
      entry.note = problems.map((p) => p.reason).join(' ');
      stale++;
    } else if (entry.status === 'stale') {
      entry.status = 'pending';
      entry.note = undefined;
    }
    entry.updatedAt = new Date().toISOString();
  }
  return stale;
}

export interface AcceptInput {
  recommendationId: string;
  group: string;
  rule: LedgerEntry['rule'];
  title: string;
  reason: string;
  changes: Change[];
}

export function accept(input: AcceptInput): LedgerEntry {
  if (!input.changes?.length || !input.changes.every(isValidChange)) throw new Error('Invalid changes.');
  const destinations = new Set(input.changes.map(destinationOf));
  if (destinations.size !== 1) throw new Error('A recommendation must target a single destination.');
  const destination = [...destinations][0];
  const planner = store.planner();
  const now = new Date().toISOString();
  const entry: LedgerEntry = {
    id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    recommendationId: input.recommendationId,
    group: input.group,
    rule: input.rule,
    destination,
    title: input.title,
    reason: input.reason,
    changes: input.changes,
    status: destination === 'linear' ? 'pending' : destination === 'planner' ? 'applied' : 'open',
    acceptedAt: now,
    acceptedBy: currentUser(),
    updatedAt: now,
  };
  if (destination === 'planner') for (const c of entry.changes) applyPlannerChange(planner, c);
  planner.ledger.unshift(entry);
  store.savePlanner(planner);
  return entry;
}

export function revert(id: string): LedgerEntry {
  const planner = store.planner();
  const entry = planner.ledger.find((e) => e.id === id);
  if (!entry) throw new Error('Unknown ledger entry.');
  if (entry.destination !== 'planner' || entry.status !== 'applied') throw new Error('Only applied planner changes can be reverted.');
  for (const c of [...entry.changes].reverse()) applyPlannerChange(planner, c, true);
  entry.status = 'reverted';
  entry.updatedAt = new Date().toISOString();
  store.savePlanner(planner);
  return entry;
}

export function setCsvStatus(id: string, done: boolean): LedgerEntry {
  const planner = store.planner();
  const entry = planner.ledger.find((e) => e.id === id);
  if (!entry || entry.destination !== 'csv') throw new Error('Unknown OOO to-do.');
  entry.status = done ? 'done' : 'open';
  entry.updatedAt = new Date().toISOString();
  store.savePlanner(planner);
  return entry;
}

/** Removes an entry that never took effect (pending/stale/failed Linear change, or an OOO to-do). */
export function discard(id: string) {
  const planner = store.planner();
  const entry = planner.ledger.find((e) => e.id === id);
  if (!entry) throw new Error('Unknown ledger entry.');
  if (entry.destination === 'planner' && entry.status === 'applied') throw new Error('Revert planner changes instead of discarding them.');
  if (entry.status === 'synced') throw new Error('Synced changes are already in Linear.');
  planner.ledger = planner.ledger.filter((e) => e.id !== id);
  store.savePlanner(planner);
}

export function setDismissed(recommendationId: string, dismissed: boolean) {
  const planner = store.planner();
  planner.dismissed = planner.dismissed.filter((d) => d !== recommendationId);
  if (dismissed) planner.dismissed.push(recommendationId);
  store.savePlanner(planner);
}

// ---------------------------------------------------------------------------
// Apply to Linear

async function liveValue(change: Extract<Change, { issueId: string }>) {
  if (mode() === 'linear') {
    const issue = await fetchIssue(apiKey(), change.issueId);
    if (!issue) return null;
    return {
      open: !['completed', 'canceled'].includes(issue.state.type),
      value: change.kind === 'issue.cycle' ? (issue.cycle?.id ?? null) : change.kind === 'issue.assignee' ? (issue.assignee?.id ?? null) : issue.estimate,
    };
  }
  const issue = loadDemoWorkspace().issues.find((i) => i.id === change.issueId);
  if (!issue) return null;
  return {
    open: isOpen(issue),
    value: change.kind === 'issue.cycle' ? issue.cycleId : change.kind === 'issue.assignee' ? issue.assigneeId : issue.estimate,
  };
}

async function write(change: Extract<Change, { issueId: string }>): Promise<ChangeResult> {
  const input = change.kind === 'issue.cycle' ? { cycleId: change.to } : change.kind === 'issue.assignee' ? { assigneeId: change.to } : { estimate: change.to };
  if (mode() === 'linear') {
    const res = await updateIssue(apiKey(), change.issueId, input);
    return res.success ? { ok: true, message: `${change.identifier} updated in Linear.` } : { ok: false, message: `Linear did not accept the update to ${change.identifier}.` };
  }
  return updateDemoIssue(change.issueId, input)
    ? { ok: true, message: `${change.identifier} updated (demo workspace — nothing was sent to Linear).` }
    : { ok: false, message: `${change.identifier} not found in the demo workspace.` };
}

export async function applyToLinear(ids: string[]) {
  const planner = store.planner();
  const entries = planner.ledger.filter((e) => ids.includes(e.id));
  for (const entry of entries) {
    if (entry.destination !== 'linear' || entry.status !== 'pending') continue;
    const results: ChangeResult[] = [];
    for (const change of entry.changes) {
      if (!('issueId' in change)) continue;
      try {
        const live = await liveValue(change);
        if (!live) results.push({ ok: false, message: `${change.identifier} no longer exists or isn't visible to this API key.` });
        else if (!live.open) results.push({ ok: false, message: `${change.identifier} was closed in Linear; skipped.` });
        else if (live.value !== change.from) results.push({ ok: false, message: `${change.identifier} changed in Linear since this was accepted; skipped so we don't overwrite it.` });
        else results.push(await write(change));
      } catch (err) {
        results.push({ ok: false, message: `${change.identifier}: ${(err as Error).message}` });
      }
    }
    entry.results = results;
    entry.status = results.every((r) => r.ok) ? 'synced' : 'failed';
    entry.note = results.some((r) => r.ok) && !results.every((r) => r.ok) ? 'Partially applied — see results.' : undefined;
    entry.updatedAt = new Date().toISOString();
  }
  store.savePlanner(planner);
  const pulled = await pull();
  return { entries: store.planner().ledger.filter((e) => ids.includes(e.id)), pull: pulled.record };
}
