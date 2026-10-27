import { useMemo } from 'react';
import { planReassignments, type Overflow, type Reassignment, type Unresolved } from '../../../shared/reassign';
import { Empty, IssueLink, IssueTable, Kpi, PersonName } from '../components/ui';
import { usePlanner } from '../context';
import { formatRange, pct, pts } from '../format';
import { velocityLabel } from './velocity';

// Read-only guidance. Reassignments are suggestions to make in Linear; overflow is what
// no reassignment can fix and needs a scope or timeline decision.

export function Recommendations() {
  const { model, buckets, filters, setFilters, state } = usePlanner();
  const plan = useMemo(() => planReassignments(model, buckets), [model, buckets]);
  const teamId = filters.recs.teamId;
  const inTeam = <T extends { teamId: string }>(list: T[]) => list.filter((x) => !teamId || x.teamId === teamId);
  const reassignments = inTeam(plan.reassignments);
  const unresolved = inTeam(plan.unresolved);
  const overflow = inTeam(plan.overflow);
  const h = filters.heatmap;
  const teamOver = overflow.filter((o) => o.teamOverBy > 0.05);

  return (
    <div className="stack">
      <div className="filters filters-inline">
        <label className="field">
          <span>Team</span>
          <select value={teamId ?? ''} onChange={(e) => setFilters({ recs: { teamId: e.target.value || null } })} data-testid="recs-team">
            <option value="">All teams</option>
            {state.snapshot!.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <span className="hint" data-testid="recs-settings">
          Periods: {h.size} {h.unit}
          {h.size === 1 ? '' : 's'} × {h.count} · buffer {pct(filters.bufferPct)} · {velocityLabel(filters.velocity)} velocity ·{' '}
          <button className="link-button link" onClick={() => setFilters({ view: 'heatmap' })}>
            change in Capacity heat map
          </button>
        </span>
      </div>
      <p className="lede">
        Suggestions only: make the changes directly in Linear. Reassignments move not-started work from someone over their plannable capacity to a teammate with headroom. Each one stays on the same team,
        keeps the teammate within their limit for the issue's cycle and this period, and doesn't overload them next period. Whatever is still over afterwards is listed under Remaining overflow.
      </p>
      <div className="kpis">
        <Kpi label="Suggested reassignments" value={reassignments.length} sub={`${pts(reassignments.reduce((a, r) => a + r.periodPoints, 0))} pts moved`} />
        <Kpi label="People still over" value={new Set(unresolved.map((u) => u.personId)).size} tone={unresolved.length ? 'warn' : 'good'} sub="after reassignment" />
        <Kpi label="Team periods over capacity" value={teamOver.length} tone={teamOver.length ? 'bad' : 'good'} sub="need a scope or timeline decision" />
      </div>

      <section className="card" data-testid="reassignments">
        <h2>Reassignments</h2>
        {!buckets.length ? (
          <Empty>No periods in view.</Empty>
        ) : (
          buckets.map((bucket, bi) => {
            const moves = reassignments.filter((r) => r.bucketIndex === bi);
            const stuck = unresolved.filter((u) => u.bucketIndex === bi);
            if (!moves.length && !stuck.length) return null;
            return (
              <div key={bucket.id} className="rec-period">
                <h3>
                  {bucket.label} <span className="muted small">{formatRange(bucket.start, bucket.end)}</span>
                </h3>
                {moves.map((r) => (
                  <ReassignmentCard key={r.issueId} r={r} />
                ))}
                {stuck.length > 0 && <StillOver list={stuck} />}
              </div>
            );
          })
        )}
        {!reassignments.length && !unresolved.length && <Empty>Nobody is over plannable capacity in these periods.</Empty>}
      </section>

      <section className="card" data-testid="overflow">
        <h2>Remaining overflow</h2>
        <p className="muted small">What is still over plannable capacity after every reassignment above. These are flags, not recommendations: they need a scope or timeline decision.</p>
        {overflow.length ? (
          overflow.map((o) => <OverflowCard key={`${o.teamId}-${o.bucketIndex}`} o={o} />)
        ) : (
          <Empty>Nothing left over capacity after reassignment.</Empty>
        )}
      </section>
    </div>
  );
}

function ReassignmentCard({ r }: { r: Reassignment }) {
  const { model } = usePlanner();
  const issue = model.issues.get(r.issueId)!;
  return (
    <article className="rec rec-move" data-testid="reassignment">
      <div className="rec-move-head">
        <IssueLink id={r.issueId} /> <span className="rec-title-inline">{issue.title}</span>
      </div>
      <div className="rec-move-line">
        <span className="move-from">
          <PersonName id={r.from} />
        </span>
        <span aria-hidden>→</span>
        <span className="move-to">
          <PersonName id={r.to} />
        </span>
        <span className="chip">{pts(r.periodPoints)} pts this period</span>
        {r.remainingPoints - r.periodPoints > 0.05 && <span className="chip">{pts(r.remainingPoints)} pts remaining in total</span>}
        <span className="chip">{model.teamName(r.teamId)}</span>
      </div>
      <p className="rec-rationale">{r.rationale}</p>
      <p className="muted small">Make this change in Linear: reassign {issue.identifier}.</p>
    </article>
  );
}

/** People still over plannable capacity this period after the moves above, with why. */
function StillOver({ list }: { list: Unresolved[] }) {
  const { model } = usePlanner();
  return (
    <div className="rec rec-stuck" data-testid="unresolved">
      <div className="rec-move-head">
        <strong>Still over capacity after reassignment</strong> <span className="muted">· details under Remaining overflow</span>
      </div>
      <ul className="stuck-list">
        {list.map((u) => (
          <li key={u.personId}>
            <strong>
              <PersonName id={u.personId} />
            </strong>{' '}
            over by {pts(u.overBy)} pts ({model.teamName(u.teamId)}): {u.reason}.
          </li>
        ))}
      </ul>
    </div>
  );
}

function OverflowCard({ o }: { o: Overflow }) {
  const { model, buckets } = usePlanner();
  const bucket = buckets[o.bucketIndex];
  const teamOver = o.teamOverBy > 0.05;
  const total = o.projects.reduce((a, p) => a + p.points, 0);
  return (
    <article className={`overflow ${teamOver ? 'overflow-team' : 'overflow-people'}`} data-testid="overflow-card">
      <div className="overflow-head">
        <span className={`pill ${teamOver ? 'pill-over' : 'pill-at-risk'}`}>{teamOver ? `+${pts(o.teamOverBy)} pts` : 'people over'}</span>
        <strong>{o.label}</strong>
      </div>
      <div className="grid-2 small">
        <div>
          <div className="muted">
            {model.teamName(o.teamId)} · {bucket.label}: {pts(o.teamLoad)} pts planned ÷ {pts(o.teamPlannable)} pts plannable ({pct(o.teamPlannable > 0 ? o.teamLoad / o.teamPlannable : null)})
          </div>
          {o.peopleOver.length > 0 && (
            <ul className="plain">
              {o.peopleOver.map((p) => (
                <li key={p.personId}>
                  <PersonName id={p.personId} /> over by {pts(p.overBy)} pts
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="muted">Projects driving the load</div>
          <ul className="plain" data-testid="overflow-projects">
            {o.projects.slice(0, 5).map((p) => (
              <li key={p.projectId ?? 'none'}>
                {p.projectId ? model.projects.get(p.projectId)?.name : 'No project'}: {pts(p.points)} pts ({pct(total ? p.points / total : 0)})
              </li>
            ))}
          </ul>
        </div>
      </div>
      <details className="issues-details">
        <summary>{o.issueIds.length} issues involved</summary>
        <IssueTable issueIds={o.issueIds} showState={false} />
      </details>
    </article>
  );
}
