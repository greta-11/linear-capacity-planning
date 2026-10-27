import { formatRange, formatShort } from '../../shared/calendar';
import type { Status } from '../../shared/capacity';

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
export const pts = (n: number) => `${Math.round(n * 10) / 10}`;
export const ptsUnit = (n: number) => `${pts(n)} pts`;
export const days = (n: number) => `${Math.round(n * 10) / 10} day${n === 1 ? '' : 's'}`;
export { formatRange, formatShort };

export const STATUS_LABEL: Record<Status, string> = {
  none: 'No capacity',
  under: 'Under',
  healthy: 'Healthy',
  'at-risk': 'At risk',
  over: 'Over',
};

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
