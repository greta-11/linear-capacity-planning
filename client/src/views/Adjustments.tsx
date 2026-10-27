import { useMemo, useState } from 'react';
import { DESTINATION_HELP, DESTINATION_LABEL } from '../../../shared/changes';
import type { Change, Destination, LedgerEntry, Recommendation } from '../../../shared/types';
import { useAccept, useApply, useCsvStatus, useDiscard, useDismiss, useRevert } from '../api';
import { useVisibleRecommendations } from '../App';
import { ChangeLine, EvidencePanel } from '../components/Evidence';
import { Empty } from '../components/ui';
import { usePlanner } from '../context';
import { dateTime } from '../format';

const DESTINATIONS: Destination[] = ['linear', 'planner', 'csv'];
const ACCEPT_LABEL: Record<Destination, string> = { linear: 'Queue for Linear', planner: 'Apply in planner', csv: 'Add OOO to-do' };
const OPTION_LABEL: Record<string, string> = {
  defer: 'Move to a later cycle',
  reassign: 'Reassign',
};

export function Adjustments() {
  const { recommendations, state, setFilters } = usePlanner();
  const visible = useVisibleRecommendations(recommendations);
  const [dest, setDest] = useState<Destination | 'all'>('all');
  const dismiss = useDismiss();

  const groups = useMemo(() => {
    const map = new Map<string, Recommendation[]>();
    for (const r of visible) {
      if (dest !== 'all' && r.destination !== dest) continue;
      map.set(r.group, [...(map.get(r.group) ?? []), r]);
    }
    return [...map.values()];
  }, [visible, dest]);

  const counts = Object.fromEntries(DESTINATIONS.map((d) => [d, visible.filter((r) => r.destination === d).length])) as Record<Destination, number>;
  const dismissedCount = state.planner.dismissed.length;

  return (
    <div className="stack">
      <p className="lede">
        Recommendations come from the same numbers as the capacity views, and each one shows its evidence. When you accept one, it goes to one of three places, depending on who owns that information:
      </p>
      <div className="dest-cards">
        {DESTINATIONS.map((d) => (
          <button key={d} className={`dest-card dest-${d} ${dest === d ? 'dest-active' : ''}`} onClick={() => setDest(dest === d ? 'all' : d)} aria-pressed={dest === d}>
            <div className="dest-title">
              <span className={`dest-dot dest-dot-${d}`} aria-hidden /> {DESTINATION_LABEL[d]} <span className="count">{counts[d]}</span>
            </div>
            <div className="small muted">{DESTINATION_HELP[d]}</div>
          </button>
        ))}
      </div>
      <div className="adjust-layout">
        <section>
          <div className="section-head">
            <h2>Recommendations {dest !== 'all' && <span className="muted">· {DESTINATION_LABEL[dest]}</span>}</h2>
            {dismissedCount > 0 && (
              <button className="btn btn-ghost btn-small" onClick={() => state.planner.dismissed.forEach((id) => dismiss.mutate({ id, dismissed: false }))}>
                Restore {dismissedCount} dismissed
              </button>
            )}
          </div>
          {groups.length ? (
            groups.map((g) => <RecommendationGroup key={g[0].group} recs={g} />)
          ) : (
            <Empty>
              Nothing to recommend for this team and date range.{' '}
              <button className="link-button" onClick={() => setFilters({ preset: 'next-12-weeks' })}>
                Widen the range
              </button>
            </Empty>
          )}
        </section>
        <Ledger />
      </div>
    </div>
  );
}

function RecommendationGroup({ recs }: { recs: Recommendation[] }) {
  const [active, setActive] = useState(0);
  const rec = recs[Math.min(active, recs.length - 1)];
  return (
    <article className={`rec rec-${rec.severity}`} data-testid={`rec-${rec.rule}`} data-group={rec.group}>
      {recs.length > 1 && (
        <div className="rec-options" role="tablist" aria-label="Alternatives">
          <span className="muted small">{recs.length} options:</span>
          {recs.map((r, i) => (
            <button key={r.id} role="tab" aria-selected={i === active} className={`opt ${i === active ? 'opt-active' : ''}`} onClick={() => setActive(i)}>
              {OPTION_LABEL[r.rule] ?? r.rule}
            </button>
          ))}
        </div>
      )}
      <RecommendationBody key={rec.id} rec={rec} />
    </article>
  );
}

