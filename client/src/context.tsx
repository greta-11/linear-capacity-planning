import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { periodBuckets, type Bucket, type PeriodUnit } from '../../shared/calendar';
import { buildModel, defaultRange, type CapacityModel, type Status } from '../../shared/capacity';
import { summarizeHygiene, type HygieneSummary } from '../../shared/hygiene';
import type { VelocityMode } from '../../shared/types';
import type { AppState } from './api';

export type View = 'hygiene' | 'heatmap' | 'recs';
export type HeatmapMode = 'people' | 'projects';

export interface HeatmapFilters {
  mode: HeatmapMode;
  unit: PeriodUnit;
  size: number;
  count: number;
  projects: string[];
  teams: string[];
  people: string[];
  /** Capacity type: keep rows with any period in these statuses (empty = all). */
  statuses: Status[];
}

export interface Filters {
  view: View;
  /** Shared by every tab so the heat map and recommendations agree. */
  velocity: VelocityMode;
  /** Share of available capacity held back for unplanned work, for everyone. */
  bufferPct: number;
  heatmap: HeatmapFilters;
  recs: { teamId: string | null };
}

interface Ctx {
  state: AppState;
  model: CapacityModel;
  /** Heat map periods, also used by recommendations. */
  buckets: Bucket[];
  hygiene: HygieneSummary;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
}

const PlannerContext = createContext<Ctx | null>(null);

export function PlannerProvider({ state, filters, setFilters, children }: { state: AppState; filters: Filters; setFilters: Ctx['setFilters']; children: ReactNode }) {
  const h = filters.heatmap;
  const buckets = useMemo(() => periodBuckets(state.today, h.unit, h.size, h.count), [state.today, h.unit, h.size, h.count]);
  const velocityKey = JSON.stringify(filters.velocity);
  const model = useMemo(
    () =>
      buildModel({
        snapshot: state.snapshot!,
        ooo: state.ooo,
        planner: state.planner,
        range: buckets.length ? { from: buckets[0].start, to: buckets[buckets.length - 1].end } : defaultRange(state.today),
        today: state.today,
        velocityMode: filters.velocity,
        bufferPct: filters.bufferPct,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, buckets, velocityKey, filters.bufferPct],
  );
  const hygiene = useMemo(() => summarizeHygiene(model), [model]);
  return <PlannerContext.Provider value={{ state, model, buckets, hygiene, filters, setFilters }}>{children}</PlannerContext.Provider>;
}

export function usePlanner(): Ctx {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error('usePlanner outside provider');
  return ctx;
}
