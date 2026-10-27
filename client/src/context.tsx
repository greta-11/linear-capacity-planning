import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { buildModel, type CapacityModel } from '../../shared/capacity';
import { generateRecommendations } from '../../shared/recommendations';
import type { Recommendation } from '../../shared/types';
import type { AppState } from './api';

export interface Filters {
  view: View;
  teamId: string | null;
  from: string;
  to: string;
  preset: string;
}

export type View = 'team' | 'people' | 'adjust' | 'data';

interface Ctx {
  state: AppState;
  model: CapacityModel;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  recommendations: Recommendation[];
}

const PlannerContext = createContext<Ctx | null>(null);

export function PlannerProvider({ state, filters, setFilters, children }: { state: AppState; filters: Filters; setFilters: Ctx['setFilters']; children: ReactNode }) {
  const model = useMemo(
    () => buildModel({ snapshot: state.snapshot!, ooo: state.ooo, planner: state.planner, range: { from: filters.from, to: filters.to }, today: state.today }),
    [state, filters.from, filters.to],
  );
  const recommendations = useMemo(() => generateRecommendations(model, state.ooo), [model, state.ooo]);
  return <PlannerContext.Provider value={{ state, model, filters, setFilters, recommendations }}>{children}</PlannerContext.Provider>;
}

export function usePlanner(): Ctx {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error('usePlanner outside provider');
  return ctx;
}
