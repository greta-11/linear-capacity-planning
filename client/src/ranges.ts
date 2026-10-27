import { addDays } from '../../shared/calendar';
import { defaultRange } from '../../shared/capacity';
import type { Snapshot } from '../../shared/types';

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
