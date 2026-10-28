import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { periodBuckets, type Bucket, type PeriodUnit } from '../../shared/calendar';
import { buildModel, defaultRange, planningStart, type CapacityModel, type Status } from '../../shared/capacity';
import { summarizeHygiene, type HygieneSummary } from '../../shared/hygiene';
import { planReassignments, type ReassignmentPlan } from '../../shared/reassign';
import type { VelocityMode } from '../../shared/types';
import type { AppState } from './api';

export type View = 'hygiene' | 'heatmap';
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
  /** Shared by every tab. */
  velocity: VelocityMode;
  /** Share of available capacity held back for unplanned work, for everyone. */
  bufferPct: number;
  heatmap: HeatmapFilters;
}

interface Ctx {
  state: AppState;
  model: CapacityModel;
  /** Heat map periods, starting at the earliest open issue's cycle. */
  buckets: Bucket[];
  hygiene: HygieneSummary;
  /** Reassignments and remaining overflow over all periods, shown in the cell drawers. */
  plan: ReassignmentPlan;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
}

const PlannerContext = createContext<Ctx | null>(null);

export function PlannerProvider({ state, filters, setFilters, children }: { state: AppState; filters: Filters; setFilters: Ctx['setFilters']; children: ReactNode }) {
  const h = filters.heatmap;
  const anchor = useMemo(() => planningStart(state.snapshot!, state.today), [state.snapshot, state.today]);
  const buckets = useMemo(() => periodBuckets(anchor, h.unit, h.size, h.count), [anchor, h.unit, h.size, h.count]);
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
  // The greedy pass depends on period order, so it runs once over every period.
  const plan = useMemo(() => planReassignments(model, buckets), [model, buckets]);
  return <PlannerContext.Provider value={{ state, model, buckets, hygiene, plan, filters, setFilters }}>{children}</PlannerContext.Provider>;
}

export function usePlanner(): Ctx {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error('usePlanner outside provider');
  return ctx;
}
