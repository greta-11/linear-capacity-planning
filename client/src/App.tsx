import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, isDay } from '../../shared/calendar';
import { defaultRange } from '../../shared/capacity';
import type { Snapshot } from '../../shared/types';
import { usePull, useAppState, type AppState } from './api';
import { PlannerProvider, usePlanner, type Filters, type View } from './context';
import { ago, formatRange } from './format';
import { Adjustments } from './views/Adjustments';
import { DataSources } from './views/DataSources';
import { IndividualBreakdown } from './views/IndividualBreakdown';
import { TeamOverview } from './views/TeamOverview';

const VIEWS: { id: View; label: string }[] = [
  { id: 'team', label: 'Team capacity' },
  { id: 'people', label: 'Individuals' },
  { id: 'adjust', label: 'Adjustments' },
  { id: 'data', label: 'Data sources' },
];

export const PRESETS = [
  { id: 'current-cycle', label: 'Current cycle' },
  { id: 'next-3-cycles', label: 'Next 3 cycles' },
  { id: 'next-12-weeks', label: 'Next 12 weeks' },
  { id: 'quarter', label: 'Rest of quarter' },
  { id: 'custom', label: 'Custom range' },
];

export function presetRange(preset: string, snapshot: Snapshot | null, today: string, teamId: string | null): { from: string; to: string } | null {
  if (preset === 'next-12-weeks') return defaultRange(today);
  if (preset === 'quarter') {
    const y = Number(today.slice(0, 4));
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
    const nextQuarter = q === 3 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 4).padStart(2, '0')}-01`;
    return { from: today, to: addDays(nextQuarter, -1) };
  }
  if (!snapshot) return null;
  const teams = teamId ? [teamId] : snapshot.teams.map((t) => t.id);
  const ends: string[] = [];
  for (const t of teams) {
    const open = snapshot.cycles
      .filter((c) => c.teamId === t && !c.completedAt && c.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    const n = preset === 'current-cycle' ? 1 : 3;
    const last = open[Math.min(n, open.length) - 1];
    if (last) ends.push(last.endDate);
  }
  if (!ends.length) return defaultRange(today);
  return { from: today, to: ends.sort().at(-1)! };
}

function readUrl(): Partial<Filters> {
  const p = new URLSearchParams(window.location.search);
  const view = p.get('view') as View | null;
  return {
    view: VIEWS.some((v) => v.id === view) ? view! : undefined,
    teamId: p.get('team') || null,
    preset: p.get('range') ?? undefined,
    from: p.get('from') && isDay(p.get('from')!) ? p.get('from')! : undefined,
    to: p.get('to') && isDay(p.get('to')!) ? p.get('to')! : undefined,
  };
}

function writeUrl(f: Filters) {
  const p = new URLSearchParams();
  p.set('view', f.view);
  if (f.teamId) p.set('team', f.teamId);
  p.set('range', f.preset);
  if (f.preset === 'custom') {
    p.set('from', f.from);
    p.set('to', f.to);
  }
  window.history.replaceState(null, '', `?${p.toString()}`);
}

export function App() {
  const { data, error, isLoading } = useAppState();
  if (isLoading && !data) return <div className="boot">Loading planner…</div>;
  if (error && !data) return <div className="boot error">Couldn't reach the local server: {(error as Error).message}. Is `npm run dev` running?</div>;
  if (!data) return null;
  return <Shell state={data} />;
}

function Shell({ state }: { state: AppState }) {
  const [filters, setFiltersState] = useState<Filters>(() => {
    const url = readUrl();
    const preset = url.preset && PRESETS.some((p) => p.id === url.preset) ? url.preset : 'next-12-weeks';
    const teamId = url.teamId && state.snapshot?.teams.some((t) => t.id === url.teamId) ? url.teamId : null;
    const range = preset === 'custom' && url.from && url.to ? { from: url.from, to: url.to } : (presetRange(preset, state.snapshot, state.today, teamId) ?? defaultRange(state.today));
    return { view: url.view ?? 'team', teamId, preset, ...range };
  });

  const setFilters = useCallback(
    (patch: Partial<Filters>) =>
      setFiltersState((prev) => {
        const next = { ...prev, ...patch };
        if (next.preset !== 'custom' && (patch.preset || 'teamId' in patch)) {
          Object.assign(next, presetRange(next.preset, state.snapshot, state.today, next.teamId) ?? {});
        }
        if (next.to < next.from) next.to = next.from;
        return next;
      }),
    [state.snapshot, state.today],
  );
  useEffect(() => writeUrl(filters), [filters]);

  if (!state.snapshot) {
    return (
      <div className="app">
        <Header state={state} />
        <main className="main">
          <div className="empty">
            <h2>No Linear data yet</h2>
            <p>The last sync failed: {state.syncHistory[0]?.error ?? 'unknown error'}.</p>
            <p>Check LINEAR_API_KEY in .env (run `npm run check:linear`), then sync again.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <PlannerProvider state={state} filters={filters} setFilters={setFilters}>
      <div className="app">
        <Header state={state} />
        <Nav />
        <FilterBar />
        <main className="main">
          {filters.view === 'team' && <TeamOverview />}
          {filters.view === 'people' && <IndividualBreakdown />}
          {filters.view === 'adjust' && <Adjustments />}
          {filters.view === 'data' && <DataSources />}
        </main>
      </div>
    </PlannerProvider>
  );
}

function Header({ state }: { state: AppState }) {
  const pull = usePull();
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'ok' ? 4000 : 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchedAt = state.snapshot?.fetchedAt;
  const stale = fetchedAt ? Date.now() - Date.parse(fetchedAt) > 24 * 3600 * 1000 : true;
  const lastError = state.syncHistory[0] && !state.syncHistory[0].ok ? state.syncHistory[0] : null;

  const onSync = () =>
    pull.mutate(undefined, {
      onSuccess: (r) => {
        const c = r.record.counts!;
        setToast({
          kind: 'ok',
          text: `Synced ${c.issues} issues, ${c.cycles} cycles, ${c.teams} teams${r.record.staleEntries ? ` · ${r.record.staleEntries} accepted change(s) now out of date` : ''}`,
        });
      },
      onError: (e) => setToast({ kind: 'error', text: `Sync failed — still showing data from ${ago(fetchedAt)}. ${(e as Error).message}` }),
    });

  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▮▮▮
        </span>
        <span className="title">Capacity Planner</span>
        {state.snapshot && <span className="org">{state.snapshot.organizationName}</span>}
        <span className={`badge ${state.mode === 'demo' ? 'badge-demo' : 'badge-live'}`}>{state.mode === 'demo' ? 'Demo data' : 'Linear'}</span>
      </div>
      <div className="sync">
        <span className={`synced ${stale ? 'synced-stale' : ''}`} title={fetchedAt ? new Date(fetchedAt).toLocaleString() : ''}>
          {lastError && !pull.isPending ? <span className="sync-error">Last sync failed · </span> : null}
          Last synced {ago(fetchedAt)}
        </span>
        <button className="btn btn-primary" onClick={onSync} disabled={pull.isPending} data-testid="sync-button">
          <span className={pull.isPending ? 'spin' : ''} aria-hidden>
            ⟳
          </span>{' '}
          {pull.isPending ? 'Syncing…' : state.mode === 'demo' ? 'Sync (demo)' : 'Sync from Linear'}
        </button>
      </div>
      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" data-testid="toast">
          {toast.text}
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </header>
  );
}

function Nav() {
  const { filters, setFilters, recommendations, state } = usePlanner();
  const pending = state.planner.ledger.filter((e) => e.status === 'pending').length;
  const visibleRecs = useVisibleRecommendations(recommendations).length;
  return (
    <nav className="nav" role="tablist">
      {VIEWS.map((v) => (
        <button key={v.id} role="tab" aria-selected={filters.view === v.id} className={`tab ${filters.view === v.id ? 'tab-active' : ''}`} onClick={() => setFilters({ view: v.id })}>
          {v.label}
          {v.id === 'adjust' && visibleRecs + pending > 0 && <span className="count">{visibleRecs + pending}</span>}
        </button>
      ))}
    </nav>
  );
}

export function useVisibleRecommendations<T extends { teamId?: string; personId?: string }>(recs: T[]): T[] {
  const { filters, model } = usePlanner();
  return useMemo(
    () =>
      recs.filter((r) => {
        if (!filters.teamId) return true;
        if (r.teamId) return r.teamId === filters.teamId;
        if (r.personId) return model.people.get(r.personId)?.teamIds.includes(filters.teamId) ?? false;
        return true;
      }),
    [recs, filters.teamId, model],
  );
}

function FilterBar() {
  const { filters, setFilters, state, model } = usePlanner();
  const clamped = filters.from < state.today;
  return (
    <div className="filters">
      <label className="field">
        <span>Dates</span>
        <select value={filters.preset} onChange={(e) => setFilters({ preset: e.target.value })} data-testid="range-preset">
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {filters.preset === 'custom' ? (
        <>
          <label className="field">
            <span>From</span>
            <input type="date" value={filters.from} onChange={(e) => e.target.value && setFilters({ from: e.target.value })} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from} onChange={(e) => e.target.value && setFilters({ to: e.target.value })} />
          </label>
        </>
      ) : (
        <span className="range-label" data-testid="range-label">
          {formatRange(model.from, model.to)}
        </span>
      )}
      <label className="field">
        <span>Team</span>
        <select value={filters.teamId ?? ''} onChange={(e) => setFilters({ teamId: e.target.value || null })} data-testid="team-filter">
          <option value="">All teams</option>
          {state.snapshot!.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {clamped && <span className="hint">Capacity is planned from today ({state.today}); earlier dates are history.</span>}
    </div>
  );
}