function RecommendationBody({ rec }: { rec: Recommendation }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<number, number>>({});
  const accept = useAccept();
  const dismiss = useDismiss();
  const changes: Change[] = rec.changes.map((c, i) => {
    const v = values[i];
    if (v == null || !('to' in c) || typeof c.to !== 'number') return c;
    return { ...c, to: v } as Change;
  });
  const invalid = changes.some((c) => 'to' in c && typeof c.to === 'number' && (!Number.isFinite(c.to) || c.to <= 0));

  return (
    <>
      <div className="rec-head">
        <span className={`sev sev-${rec.severity}`}>{rec.severity}</span>
        <span className={`dest-badge dest-badge-${rec.destination}`}>{DESTINATION_LABEL[rec.destination]}</span>
      </div>
      <h3 className="rec-title">{rec.title}</h3>
      <p className="rec-summary">{rec.summary}</p>
      <div className="rec-changes">
        {changes.map((c, i) => (
          <div key={i} className="rec-change">
            <ChangeLine change={c} />
            {rec.editable && 'to' in c && typeof c.to === 'number' && (
              <label className="inline-edit">
                <span className="sr-only">Proposed value</span>
                <input
                  type="number"
                  step={c.kind === 'issue.estimate' ? 1 : c.kind === 'planner.unplannedBuffer' ? 5 : 0.05}
                  min={0}
                  value={c.kind === 'planner.unplannedBuffer' ? Math.round(c.to * 100) : c.to}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setValues((v) => ({ ...v, [i]: c.kind === 'planner.unplannedBuffer' ? n / 100 : n }));
                  }}
                />
                {c.kind === 'planner.unplannedBuffer' && <span className="muted">%</span>}
              </label>
            )}
          </div>
        ))}
      </div>
      <div className="rec-actions">
        <button className="btn btn-primary" disabled={accept.isPending || invalid} onClick={() => accept.mutate({ rec, changes })} data-testid="accept">
          {ACCEPT_LABEL[rec.destination]}
        </button>
        <button className="btn" onClick={() => dismiss.mutate({ id: rec.id, dismissed: true })}>
          Dismiss
        </button>
        <button className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="toggle-evidence">
          {open ? 'Hide evidence' : 'Show evidence'}
        </button>
        {accept.error && <span className="error small">{(accept.error as Error).message}</span>}
      </div>
      {open && <EvidencePanel evidence={rec.evidence} />}
    </>
  );
}

const STATUS_TEXT: Record<LedgerEntry['status'], string> = {
  pending: 'Ready to sync',
  stale: 'Out of date',
  synced: 'Synced',
  failed: 'Failed',
  applied: 'In effect',
  reverted: 'Reverted',
  open: 'To do',
  done: 'Done',
};

function Ledger() {
  const { state } = usePlanner();
  const [reviewing, setReviewing] = useState(false);
  const ledger = state.planner.ledger;
  const by = (d: Destination) => ledger.filter((e) => e.destination === d);
  const pending = ledger.filter((e) => e.status === 'pending');
  return (
    <aside className="ledger" data-testid="ledger">
      <h2>Change ledger</h2>
      <div className="ledger-section">
        <div className="ledger-head">
          <h3>
            <span className="dest-dot dest-dot-linear" aria-hidden /> {DESTINATION_LABEL.linear}
          </h3>
          <button className="btn btn-primary btn-small" disabled={!pending.length} onClick={() => setReviewing(true)} data-testid="review-apply">
            Review & apply ({pending.length})
          </button>
        </div>
        <LedgerList entries={by('linear')} empty="Accepted cycle, assignee and estimate changes wait here until you apply them." />
      </div>
      <div className="ledger-section">
        <h3>
          <span className="dest-dot dest-dot-planner" aria-hidden /> {DESTINATION_LABEL.planner}
        </h3>
        <LedgerList entries={by('planner')} empty="Accepted time splits, velocities and buffers apply here right away. Nothing is sent to Linear." />
      </div>
      <div className="ledger-section">
        <h3>
          <span className="dest-dot dest-dot-csv" aria-hidden /> {DESTINATION_LABEL.csv}
        </h3>
        <LedgerList entries={by('csv')} empty="OOO problems to fix in your HR system. After fixing, export a new CSV and import it under Data sources." />
      </div>
      {reviewing && <SyncReview entries={pending} onClose={() => setReviewing(false)} />}
    </aside>
  );
}

