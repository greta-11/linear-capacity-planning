import type { Change, Destination, PlannerState } from './types';

// Where an accepted change ends up: Linear (via issueUpdate), the planner's
// local state, or a to-do for whoever owns the OOO source system.

export function destinationOf(change: Change): Destination {
  if (change.kind.startsWith('issue.')) return 'linear';
  if (change.kind.startsWith('planner.')) return 'planner';
  return 'csv';
}

export const DESTINATION_LABEL: Record<Destination, string> = {
  linear: 'Sync to Linear',
  planner: 'Keep in planner',
  csv: 'Update via CSV',
};

export const DESTINATION_HELP: Record<Destination, string> = {
  linear: 'Scheduling facts the whole team sees in Linear: which cycle, who owns it, how big it is.',
  planner: 'Planning assumptions that Linear has no field for: time splits, velocity, unplanned buffer.',
  csv: 'OOO comes from your HR system. Fix it there, export a new CSV, and import it here.',
};

/** Applies (or, with `revert`, undoes) a planner change. Linear and CSV changes are no-ops here. */
export function applyPlannerChange(state: PlannerState, change: Change, revert = false): void {
  switch (change.kind) {
    case 'planner.allocation': {
      const value = revert ? change.from : change.to;
      if (value) state.allocations[change.personId] = { ...value };
      else delete state.allocations[change.personId];
      break;
    }
    case 'planner.velocity': {
      const value = revert ? change.from : change.to;
      if (value != null) state.velocityOverrides[change.personId] = value;
      else delete state.velocityOverrides[change.personId];
      break;
    }
    case 'planner.unplannedBuffer': {
      const value = revert ? change.from : change.to;
      if (value != null) state.unplannedBuffers[change.teamId] = value;
      else delete state.unplannedBuffers[change.teamId];
      break;
    }
    default:
      break;
  }
}

export function isValidChange(change: unknown): change is Change {
  if (!change || typeof change !== 'object') return false;
  const c = change as Record<string, unknown>;
  switch (c.kind) {
    case 'issue.cycle':
    case 'issue.assignee':
      return typeof c.issueId === 'string' && typeof c.to === 'string';
    case 'issue.estimate':
      return typeof c.issueId === 'string' && typeof c.to === 'number' && Number.isFinite(c.to) && c.to >= 0;
    case 'planner.allocation':
      return typeof c.personId === 'string' && !!c.to && typeof c.to === 'object';
    case 'planner.velocity':
      return typeof c.personId === 'string' && typeof c.to === 'number' && c.to > 0;
    case 'planner.unplannedBuffer':
      return typeof c.teamId === 'string' && typeof c.to === 'number' && c.to >= 0 && c.to < 1;
    case 'csv.ooo':
      return typeof c.email === 'string';
    default:
      return false;
  }
}
