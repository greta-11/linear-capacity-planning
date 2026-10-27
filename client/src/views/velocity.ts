import type { VelocityInfo } from '../../../shared/capacity';
import type { VelocityMode } from '../../../shared/types';

export function velocityLabel(v: VelocityMode): string {
  return v.kind === 'history' ? 'historical (per person)' : v.kind === 'team-average' ? 'team average' : `${v.pointsPerWeek} pts/week`;
}

export const VELOCITY_SOURCE_LABEL: Record<VelocityInfo['source'], string> = {
  history: 'own history',
  'team-average': 'team average',
  default: 'default velocity',
  manual: 'points per week',
};
