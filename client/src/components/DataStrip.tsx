import { useEffect, useState } from 'react';
import { usePull, useWorkdaySync, type AppState } from '../api';
import { ago } from '../format';
import { OooCard, SettingsPanel } from '../views/DataSources';
import { Drawer, Modal } from './Overlay';

// Top strip: one card per data source, each with its own sync button.
// Workday is represented by the imported OOO CSV export; its "sync" re-reads that file.

export function DataStrip({ state }: { state: AppState }) {
  const pull = usePull();
  const workday = useWorkdaySync();
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'ok' ? 4000 : 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const s = state.snapshot;
  const fetchedAt = s?.fetchedAt;
  const stale = fetchedAt ? Date.now() - Date.parse(fetchedAt) > 24 * 3600 * 1000 : true;
  const lastError = state.syncHistory[0] && !state.syncHistory[0].ok ? state.syncHistory[0] : null;
  const ooo = state.ooo;
  const ready = !!s;

  const syncLinear = () =>
    pull.mutate(undefined, {
      onSuccess: (r) => {
        const c = r.record.counts!;
        setToast({ kind: 'ok', text: `Linear synced: ${c.issues} issues, ${c.cycles} cycles, ${c.teams} teams` });
      },
      onError: (e) => setToast({ kind: 'error', text: `Linear sync failed — still showing data from ${ago(fetchedAt)}. ${(e as Error).message}` }),
    });
  const syncWorkday = () =>
    workday.mutate(undefined, {
      onSuccess: (r) => setToast({ kind: 'ok', text: r.fileName ? `Workday OOO up to date · ${r.entries} entries from ${r.fileName}` : 'No Workday OOO export imported yet — use Import CSV.' }),
      onError: (e) => setToast({ kind: 'error', text: `Workday sync failed: ${(e as Error).message}` }),
    });

  return (
    <header className="strip">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▮▮▮
        </span>
        <span className="title">Capacity Planner</span>
        {s && <span className="org">{s.organizationName}</span>}
      </div>
      <div className="sources">
        <div className="source" data-testid="source-linear">
          <span className="source-icon source-linear" aria-hidden>
            ◢
          </span>
          <div className="source-body">
            <div className="source-name">
              Linear <span className={`badge ${state.mode === 'demo' ? 'badge-demo' : 'badge-live'}`}>{state.mode === 'demo' ? 'Demo data' : 'Live'}</span>
            </div>
            <div className={`source-meta ${stale ? 'synced-stale' : ''}`} title={fetchedAt ? new Date(fetchedAt).toLocaleString() : ''}>
              {lastError && !pull.isPending ? <span className="sync-error">Last sync failed · </span> : null}
              Synced {ago(fetchedAt)}
              {s ? ` · ${s.view ? s.view.issueIds.length : s.issues.length} issues · ${s.projects.length} projects` : ''}
            </div>
            {s?.view && (
              <div className="source-meta" data-testid="linear-view">
                View:{' '}
                <a href={s.view.url} target="_blank" rel="noreferrer" className="link">
                  {s.view.name} ↗
                </a>
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-small" onClick={syncLinear} disabled={pull.isPending} data-testid="sync-button">
            <span className={pull.isPending ? 'spin' : ''} aria-hidden>
              ⟳
            </span>
            {pull.isPending ? 'Syncing…' : 'Sync'}
          </button>
        </div>
        <div className="source" data-testid="source-workday">
          <span className="source-icon source-workday" aria-hidden>
            W
          </span>
          <div className="source-body">
            <div className="source-name">
              Workday <span className="badge">OOO via CSV</span>
            </div>
            <div className="source-meta" title="OOO data is imported from a Workday CSV export">
              {ooo ? `${ooo.fileName}${ooo.generated ? ' (sample)' : ''} · ${ooo.entries.length} entries` : 'No export imported'}
              {ooo?.problems.length ? <span className="warn-text"> · {ooo.problems.length} problem(s)</span> : null} · synced {ago(state.workdaySyncedAt ?? ooo?.uploadedAt)}
            </div>
          </div>
          <button className="btn btn-small" onClick={syncWorkday} disabled={workday.isPending} data-testid="workday-sync">
            <span className={workday.isPending ? 'spin' : ''} aria-hidden>
              ⟳
            </span>
            {workday.isPending ? 'Syncing…' : 'Sync'}
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => setImporting(true)} disabled={!ready} data-testid="import-csv">
            Import CSV
          </button>
        </div>
        <button className="btn btn-ghost btn-small settings-btn" onClick={() => setSettings(true)} disabled={!ready} aria-label="Settings" data-testid="settings">
          ⚙ Settings
        </button>
      </div>
      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" data-testid="toast">
          {toast.text}
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {importing && (
        <Modal title="Import Workday OOO export (CSV)" onClose={() => setImporting(false)} testId="import-modal">
          <OooCard />
        </Modal>
      )}
      {settings && (
        <Drawer title="Data & settings" onClose={() => setSettings(false)} testId="settings-drawer">
          <SettingsPanel />
        </Drawer>
      )}
    </header>
  );
}
