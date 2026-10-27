import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Change, LedgerEntry, OooDataset, OooEntry, PlannerState, Recommendation, Settings, Snapshot, SyncRecord } from '../../shared/types';

export interface AppState {
  mode: 'linear' | 'demo';
  today: string;
  snapshot: Snapshot | null;
  ooo: OooDataset | null;
  planner: PlannerState;
  syncHistory: SyncRecord[];
  workdaySyncedAt: string | null;
  dataDir: string;
}

export interface OooPreview {
  dataset: OooDataset;
  diff: { added: OooEntry[]; removed: OooEntry[]; unchanged: number };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error ?? data?.record?.error ?? `Request failed (${res.status})`;
    throw Object.assign(new Error(message), { data });
  }
  return data as T;
}

export const STATE_KEY = ['state'];

export function useAppState() {
  return useQuery({ queryKey: STATE_KEY, queryFn: () => request<AppState>('GET', '/api/state'), placeholderData: (prev) => prev });
}

function useInvalidating<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: STATE_KEY }) });
}

export const usePull = () => useInvalidating(() => request<{ ok: boolean; record: SyncRecord }>('POST', '/api/linear/pull'));
export const useApply = () =>
  useInvalidating((entryIds: string[]) => request<{ entries: LedgerEntry[]; pull: SyncRecord }>('POST', '/api/linear/apply', { entryIds }));
export const useAccept = () =>
  useInvalidating((input: { rec: Recommendation; changes: Change[] }) =>
    request<LedgerEntry>('POST', '/api/ledger', {
      recommendationId: input.rec.id,
      group: input.rec.group,
      rule: input.rec.rule,
      title: input.rec.title,
      reason: `${input.rec.evidence.metric.label}: ${input.rec.evidence.metric.value}`,
      changes: input.changes,
    }),
  );
export const useRevert = () => useInvalidating((id: string) => request<LedgerEntry>('POST', `/api/ledger/${id}/revert`));
export const useCsvStatus = () => useInvalidating((v: { id: string; done: boolean }) => request<LedgerEntry>('POST', `/api/ledger/${v.id}/csv-status`, { done: v.done }));
export const useDiscard = () => useInvalidating((id: string) => request<{ ok: true }>('DELETE', `/api/ledger/${id}`));
export const useDismiss = () => useInvalidating((v: { id: string; dismissed: boolean }) => request<{ ok: true }>('POST', '/api/dismissed', v));
export const useSaveSettings = () => useInvalidating((s: Settings) => request<Settings>('PUT', '/api/settings', s));
export const useResetSettings = () => useInvalidating(() => request<Settings>('POST', '/api/settings/reset'));
export const useImportOoo = () => useInvalidating((v: { fileName: string; csv: string }) => request<OooDataset>('POST', '/api/ooo', v));
export const useWorkdaySync = () =>
  useInvalidating(() => request<{ at: string; fileName: string | null; entries: number; problems: number }>('POST', '/api/workday/sync'));
export const useResetDemo = () => useInvalidating(() => request<{ ok: boolean }>('POST', '/api/demo/reset'));
export const previewOoo = (v: { fileName: string; csv: string }) => request<OooPreview>('POST', '/api/ooo/preview', v);
