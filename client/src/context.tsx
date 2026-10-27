import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PeriodUnit } from '../../shared/calendar';
import { buildModel, type CapacityModel } from '../../shared/capacity';
import { generateRecommendations } from '../../shared/recommendations';
import type { Recommendation, VelocityMode } from '../../shared/types';
import type { AppState } from './api';

export type View = 'risk' | 'heatmap' | 'recs';

export interface HeatmapFilters {
  unit: PeriodUnit;
  size: number;
  count: number;
  projects: string[];
  teams: string[];
  people: string[];
}

export interface Filters {
  view: View;
  /** Shared by every tab so risk scores, heat map and recommendations agree. */
  velocity: VelocityMode;
  heatmap: HeatmapFilters;
  risk: { teamId: string | null; includeNoTarget: boolean };
  /** Recommendations work on a date range of cycles. */
  recs: { preset: string; from: string; to: string; teamId: string | null };
}

interface Ctx {
  state: AppState;
  model: CapacityModel;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  recommendations: Recommendation[];
}

const PlannerContext = createContext<Ctx | null>(null);

export function PlannerProvider({ state, filters, setFilters, children }: { state: AppState; filters: Filters; setFilters: Ctx['setFilters']; children: ReactNode }) {
  const velocityKey = JSON.stringify(filters.velocity);
  const model = useMemo(
    () =>
      buildModel({
        snapshot: state.snapshot!,
        ooo: state.ooo,
        planner: state.planner,
        range: { from: filters.recs.from, to: filters.recs.to },
        today: state.today,
        velocityMode: filters.velocity,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, filters.recs.from, filters.recs.to, velocityKey],
  );
  const recommendations = useMemo(() => generateRecommendations(model, state.ooo), [model, state.ooo]);
  return <PlannerContext.Provider value={{ state, model, filters, setFilters, recommendations }}>{children}</PlannerContext.Provider>;
}

export function usePlanner(): Ctx {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error('usePlanner outside provider');
  return ctx;
}