function LedgerList({ entries, empty }: { entries: LedgerEntry[]; empty: string }) {
  const revert = useRevert();
  const discard = useDiscard();
  const csv = useCsvStatus();
  if (!entries.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="ledger-list">
      {entries.map((e) => (
        <li key={e.id} className={`ledger-entry status-${e.status}`} data-testid={`ledger-${e.status}`}>
          <div className="ledger-entry-head">
            <span className={`status-badge status-badge-${e.status}`}>{STATUS_TEXT[e.status]}</span>
            <span className="muted small">
              {e.acceptedBy} · {dateTime(e.acceptedAt)}
            </span>
          </div>
          <div className="ledger-title">{e.title}</div>
          {e.changes.map((c, i) => (
            <ChangeLine key={i} change={c} />
          ))}
          <div className="muted small">Because: {e.reason}</div>
          {e.note && <div className="small warn-text">{e.note}</div>}
          {e.results && e.status !== 'synced' && (
            <ul className="small">
              {e.results.map((r, i) => (
                <li key={i} className={r.ok ? '' : 'error'}>
                  {r.message}
                </li>
              ))}
            </ul>
          )}
          <div className="ledger-actions">
            {e.destination === 'planner' && e.status === 'applied' && (
              <button className="btn btn-small" onClick={() => revert.mutate(e.id)}>
                Revert
              </button>
            )}
            {e.destination === 'csv' && (
              <label className="small">
                <input type="checkbox" checked={e.status === 'done'} onChange={(ev) => csv.mutate({ id: e.id, done: ev.target.checked })} /> Fixed in source
              </label>
            )}
            {(['pending', 'stale', 'failed'].includes(e.status) || (e.destination === 'csv' && e.status === 'done')) && (
              <button className="btn btn-ghost btn-small" onClick={() => discard.mutate(e.id)}>
                Remove
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SyncReview({ entries, onClose }: { entries: LedgerEntry[]; onClose: () => void }) {
  const { state } = usePlanner();
  const apply = useApply();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(entries.map((e) => e.id)));
  const [confirming, setConfirming] = useState(false);
  const changeCount = entries.filter((e) => selected.has(e.id)).reduce((a, e) => a + e.changes.length, 0);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const results = apply.data?.entries;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-testid="sync-review">
        <h2 id="sync-title">Apply to Linear</h2>
        {state.mode === 'demo' && <p className="notice">Demo mode: changes are written to the local demo workspace. Nothing is sent to Linear.</p>}
        {results ? (
          <>
            <ul className="ledger-list">
              {results.map((e) => (
                <li key={e.id} className={`ledger-entry status-${e.status}`} data-testid={`result-${e.status}`}>
                  <span className={`status-badge status-badge-${e.status}`}>{STATUS_TEXT[e.status]}</span> <strong>{e.title}</strong>
                  <ul className="small">
                    {e.results?.map((r, i) => (
                      <li key={i} className={r.ok ? '' : 'error'}>
                        {r.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="small muted">{apply.data?.pull.ok ? 'Re-synced from Linear; every view now reflects these changes.' : `Re-sync failed: ${apply.data?.pull.error}`}</p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose} data-testid="close-review">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="small muted">Before each write, the planner checks the issue's current value in Linear and skips anything that changed since you accepted it.</p>
            <ul className="review-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <label>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                    <span>
                      <strong>{e.title}</strong>
                      {e.changes.map((c, i) => (
                        <ChangeLine key={i} change={c} />
                      ))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {apply.error && <p className="error">{(apply.error as Error).message}</p>}
            <div className="modal-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              {confirming ? (
                <button className="btn btn-danger" disabled={apply.isPending || !selected.size} onClick={() => apply.mutate([...selected])} data-testid="confirm-apply">
                  {apply.isPending ? 'Applying…' : `Confirm: write ${changeCount} change${changeCount === 1 ? '' : 's'} to ${state.snapshot?.organizationName}`}
                </button>
              ) : (
                <button className="btn btn-primary" disabled={!selected.size} onClick={() => setConfirming(true)} data-testid="apply-selected">
                  Apply {selected.size} selected
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
