import { useCallback, useEffect, useState } from 'react';
import { isDay, type PeriodUnit } from '../../shared/calendar';
import { defaultRange } from '../../shared/capacity';
import type { VelocityMode } from '../../shared/types';
import { useAppState, type AppState } from './api';
import { DataStrip } from './components/DataStrip';
import { PlannerProvider, usePlanner, type Filters, type View } from './context';
import { PRESETS, presetRange } from './ranges';
import { Adjustments, useVisibleRecommendations } from './views/Adjustments';
import { CapacityHeatmap } from './views/CapacityHeatmap';
import { ProjectRisk } from './views/ProjectRisk';

const VIEWS: { id: View; label: string }[] = [
  { id: 'risk', label: 'Project risk' },
  { id: 'heatmap', label: 'Capacity heat map' },
  { id: 'recs', label: 'Recommendations' },
];
const UNITS: PeriodUnit[] = ['week', 'month', 'quarter'];

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const int = (v: string | null, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function readUrl(state: AppState): Filters {
  const p = new URLSearchParams(window.location.search);
  const view = VIEWS.some((v) => v.id === p.get('view')) ? (p.get('view') as View) : 'risk';
  const vel = p.get('vel');
  const ppw = Number(p.get('ppw'));
  const velocity: VelocityMode =
    vel === 'manual' ? { kind: 'manual', pointsPerWeek: Number.isFinite(ppw) && ppw > 0 ? ppw : 5 } : vel === 'team' ? { kind: 'team-average' } : { kind: 'history' };
  const unit = UNITS.includes(p.get('unit') as PeriodUnit) ? (p.get('unit') as PeriodUnit) : 'week';
  const teamIds = new Set(state.snapshot?.teams.map((t) => t.id) ?? []);
  const recTeam = p.get('rteam') && teamIds.has(p.get('rteam')!) ? p.get('rteam') : null;
  const preset = PRESETS.some((x) => x.id === p.get('range')) ? p.get('range')! : 'next-12-weeks';
  const from = p.get('from');
  const to = p.get('to');
  const range =
    preset === 'custom' && from && to && isDay(from) && isDay(to) ? { from, to } : (presetRange(preset, state.snapshot, state.today, recTeam) ?? defaultRange(state.today));
  const riskTeam = p.get('kteam') && teamIds.has(p.get('kteam')!) ? p.get('kteam') : null;
  return {
    view,
    velocity,
    heatmap: {
      unit,
      size: int(p.get('size'), unit === 'week' ? 2 : 1, 1, 12),
      count: int(p.get('cols'), 6, 1, 26),
      projects: list(p.get('prj')),
      teams: list(p.get('teams')).filter((t) => teamIds.has(t)),
      people: list(p.get('ppl')),
    },
    risk: { teamId: riskTeam, includeNoTarget: p.get('notarget') !== '0' },
    recs: { preset, teamId: recTeam, ...range },
  };
}

function writeUrl(f: Filters) {
  const p = new URLSearchParams();
  p.set('view', f.view);
  if (f.velocity.kind !== 'history') p.set('vel', f.velocity.kind === 'manual' ? 'manual' : 'team');
  if (f.velocity.kind === 'manual') p.set('ppw', String(f.velocity.pointsPerWeek));
  const h = f.heatmap;
  p.set('unit', h.unit);
  p.set('size', String(h.size));
  p.set('cols', String(h.count));
  if (h.projects.length) p.set('prj', h.projects.join(','));
  if (h.teams.length) p.set('teams', h.teams.join(','));
  if (h.people.length) p.set('ppl', h.people.join(','));
  if (f.risk.teamId) p.set('kteam', f.risk.teamId);
  if (!f.risk.includeNoTarget) p.set('notarget', '0');
  p.set('range', f.recs.preset);
  if (f.recs.teamId) p.set('rteam', f.recs.teamId);
  if (f.recs.preset === 'custom') {
    p.set('from', f.recs.from);
    p.set('to', f.recs.to);
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
  const [filters, setFiltersState] = useState<Filters>(() => readUrl(state));
  const setFilters = useCallback(
    (patch: Partial<Filters>) =>
      setFiltersState((prev) => {
        const next = { ...prev, ...patch };
        const r = next.recs;
        if (patch.recs && r.preset !== 'custom' && (patch.recs.preset !== prev.recs.preset || patch.recs.teamId !== prev.recs.teamId)) {
          next.recs = { ...r, ...(presetRange(r.preset, state.snapshot, state.today, r.teamId) ?? {}) };
        }
        if (next.recs.to < next.recs.from) next.recs = { ...next.recs, to: next.recs.from };
        return next;
      }),
    [state.snapshot, state.today],
  );
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
        <Nav />
        <main className="main">
          {filters.view === 'risk' && <ProjectRisk />}
          {filters.view === 'heatmap' && <CapacityHeatmap />}
          {filters.view === 'recs' && <Adjustments />}
        </main>
      </div>
    </PlannerProvider>
  );
}

function Nav() {
  const { filters, setFilters, recommendations, state } = usePlanner();
  const pending = state.planner.ledger.filter((e) => e.status === 'pending').length;
  const visibleRecs = useVisibleRecommendations(recommendations).length;
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
          {v.id === 'recs' && visibleRecs + pending > 0 && <span className="count">{visibleRecs + pending}</span>}
        </button>
      ))}
    </nav>
  );
}
