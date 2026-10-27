import type { CapacityModel } from '../../../shared/capacity';
import type { Change, Evidence } from '../../../shared/types';
import { usePlanner } from '../context';
import { ago, dateTime, formatRange, pct, pts } from '../format';
import { CycleLabel, IssueTable } from './ui';

export function describeChange(change: Change, model: CapacityModel): { subject: string; from: string; to: string; field: string } {
  const person = (id: string | null) => (id ? (model.people.get(id)?.name ?? 'Unknown') : 'Unassigned');
  const cycle = (id: string | null) => (id ? model.cycleLabel(id) : 'No cycle');
  const split = (s: Record<string, number> | null) => (s ? Object.entries(s).map(([t, v]) => `${model.teams.get(t)?.key ?? t} ${pct(v)}`).join(' / ') : 'derived');
  switch (change.kind) {
    case 'issue.cycle':
      return { subject: change.identifier, field: 'Cycle', from: cycle(change.from), to: cycle(change.to) };
    case 'issue.assignee':
      return { subject: change.identifier, field: 'Assignee', from: person(change.from), to: person(change.to) };
    case 'issue.estimate':
      return { subject: change.identifier, field: 'Estimate', from: change.from == null ? 'none' : String(change.from), to: String(change.to) };
    case 'planner.allocation':
      return { subject: person(change.personId), field: 'Time split', from: split(change.from), to: split(change.to) };
    case 'planner.velocity':
      return { subject: person(change.personId), field: 'Velocity', from: change.from == null ? 'from history' : `${change.from} pts/day`, to: `${change.to} pts/day` };
    case 'planner.unplannedBuffer':
      return { subject: model.teamName(change.teamId), field: 'Unplanned buffer', from: change.from == null ? `default ${pct(model.input.planner.settings.defaultUnplannedBuffer)}` : pct(change.from), to: pct(change.to) };
    case 'csv.ooo':
      return { subject: change.email, field: `OOO rows ${change.rows.join(', ')}`, from: 'as exported', to: 'fix in HR system, re-import' };
  }
}

export function ChangeLine({ change }: { change: Change }) {
  const { model } = usePlanner();
  const d = describeChange(change, model);
  return (
    <div className="change-line">
      <span className="change-subject">{d.subject}</span> <span className="muted">{d.field}:</span> <span className="change-from">{d.from}</span> <span aria-hidden>→</span>{' '}
      <span className="change-to">{d.to}</span>
    </div>
  );
}

export function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const { model, state } = usePlanner();
  const highlight = new Set(evidence.issues.filter((i) => i.highlight).map((i) => i.issueId));
  const notes = Object.fromEntries(evidence.issues.filter((i) => i.note).map((i) => [i.issueId, i.note!]));
  const oooEntries = evidence.oooEntryIds.map((id) => model.oooEntries.get(id)).filter(Boolean);
  const problems = (state.ooo?.problems ?? []).filter((p) => evidence.oooProblemRows.includes(p.row));
  const f = evidence.freshness;
  return (
    <div className="evidence" data-testid="evidence">
      <div className="evidence-metric">
        <div className="muted small">Trigger</div>
        <div>
          <strong>{evidence.metric.label}:</strong> {evidence.metric.value}
          {evidence.metric.threshold && <span className="muted"> · {evidence.metric.threshold}</span>}
        </div>
      </div>
      <div className="evidence-section">
        <div className="muted small">Rule</div>
        <div>{evidence.rule}</div>
      </div>
      <div className="evidence-section">
        <div className="muted small">Why this action</div>
        <ul>
          {evidence.rationale.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      {evidence.facts.length > 0 && (
        <div className="evidence-section">
          <div className="muted small">Inputs</div>
          <dl className="facts">
            {evidence.facts.map((fct) => (
              <div key={fct.label} className="fact">
                <dt>{fct.label}</dt>
                <dd>{fct.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {evidence.cycles.length > 0 && (
        <div className="evidence-section">
          <div className="muted small">Cycles</div>
          <ul className="plain small">
            {evidence.cycles.map((c) => (
              <li key={c.cycleId}>
                <CycleLabel id={c.cycleId} /> ({formatRange(model.cycles.get(c.cycleId)?.startDate ?? '', model.cycles.get(c.cycleId)?.endDate ?? '')}): {c.note ?? `${pts(c.points)} pts`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {oooEntries.length > 0 && (
        <div className="evidence-section">
          <div className="muted small">OOO rows ({state.ooo?.fileName})</div>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Row</th>
                <th>Email</th>
                <th>Dates</th>
                <th>Type</th>
                <th className="num">Fraction</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {oooEntries.map((e) => (
                <tr key={e!.id}>
                  <td>{e!.row}</td>
                  <td>{e!.email === '*' ? 'everyone' : e!.email}</td>
                  <td>{formatRange(e!.start, e!.end)}</td>
                  <td>{e!.type}</td>
                  <td className="num">{e!.fraction}</td>
                  <td>{e!.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {problems.length > 0 && (
        <div className="evidence-section">
          <div className="muted small">OOO problems ({state.ooo?.fileName})</div>
          <ul className="small">
            {problems.map((p) => (
              <li key={`${p.row}-${p.kind}`}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {evidence.issues.length > 0 && (
        <div className="evidence-section">
          <div className="muted small">Linear issues{highlight.size ? ' (highlighted: the one this changes)' : ''}</div>
          <IssueTable issueIds={evidence.issues.map((i) => i.issueId)} highlight={highlight} notes={Object.keys(notes).length ? notes : undefined} />
        </div>
      )}
      <div className="evidence-fresh muted small">
        Linear data {f.snapshotSource === 'demo' ? '(demo workspace) ' : ''}synced {ago(f.snapshotFetchedAt)} ({dateTime(f.snapshotFetchedAt)}) · OOO:{' '}
        {f.oooFile ? `${f.oooFile}, imported ${dateTime(f.oooUploadedAt)}` : 'none imported'}
      </div>
    </div>
  );
}
