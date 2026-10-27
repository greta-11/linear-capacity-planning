import { describe, expect, it } from 'vitest';
import { addDays, countWorkingDays, dayInTimezone, isDay, overlap, weekBuckets, weekday, weekStart } from '../shared/calendar';

describe('calendar', () => {
  it('validates days', () => {
    expect(isDay('2026-11-02')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('11/02/2026')).toBe(false);
  });

  it('computes weekdays and week starts', () => {
    expect(weekday('2026-11-02')).toBe(1);
    expect(weekday('2026-11-08')).toBe(0);
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('counts working days inclusively', () => {
    expect(countWorkingDays('2026-11-02', '2026-11-15', [1, 2, 3, 4, 5])).toBe(10);
    expect(countWorkingDays('2026-11-07', '2026-11-08', [1, 2, 3, 4, 5])).toBe(0);
    expect(countWorkingDays('2026-11-03', '2026-11-02', [1, 2, 3, 4, 5])).toBe(0);
  });

  it('intersects ranges', () => {
    expect(overlap('2026-11-01', '2026-11-10', '2026-11-05', '2026-11-20')).toEqual(['2026-11-05', '2026-11-10']);
    expect(overlap('2026-11-01', '2026-11-04', '2026-11-05', '2026-11-20')).toBeNull();
  });

  it('builds Monday weeks clipped to the range', () => {
    const b = weekBuckets('2026-11-04', '2026-11-17');
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ['2026-11-04', '2026-11-08'],
      ['2026-11-09', '2026-11-15'],
      ['2026-11-16', '2026-11-17'],
    ]);
  });

  it('converts instants to team-local days', () => {
    expect(dayInTimezone('2026-11-02T03:00:00Z', 'America/Los_Angeles')).toBe('2026-11-01');
    expect(dayInTimezone('2026-11-02T03:00:00Z', 'Europe/Berlin')).toBe('2026-11-02');
    expect(dayInTimezone('2026-11-02T03:00:00Z', 'Not/AZone')).toBe('2026-11-02');
  });
});
