import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { localToday } from '../shared/calendar';
import { DEFAULT_SETTINGS } from '../shared/capacity';
import type { Settings } from '../shared/types';
import { resetDemoWorkspace } from './demo/workspace';
import { diffOoo, exportOooCsv, OOO_COLUMNS, parseOooCsv } from './ooo/csv';
import { accept, applyToLinear, currentOoo, discard, ensureSnapshot, mode, pull, revert, setCsvStatus, setDismissed } from './service';
import { DATA_DIR, store } from './store';

const app = express();
app.use(express.json({ limit: '5mb' }));

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

app.get(
  '/api/state',
  wrap(async (_req, res) => {
    const snapshot = await ensureSnapshot();
    res.json({
      mode: mode(),
      today: localToday(),
      snapshot,
      ooo: currentOoo(snapshot),
      planner: store.planner(),
      syncHistory: store.syncHistory(),
      dataDir: DATA_DIR,
    });
  }),
);

app.post(
  '/api/linear/pull',
  wrap(async (_req, res) => {
    const result = await pull();
    res.status(result.ok ? 200 : 502).json({ ok: result.ok, record: result.record });
  }),
);

app.post(
  '/api/linear/apply',
  wrap(async (req, res) => {
    const ids: unknown = req.body?.entryIds;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) return res.status(400).json({ error: 'entryIds must be a list of ledger ids.' });
    res.json(await applyToLinear(ids));
  }),
);

app.post(
  '/api/ledger',
  wrap((req, res) => {
    res.json(accept(req.body));
  }),
);
app.post(
  '/api/ledger/:id/revert',
  wrap((req, res) => {
    res.json(revert(req.params.id));
  }),
);
app.post(
  '/api/ledger/:id/csv-status',
  wrap((req, res) => {
    res.json(setCsvStatus(req.params.id, !!req.body?.done));
  }),
);
app.delete(
  '/api/ledger/:id',
  wrap((req, res) => {
    discard(req.params.id);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/dismissed',
  wrap((req, res) => {
    if (typeof req.body?.id !== 'string') return res.status(400).json({ error: 'id is required.' });
    setDismissed(req.body.id, req.body.dismissed !== false);
    res.json({ ok: true });
  }),
);

app.put(
  '/api/settings',
  wrap((req, res) => {
    const s = req.body as Partial<Settings>;
    const planner = store.planner();
    const next: Settings = { ...planner.settings, ...s, thresholds: { ...planner.settings.thresholds, ...s.thresholds } };
    const t = next.thresholds;
    const valid =
      Array.isArray(next.workDays) &&
      next.workDays.length > 0 &&
      next.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
      next.defaultVelocity > 0 &&
      Number.isInteger(next.lookbackCycles) &&
      next.lookbackCycles >= 1 &&
      next.lookbackCycles <= 6 &&
      next.defaultUnplannedBuffer >= 0 &&
      next.defaultUnplannedBuffer < 1 &&
      t.under > 0 &&
      t.under < t.atRisk &&
      t.atRisk < t.over;
    if (!valid) return res.status(400).json({ error: 'Invalid settings.' });
    planner.settings = next;
    store.savePlanner(planner);
    res.json(planner.settings);
  }),
);
app.post(
  '/api/settings/reset',
  wrap((_req, res) => {
    const planner = store.planner();
    planner.settings = structuredClone(DEFAULT_SETTINGS);
    store.savePlanner(planner);
    res.json(planner.settings);
  }),
);

// OOO: preview a CSV against the current one, then import it.
const readCsvBody = (req: Request) => {
  const { fileName, csv } = req.body ?? {};
  if (typeof csv !== 'string' || !csv.trim()) throw Object.assign(new Error('CSV content is empty.'), { status: 400 });
  return { fileName: typeof fileName === 'string' && fileName ? fileName : 'ooo.csv', csv };
};
app.post(
  '/api/ooo/preview',
  wrap(async (req, res) => {
    const { fileName, csv } = readCsvBody(req);
    const snapshot = await ensureSnapshot();
    const dataset = parseOooCsv(csv, fileName, snapshot?.people ?? []);
    res.json({ dataset, diff: diffOoo(currentOoo(snapshot), dataset) });
  }),
);
app.post(
  '/api/ooo',
  wrap(async (req, res) => {
    const { fileName, csv } = readCsvBody(req);
    const snapshot = await ensureSnapshot();
    const dataset = parseOooCsv(csv, fileName, snapshot?.people ?? []);
    if (dataset.problems.some((p) => p.kind === 'missing' && p.row === 0)) return res.status(400).json({ error: dataset.problems[0].message });
    store.saveOoo({ fileName, uploadedAt: dataset.uploadedAt, csv });
    res.json(dataset);
  }),
);
app.get(
  '/api/ooo/export',
  wrap(async (_req, res) => {
    const ooo = currentOoo(await ensureSnapshot());
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${ooo?.fileName ?? 'ooo.csv'}"`);
    res.send(exportOooCsv(ooo));
  }),
);
app.get('/api/ooo/template', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="ooo-template.csv"');
  res.send(`${OOO_COLUMNS.join(',')}\nperson@example.com,2026-12-21,2026-12-24,vacation,1,Winter break\n*,2026-12-25,2026-12-25,holiday,1,Company holiday\n`);
});

app.post(
  '/api/demo/reset',
  wrap(async (_req, res) => {
    if (mode() !== 'demo') return res.status(400).json({ error: 'Only available in demo mode.' });
    resetDemoWorkspace();
    const result = await pull();
    res.json({ ok: result.ok, record: result.record });
  }),
);

// Production: serve the built client.
const clientDir = path.resolve('dist/client');
if (process.env.NODE_ENV === 'production' && fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  res.status(err.status ?? 400).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, '127.0.0.1', () => {
  const where = process.env.NODE_ENV === 'production' ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173';
  console.log(`Capacity planner API on http://127.0.0.1:${port} (${mode() === 'linear' ? 'Linear' : 'demo data — set LINEAR_API_KEY to use Linear'})`);
  console.log(`Open ${where}`);
});
