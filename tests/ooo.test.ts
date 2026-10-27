import { describe, expect, it } from 'vitest';
import { diffOoo, exportOooCsv, parseOooCsv } from '../server/ooo/csv';
import { fixture } from './fixtures';

const people = fixture().people;

describe('OOO CSV', () => {
  it('parses valid rows, defaults fraction and matches emails case-insensitively', () => {
    const d = parseOooCsv('Email,Start Date,End Date,Type,Fraction,Note\nALICE@x.dev,2026-11-03,2026-11-04,vacation,,Trip\n*,2026-11-26,2026-11-26,holiday,1,\n', 'a.csv', people);
    expect(d.problems).toEqual([]);
    expect(d.entries).toHaveLength(2);
    expect(d.entries[0]).toMatchObject({ email: 'alice@x.dev', personId: 'A', fraction: 1, row: 1, note: 'Trip' });
    expect(d.entries[1]).toMatchObject({ email: '*', personId: null });
  });

  it('reports row-level errors and skips bad rows', () => {
    const csv = [
      'email,start_date,end_date,type,fraction',
      ',2026-11-03,2026-11-04,vacation,1',
      'alice@x.dev,11/03/2026,2026-11-04,vacation,1',
      'alice@x.dev,2026-11-05,2026-11-04,vacation,1',
      'alice@x.dev,2026-11-05,2026-11-06,vacation,2',
      'nobody@x.dev,2026-11-05,2026-11-06,vacation,1',
    ].join('\n');
    const d = parseOooCsv(csv, 'b.csv', people);
    expect(d.problems.map((p) => [p.row, p.kind])).toEqual([
      [1, 'missing'],
      [2, 'date'],
      [3, 'range'],
      [4, 'fraction'],
      [5, 'unknown-email'],
    ]);
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0].personId).toBeNull();
  });

  it('rejects a file without the required columns', () => {
    const d = parseOooCsv('name,from,to\nAlice,2026-11-03,2026-11-04\n', 'c.csv', people);
    expect(d.entries).toHaveLength(0);
    expect(d.problems[0]).toMatchObject({ row: 0, kind: 'missing' });
  });

  it('flags overlapping rows for the same person', () => {
    const d = parseOooCsv('email,start_date,end_date\nalice@x.dev,2026-11-03,2026-11-05\nalice@x.dev,2026-11-05,2026-11-06\n', 'd.csv', people);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatchObject({ row: 2, kind: 'overlap', severity: 'warning' });
  });

  it('diffs and round-trips', () => {
    const a = parseOooCsv('email,start_date,end_date\nalice@x.dev,2026-11-03,2026-11-05\n', 'a.csv', people);
    const b = parseOooCsv('email,start_date,end_date\nalice@x.dev,2026-11-03,2026-11-05\nbob@x.dev,2026-11-10,2026-11-10\n', 'b.csv', people);
    const diff = diffOoo(a, b);
    expect(diff.added.map((e) => e.email)).toEqual(['bob@x.dev']);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
    const again = parseOooCsv(exportOooCsv(b), 'e.csv', people);
    expect(again.entries.map((e) => [e.email, e.start, e.end, e.fraction])).toEqual(b.entries.map((e) => [e.email, e.start, e.end, e.fraction]));
  });
});
