import Papa from 'papaparse';
import { isDay } from '../../shared/calendar';
import type { OooDataset, OooEntry, OooProblem, Person } from '../../shared/types';

// OOO CSV format (header row required, extra columns ignored):
//   email,start_date,end_date,type,fraction,note
// Dates are inclusive YYYY-MM-DD. fraction defaults to 1 (0.5 = half days).
// email "*" marks a company-wide holiday.

export const OOO_COLUMNS = ['email', 'start_date', 'end_date', 'type', 'fraction', 'note'] as const;
const REQUIRED = ['email', 'start_date', 'end_date'];

export function parseOooCsv(text: string, fileName: string, people: Person[], uploadedAt = new Date().toISOString()): OooDataset {
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]));
  const problems: OooProblem[] = [];
  const entries: OooEntry[] = [];

  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'),
  });
  for (const err of parsed.errors) {
    problems.push({ row: (err.row ?? -1) + 1, kind: 'parse', severity: 'error', message: `Row ${(err.row ?? -1) + 1}: ${err.message}.` });
  }
  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) {
    problems.push({ row: 0, kind: 'missing', severity: 'error', message: `Header is missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Expected: ${OOO_COLUMNS.join(',')}.` });
    return { fileName, uploadedAt, entries, problems };
  }

  parsed.data.forEach((raw, index) => {
    const row = index + 1;
    const get = (k: string) => (raw[k] ?? '').trim();
    const email = get('email').toLowerCase();
    const start = get('start_date');
    const end = get('end_date');
    const fail = (kind: OooProblem['kind'], message: string) =>
      problems.push({ row, kind, severity: 'error', message: `Row ${row}: ${message}`, email: email || undefined });

    if (!email) return fail('missing', 'email is empty.');
    if (!isDay(start)) return fail('date', `start_date "${start}" is not a YYYY-MM-DD date.`);
    if (!isDay(end)) return fail('date', `end_date "${end}" is not a YYYY-MM-DD date.`);
    if (end < start) return fail('range', `end_date ${end} is before start_date ${start}.`);
    const fractionText = get('fraction');
    const fraction = fractionText === '' ? 1 : Number(fractionText);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return fail('fraction', `fraction "${fractionText}" must be a number between 0 and 1.`);

    let personId: string | null = null;
    if (email !== '*') {
      const person = byEmail.get(email);
      if (!person) {
        problems.push({ row, kind: 'unknown-email', severity: 'error', email, message: `Row ${row}: ${email} doesn't match any Linear user, so this absence isn't applied.` });
      } else personId = person.id;
    }
    entries.push({ id: `ooo-${row}`, email, personId, start, end, type: get('type') || 'ooo', fraction, note: get('note'), row });
  });

  // Overlapping entries for the same person are capped at one day per day by the
  // capacity engine; flag them because they usually mean a duplicate export row.
  const byPerson = new Map<string, OooEntry[]>();
  for (const e of entries) byPerson.set(e.email, [...(byPerson.get(e.email) ?? []), e]);
  for (const [email, list] of byPerson) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start <= prev.end) {
        problems.push({
          row: cur.row,
          kind: 'overlap',
          severity: 'warning',
          email,
          message: `Row ${cur.row} overlaps row ${prev.row} (${cur.start} – ${cur.end} vs ${prev.start} – ${prev.end}); overlapping days count once.`,
        });
      }
    }
  }

  problems.sort((a, b) => a.row - b.row);
  return { fileName, uploadedAt, entries, problems };
}

const keyOf = (e: OooEntry) => [e.email, e.start, e.end, e.type, e.fraction].join('|');

export interface OooDiff {
  added: OooEntry[];
  removed: OooEntry[];
  unchanged: number;
}

export function diffOoo(prev: OooDataset | null, next: OooDataset): OooDiff {
  const prevKeys = new Map((prev?.entries ?? []).map((e) => [keyOf(e), e]));
  const nextKeys = new Map(next.entries.map((e) => [keyOf(e), e]));
  return {
    added: next.entries.filter((e) => !prevKeys.has(keyOf(e))),
    removed: (prev?.entries ?? []).filter((e) => !nextKeys.has(keyOf(e))),
    unchanged: next.entries.filter((e) => prevKeys.has(keyOf(e))).length,
  };
}

export function exportOooCsv(dataset: OooDataset | null): string {
  const rows = (dataset?.entries ?? []).map((e) => ({ email: e.email, start_date: e.start, end_date: e.end, type: e.type, fraction: e.fraction, note: e.note }));
  return Papa.unparse({ fields: [...OOO_COLUMNS], data: rows.map((r) => OOO_COLUMNS.map((c) => r[c])) }) + '\n';
}
