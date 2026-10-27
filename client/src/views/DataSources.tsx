import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { previewOoo, useImportOoo, usePull, useResetDemo, useResetSettings, useSaveSettings, type OooPreview } from '../api';
import { usePlanner } from '../context';
import { ago, dateTime, formatRange, pct } from '../format';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Settings drawer: Linear connection details, planner settings, overrides. */
export function SettingsPanel() {
  return (
    <div className="stack">
      <LinearCard />
      <SettingsCard />
      <OverridesCard />
    </div>
  );
}

export function LinearCard() {
  const { state } = usePlanner();
  const pull = usePull();
  const reset = useResetDemo();
  const s = state.snapshot!;
  return (
    <section className="card">
      <h2>Linear</h2>
      {state.mode === 'demo' ? (
        <div className="notice">
          <p>
            <strong>Demo mode.</strong> No LINEAR_API_KEY is set, so the planner uses a generated workspace. "Apply to Linear" writes to <code>data/demo-workspace.json</code>.
          </p>
          <p className="small">To connect your workspace, create a personal API key (Linear → Settings → Security & access → Personal API keys), then in the project folder:</p>
          <pre className="code">{`cp .env.example .env
echo 'LINEAR_API_KEY=lin_api_xxx' >> .env
npm run check:linear     # verify the key and preview what will sync
npm run dev              # restart the app`}</pre>
        </div>
      ) : (
        <p className="small">
          Connected to <strong>{s.organizationName}</strong> with the API key from <code>.env</code>.
        </p>
      )}
      <dl className="facts">
        <dt>Last synced</dt>
        <dd>
          {dateTime(s.fetchedAt)} ({ago(s.fetchedAt)})
        </dd>
        <dt>Pulled</dt>
        <dd>
          {s.teams.length} teams · {s.people.length} people · {s.cycles.length} cycles · {s.issues.length} issues
        </dd>
        <dt>Scope</dt>
        <dd>The last {state.planner.settings.lookbackCycles}+ completed cycles per team (for velocity) and every upcoming cycle, with their issues.</dd>
      </dl>
      <div className="row">
        <button className="btn btn-primary" onClick={() => pull.mutate()} disabled={pull.isPending}>
          {pull.isPending ? 'Syncing…' : 'Sync now'}
        </button>
        {state.mode === 'demo' && (
          <button className="btn" onClick={() => confirm('Regenerate the demo workspace? Demo changes you applied will be lost.') && reset.mutate()} disabled={reset.isPending}>
            Reset demo data
          </button>
        )}
      </div>
      <h3>Sync history</h3>
      <table className="table table-compact">
        <tbody>
          {state.syncHistory.slice(0, 6).map((r) => (
            <tr key={r.at}>
              <td>{dateTime(r.at)}</td>
              <td>{r.ok ? <span className="ok-text">✓ ok</span> : <span className="error">✗ failed</span>}</td>
              <td className="small">{r.ok ? `${r.counts?.issues} issues${r.staleEntries ? ` · ${r.staleEntries} accepted change(s) out of date` : ''}` : r.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function OooCard() {
  const { state } = usePlanner();
  const imp = useImportOoo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ fileName: string; csv: string; preview: OooPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ooo = state.ooo;

  const onFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    try {
      const csv = await file.text();
      setPending({ fileName: file.name, csv, preview: await previewOoo({ fileName: file.name, csv }) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const fatal = pending?.preview.dataset.problems.find((p) => p.row === 0);

  return (
    <section className="card" data-testid="ooo-card">
      <p className="small">
        OOO comes from a Workday export. To change it, fix it in Workday, export a new CSV, and import it here (or run <code>npm run import:ooo -- ./ooo.csv</code>).
      </p>
      <dl className="facts">
        <dt>Current file</dt>
        <dd>{ooo ? `${ooo.fileName}${ooo.generated ? ' (generated demo data)' : ''}` : 'none imported'}</dd>
        {ooo && (
          <>
            <dt>Imported</dt>
            <dd>{dateTime(ooo.uploadedAt)}</dd>
            <dt>Rows</dt>
            <dd>
              {ooo.entries.length} rows · {ooo.entries.filter((e) => e.email === '*').length} company-wide ·{' '}
              {ooo.problems.length ? <span className="warn-text">{ooo.problems.length} problem(s)</span> : 'no problems'}
            </dd>
          </>
        )}
        <dt>Format</dt>
        <dd>
          <code>email,start_date,end_date,type,fraction,note</code> — inclusive YYYY-MM-DD dates, fraction 0.5 for half days, email <code>*</code> for everyone.
        </dd>
      </dl>
      <div className="row">
        <label className="btn btn-primary">
          Choose CSV…
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="ooo-file" />
        </label>
        <a className="btn" href="/api/ooo/export">
          Download current
        </a>
        <a className="btn btn-ghost" href="/api/ooo/template">
          Template
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {pending && (
        <div className="preview" data-testid="ooo-preview">
          <h3>Preview: {pending.fileName}</h3>
          <p className="small">
            <strong>+{pending.preview.diff.added.length}</strong> new · <strong>−{pending.preview.diff.removed.length}</strong> removed · {pending.preview.diff.unchanged} unchanged vs the current data
          </p>
          {pending.preview.diff.added.length > 0 && <EntryList title="New" entries={pending.preview.diff.added} />}
          {pending.preview.diff.removed.length > 0 && <EntryList title="Removed" entries={pending.preview.diff.removed} />}
          {pending.preview.dataset.problems.length > 0 && (
            <>
              <h4>Problems</h4>
              <ul className="small">
                {pending.preview.dataset.problems.map((p) => (
                  <li key={`${p.row}-${p.kind}`} className={p.severity === 'error' ? 'error' : 'warn-text'}>
                    {p.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!!fatal || imp.isPending}
              onClick={() => imp.mutate({ fileName: pending.fileName, csv: pending.csv }, { onSuccess: () => setPending(null) })}
              data-testid="ooo-import"
            >
              Import and replace current OOO
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
          {imp.error && <p className="error">{(imp.error as Error).message}</p>}
        </div>
      )}
      {ooo && ooo.problems.length > 0 && !pending && (
        <>
          <h3>Problems in the current file</h3>
          <ul className="small">
            {ooo.problems.map((p) => (
              <li key={`${p.row}-${p.kind}`} className={p.severity === 'error' ? 'error' : 'warn-text'}>
                {p.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function EntryList({ title, entries }: { title: string; entries: OooPreview['diff']['added'] }) {
  return (
    <>
      <h4>{title}</h4>
      <ul className="small plain">
        {entries.slice(0, 12).map((e) => (
          <li key={`${e.row}-${e.email}`}>
            {e.email === '*' ? 'Everyone' : e.email} · {e.type} · {formatRange(e.start, e.end)}
            {e.fraction < 1 ? ` (${pct(e.fraction)})` : ''}
          </li>
        ))}
        {entries.length > 12 && <li className="muted">…and {entries.length - 12} more</li>}
      </ul>
    </>
  );
}

export function SettingsCard() {
  const { state } = usePlanner();
  const save = useSaveSettings();
  const reset = useResetSettings();
  const [draft, setDraft] = useState<Settings>(state.planner.settings);
  useEffect(() => setDraft(state.planner.settings), [state.planner.settings]);
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  const setT = (k: keyof Settings['thresholds'], v: number) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [k]: v } }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.planner.settings);
  return (
    <section className="card">
      <h2>Planner settings</h2>
      <p className="small muted">These are stored locally in data/planner.json and never sent to Linear.</p>
      <div className="settings-grid">
        <fieldset>
          <legend>Working days</legend>
          {DAY_NAMES.map((name, i) => (
            <label key={name} className="check">
              <input
                type="checkbox"
                checked={draft.workDays.includes(i)}
                onChange={(e) => set({ workDays: e.target.checked ? [...draft.workDays, i].sort() : draft.workDays.filter((d) => d !== i) })}
              />
              {name}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Default velocity (pts/day, when no history)</span>
          <input type="number" step={0.1} min={0.1} value={draft.defaultVelocity} onChange={(e) => set({ defaultVelocity: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Velocity lookback (completed cycles)</span>
          <input type="number" min={1} max={6} value={draft.lookbackCycles} onChange={(e) => set({ lookbackCycles: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Default unplanned reserve (%)</span>
          <input type="number" min={0} max={90} value={Math.round(draft.defaultUnplannedBuffer * 100)} onChange={(e) => set({ defaultUnplannedBuffer: Number(e.target.value) / 100 })} />
        </label>
        <label className="field">
          <span>Under below (%)</span>
          <input type="number" value={Math.round(draft.thresholds.under * 100)} onChange={(e) => setT('under', Number(e.target.value) / 100)} />
        </label>
        <label className="field">
          <span>At risk above (%)</span>
          <input type="number" value={Math.round(draft.thresholds.atRisk * 100)} onChange={(e) => setT('atRisk', Number(e.target.value) / 100)} />
        </label>
        <label className="field">
          <span>Over above (%)</span>
          <input type="number" value={Math.round(draft.thresholds.over * 100)} onChange={(e) => setT('over', Number(e.target.value) / 100)} />
        </label>
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          Save settings
        </button>
        <button className="btn btn-ghost" onClick={() => reset.mutate()}>
          Reset to defaults
        </button>
        {save.error && <span className="error small">{(save.error as Error).message}</span>}
      </div>
    </section>
  );
}

export function OverridesCard() {
  const { state, model } = usePlanner();
  const p = state.planner;
  const rows = [
    ...Object.entries(p.allocations).map(([id, s]) => ({
      what: `${model.people.get(id)?.name ?? id} · time split`,
      value: Object.entries(s).map(([t, v]) => `${model.teams.get(t)?.key ?? t} ${pct(v)}`).join(' / '),
    })),
    ...Object.entries(p.velocityOverrides).map(([id, v]) => ({ what: `${model.people.get(id)?.name ?? id} · velocity`, value: `${v} pts/day` })),
    ...Object.entries(p.unplannedBuffers).map(([id, v]) => ({ what: `${model.teamName(id)} · unplanned reserve`, value: pct(v) })),
  ];
  return (
    <section className="card">
      <h2>Planner overrides in effect</h2>
      {rows.length ? (
        <table className="table table-compact">
          <tbody>
            {rows.map((r) => (
              <tr key={r.what}>
                <td>{r.what}</td>
                <td>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="small muted">None. Accept a "Keep in planner" recommendation under Adjustments to add one; revert it there too.</p>
      )}
    </section>
  );
}
