import type { Day } from './types';

// Calendar math on 'YYYY-MM-DD' strings. Days are treated as UTC calendar dates
// so no local timezone can shift them.

const MS_PER_DAY = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const n = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(n) && toDay(n / MS_PER_DAY) === value;
}

export function dayNumber(day: Day): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);
}

export function toDay(n: number): Day {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(day: Day, days: number): Day {
  return toDay(dayNumber(day) + days);
}

export function diffDays(a: Day, b: Day): number {
  return dayNumber(b) - dayNumber(a);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: Day): number {
  return (dayNumber(day) + 4) % 7; // 1970-01-01 was a Thursday
}

export function minDay(a: Day, b: Day): Day {
  return a < b ? a : b;
}

export function maxDay(a: Day, b: Day): Day {
  return a > b ? a : b;
}

/** Inclusive overlap of two inclusive ranges, or null. */
export function overlap(aStart: Day, aEnd: Day, bStart: Day, bEnd: Day): [Day, Day] | null {
  const start = maxDay(aStart, bStart);
  const end = minDay(aEnd, bEnd);
  return start <= end ? [start, end] : null;
}

export function eachDay(start: Day, end: Day): Day[] {
  const out: Day[] = [];
  for (let n = dayNumber(start), last = dayNumber(end); n <= last; n++) out.push(toDay(n));
  return out;
}

export function isWorkDay(day: Day, workDays: number[]): boolean {
  return workDays.includes(weekday(day));
}

export function workingDays(start: Day, end: Day, workDays: number[]): Day[] {
  if (start > end) return [];
  return eachDay(start, end).filter((d) => isWorkDay(d, workDays));
}

export function countWorkingDays(start: Day, end: Day, workDays: number[]): number {
  return workingDays(start, end, workDays).length;
}

/** Monday of the week containing `day`. */
export function weekStart(day: Day): Day {
  return addDays(day, -((weekday(day) + 6) % 7));
}

export interface Bucket {
  id: string;
  label: string;
  start: Day;
  end: Day;
}

/** Monday-based weeks covering [from, to], clipped to the range. */
export function weekBuckets(from: Day, to: Day): Bucket[] {
  const out: Bucket[] = [];
  for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
    const start = maxDay(ws, from);
    const end = minDay(addDays(ws, 6), to);
    out.push({ id: ws, label: `Wk of ${formatShort(ws)}`, start, end });
  }
  return out;
}

export type PeriodUnit = 'week' | 'month' | 'quarter';

/** First day of the month `months` after the month containing `day`. */
export function addMonths(day: Day, months: number): Day {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
}

function periodLabel(unit: PeriodUnit, size: number, start: Day, end: Day): string {
  const year = (d: Day) => d.slice(0, 4);
  const month = (d: Day) => MONTHS[Number(d.slice(5, 7)) - 1];
  if (unit === 'week') return formatRange(start, end);
  if (unit === 'month') {
    if (size === 1) return `${month(start)} ${year(start)}`;
    return year(start) === year(end) ? `${month(start)} – ${month(end)} ${year(end)}` : `${month(start)} ${year(start)} – ${month(end)} ${year(end)}`;
  }
  const q = (d: Day) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  return size === 1 ? `${q(start)} ${year(start)}` : `${q(start)} ${year(start)} – ${q(end)} ${year(end)}`;
}

/**
 * `count` consecutive periods of `size` weeks, months or quarters, starting on `anchor`
 * (the planning start, which may be in the past). Weeks run from the anchor in steps of
 * 7 days, so 2-week periods line up with 2-week cycles. Month and quarter periods end on
 * calendar boundaries: the first one runs from the anchor to the end of its month/quarter.
 */
export function periodBuckets(anchor: Day, unit: PeriodUnit, size: number, count: number): Bucket[] {
  const n = Math.max(1, Math.floor(size));
  const out: Bucket[] = [];
  let periodStart: Day = anchor;
  // Calendar start of the anchor's month/quarter, for month and quarter steps.
  let calendarStart: Day =
    unit === 'month' ? `${anchor.slice(0, 7)}-01` : addMonths(`${anchor.slice(0, 4)}-01-01`, Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) * 3);
  for (let i = 0; i < Math.max(1, count); i++) {
    const next = unit === 'week' ? addDays(periodStart, 7 * n) : addMonths(calendarStart, unit === 'month' ? n : 3 * n);
    const end = addDays(next, -1);
    out.push({ id: periodStart, label: periodLabel(unit, n, unit === 'week' ? periodStart : calendarStart, end), start: periodStart, end });
    periodStart = next;
    calendarStart = next;
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatShort(day: Day): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}

export function formatRange(start: Day, end: Day): string {
  return start === end ? formatShort(start) : `${formatShort(start)} – ${formatShort(end)}`;
}

/** Today's date in the machine's local timezone. */
export function localToday(now = new Date()): Day {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Calendar date of an instant in an IANA timezone (falls back to UTC on bad zones). */
export function dayInTimezone(iso: string, timeZone: string): Day {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
