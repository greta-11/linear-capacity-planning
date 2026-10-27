import { useCallback, useEffect, useState } from 'react';
import type { PeriodUnit } from '../../shared/calendar';
import { DEFAULT_BUFFER, type Status } from '../../shared/capacity';
import type { VelocityMode } from '../../shared/types';
import { useAppState, type AppState } from './api';
import { DataStrip } from './components/DataStrip';
import { HygieneBanner } from './components/HygieneBanner';
import { PlannerProvider, usePlanner, type Filters, type HeatmapMode, type View } from './context';
import { CapacityHeatmap } from './views/CapacityHeatmap';
import { DataHygiene } from './views/DataHygiene';
import { Recommendations } from './views/Recommendations';

const VIEWS: { id: View; label: string }[] = [
  { id: 'hygiene', label: 'Data hygiene' },
  { id: 'heatmap', label: 'Capacity heat map' },
  { id: 'recs', label: 'Recommendations' },
];
const UNITS: PeriodUnit[] = ['week', 'month', 'quarter'];
const STATUSES: Status[] = ['over', 'at-risk', 'healthy', 'under'];

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const int = (v: string | null, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function readUrl(state: AppState): Filters {
  const p = new URLSearchParams(window.location.search);
  const view = VIEWS.some((v) => v.id === p.get('view')) ? (p.get('view') as View) : 'hygiene';
  const vel = p.get('vel');
  const ppw = Number(p.get('ppw'));
  const velocity: VelocityMode =
    vel === 'manual' ? { kind: 'manual', pointsPerWeek: Number.isFinite(ppw) && ppw > 0 ? ppw : 5 } : vel === 'team' ? { kind: 'team-average' } : { kind: 'history' };
  const unit = UNITS.includes(p.get('unit') as PeriodUnit) ? (p.get('unit') as PeriodUnit) : 'week';
  const teamIds = new Set(state.snapshot?.teams.map((t) => t.id) ?? []);
  const recTeam = p.get('rteam') && teamIds.has(p.get('rteam')!) ? p.get('rteam') : null;
  return {
    view,
    velocity,
    bufferPct: int(p.get('buffer'), Math.round(DEFAULT_BUFFER * 100), 0, 90) / 100,
    heatmap: {
      mode: (p.get('mode') === 'projects' ? 'projects' : 'people') as HeatmapMode,
      unit,
      size: int(p.get('size'), unit === 'week' ? 2 : 1, 1, 12),
      count: int(p.get('cols'), 6, 1, 26),
      projects: list(p.get('prj')),
      teams: list(p.get('teams')).filter((t) => teamIds.has(t)),
      people: list(p.get('ppl')),
      statuses: list(p.get('status')).filter((s): s is Status => STATUSES.includes(s as Status)),
    },
    recs: { teamId: recTeam },
  };
}

function writeUrl(f: Filters) {
  const p = new URLSearchParams();
  p.set('view', f.view);
  if (f.velocity.kind !== 'history') p.set('vel', f.velocity.kind === 'manual' ? 'manual' : 'team');
  if (f.velocity.kind === 'manual') p.set('ppw', String(f.velocity.pointsPerWeek));
  p.set('buffer', String(Math.round(f.bufferPct * 100)));
  const h = f.heatmap;
  p.set('mode', h.mode);
  p.set('unit', h.unit);
  p.set('size', String(h.size));
  p.set('cols', String(h.count));
  if (h.projects.length) p.set('prj', h.projects.join(','));
  if (h.teams.length) p.set('teams', h.teams.join(','));
  if (h.people.length) p.set('ppl', h.people.join(','));
  if (h.statuses.length) p.set('status', h.statuses.join(','));
  if (f.recs.teamId) p.set('rteam', f.recs.teamId);
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
  const [filters, setFiltersState] = useState<Filters>(() => readUrl(state));
  const setFilters = useCallback((patch: Partial<Filters>) => setFiltersState((prev) => ({ ...prev, ...patch })), []);
  useEffect(() => writeUrl(filters), [filters]);

  if (!state.snapshot) {
    return (
      <div className="app">
        <DataStrip state={state} />
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
        <DataStrip state={state} />
        <HygieneBanner />
        <Nav />
        <main className="main">
          {filters.view === 'hygiene' && <DataHygiene />}
          {filters.view === 'heatmap' && <CapacityHeatmap />}
          {filters.view === 'recs' && <Recommendations />}
        </main>
      </div>
    </PlannerProvider>
  );
}

function Nav() {
  const { filters, setFilters, hygiene } = usePlanner();
  return (
    <nav className="nav" role="tablist">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={filters.view === v.id}
          className={`tab ${filters.view === v.id ? 'tab-active' : ''}`}
          onClick={() => setFilters({ view: v.id })}
          data-testid={`tab-${v.id}`}
        >
          {v.label}
          {v.id === 'hygiene' && hygiene.flagged > 0 && <span className="count count-warn">{hygiene.flagged}</span>}
        </button>
      ))}
    </nav>
  );
}
