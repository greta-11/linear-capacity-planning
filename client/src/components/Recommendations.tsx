import type { Bucket } from '../../../shared/calendar';
import type { Status } from '../../../shared/capacity';
import { classify } from '../../../shared/capacity';
import type { Overflow, Reassignment, Unresolved } from '../../../shared/reassign';
import { usePlanner } from '../context';
import { ago, dateTime, formatRange, pct, pts } from '../format';
import { VELOCITY_SOURCE_LABEL } from '../views/velocity';
import { Empty, IssueLink, IssueTable, PersonName, PRIORITY_LABEL, STATUS_ICON } from './ui';

// Recommendations for one heat map cell, read-only: reassignments and cross-team borrows to
// make in Linear, people still over capacity, and the team's remaining overflow. Each card
// says exactly what to do and shows the two people's utilization before and after; the
// evidence (trigger, checks, inputs, source rows) sits behind "Show evidence".

export type CellScope = { kind: 'person'; personId: string } | { kind: 'team'; teamId: string } | { kind: 'project'; teamId: string; projectKey: string };

const NO_PROJECT = 'none';

export function CellRecommendations({ scope, bucket }: { scope: CellScope; bucket: Bucket }) {
  const { model, plan, buckets } = usePlanner();
  const bi = buckets.findIndex((b) => b.id === bucket.id);
  const inBucket = <T extends { bucketIndex: number }>(list: T[]) => list.filter((x) => x.bucketIndex === bi);
  const projectOf = (issueId: string) => model.issues.get(issueId)?.projectId ?? NO_PROJECT;

  let moves: Reassignment[] = [];
  let stuck: Unresolved[] = [];
  let overflow: Overflow[] = [];
  if (scope.kind === 'person') {
    moves = inBucket(plan.reassignments).filter((r) => r.from === scope.personId || r.to === scope.personId);
    stuck = inBucket(plan.unresolved).filter((u) => u.personId === scope.personId);
    const teams = new Set(model.people.get(scope.personId)?.teamIds ?? []);
    overflow = stuck.length ? inBucket(plan.overflow).filter((o) => teams.has(o.teamId) && o.peopleOver.some((p) => p.personId === scope.personId)) : [];
  } else if (scope.kind === 'team') {
    moves = inBucket(plan.reassignments).filter((r) => r.teamId === scope.teamId || r.toTeamId === scope.teamId);
    stuck = inBucket(plan.unresolved).filter((u) => model.teams.get(scope.teamId)?.memberIds.includes(u.personId));
    overflow = inBucket(plan.overflow).filter((o) => o.teamId === scope.teamId);
  } else {
    moves = inBucket(plan.reassignments).filter((r) => (r.teamId === scope.teamId || r.toTeamId === scope.teamId) && projectOf(r.issueId) === scope.projectKey);
    overflow = inBucket(plan.overflow).filter(
      (o) => o.teamId === scope.teamId && o.projects.some((p) => (p.projectId ?? NO_PROJECT) === scope.projectKey && p.points > 0.05),
    );
  }

  if (bi < 0) return <Empty>This period isn't in view.</Empty>;
  if (!moves.length && !stuck.length && !overflow.length) {
    return (
      <p className="muted small" data-testid="recs-none">
        No changes suggested: {scope.kind === 'person' ? 'this person is' : 'everyone here is'} within plannable capacity for the rest of this period, or nothing they own needs to move.
      </p>
    );
  }
  return (
    <div className="stack-tight" data-testid="cell-recs">
      <p className="muted small">Suggestions only: make the changes directly in Linear. Periods that started in the past are judged on their remaining days.</p>
      {moves.map((r) => (
        <ReassignmentCard key={r.issueId} r={r} />
      ))}
      {stuck.length > 0 && <StillOver list={stuck} />}
      {overflow.map((o) => (
        <OverflowCard key={`${o.teamId}-${o.bucketIndex}`} o={o} />
      ))}
    </div>
  );
}

/** A utilization pill; "OOO" when the person has no capacity in the window. */
function UtilPill({ u }: { u: number | null }) {
  const { model } = usePlanner();
  if (u == null) return <span className="pill pill-over">OOO</span>;
  const status: Status = classify(u, 1, model.input.planner.settings).status;
  return (
    <span className={`pill pill-${status}`}>
      {status === 'over' || status === 'at-risk' ? `${STATUS_ICON[status]} ` : ''}
      {pct(u)}
    </span>
  );
}

function ReassignmentCard({ r }: { r: Reassignment }) {
  const { model } = usePlanner();
  const issue = model.issues.get(r.issueId)!;
  const toName = model.people.get(r.to)?.name ?? 'Unknown';
  return (
    <article className="rec rec-move rec-card" data-testid="reassignment" data-kind={r.kind}>
      <div className="rec-card-head">
        <h5 className="rec-headline">
          Reassign <IssueLink id={r.issueId} /> to {toName}
        </h5>
        <span className={`rec-tag ${r.kind === 'borrow' ? 'rec-tag-borrow' : ''}`}>{r.kind === 'borrow' ? '⇄ Cross-team borrow' : 'Same team'}</span>
      </div>
      <div className="rec-meta">
        {issue.title} · {pts(r.periodPoints)} pts this period · {PRIORITY_LABEL[issue.priority] ?? 'No priority'} · {issue.stateName}
      </div>
      <div className="before-after" role="table" aria-label="Utilization before and after">
        <div role="row" className="ba-row ba-head">
          <span role="columnheader" />
          <span role="columnheader">Before</span>
          <span role="columnheader" aria-hidden />
          <span role="columnheader">After</span>
        </div>
        {[
          { id: r.from, before: r.fromBefore, after: r.fromAfter },
          { id: r.to, before: r.toBefore, after: r.toAfter },
        ].map((p) => (
          <div role="row" className="ba-row" key={p.id} data-testid="before-after-row">
            <span role="rowheader">
              <PersonName id={p.id} />
            </span>
            <span role="cell">
              <UtilPill u={p.before} />
            </span>
            <span role="cell" aria-hidden>
              →
            </span>
            <span role="cell">
              <UtilPill u={p.after} />
            </span>
          </div>
        ))}
      </div>
      {r.kind === 'borrow' && (
        <p className="muted small">
          Needs agreement from both leads ({model.teamName(r.teamId)} and {model.teamName(r.toTeamId)}).
        </p>
      )}
      {r.bothStillOver && <p className="rec-both-over small">Spreads the load; both are still over, so a scope or timeline decision is needed too.</p>}
      <details className="evidence-toggle">
        <summary data-testid="evidence-toggle">Show evidence</summary>
        <ReassignmentEvidence r={r} />
      </details>
    </article>
  );
}

function ReassignmentEvidence({ r }: { r: Reassignment }) {
  const { model, state } = usePlanner();
  const e = r.evidence;
  const people = [r.from, r.to].map((id) => {
    const w = model.personWindow(id, e.window.start, e.window.end);
    const v = model.velocity.get(id)!;
    return { id, w, v, perWeek: v.value * model.input.planner.settings.workDays.length };
  });
  const oooRows = people.flatMap((p) => p.w.oooEntries.map((x) => model.oooEntries.get(x.entryId)!)).filter((x, i, all) => x && all.indexOf(x) === i);
  const spread = model.spreadOf(r.issueId);
  return (
    <div className="evidence" data-testid="evidence">
      <div className="evidence-metric">
        <div className="muted small">Trigger</div>
        <div>
          <strong>
            <PersonName id={r.from} />
          </strong>{' '}
          in {formatRange(e.window.start, e.window.end)}: {pts(e.trigger.load)} pts remaining load vs {pts(e.trigger.plannable)} pts plannable ={' '}
          {pct(e.trigger.plannable > 0 ? e.trigger.load / e.trigger.plannable : null)} <span className="muted">· over above 100%</span>
        </div>
      </div>
      <div className="evidence-section">
        <div className="muted small">Checks</div>
        <ul className="checks" data-testid="evidence-checks">
          {e.checks.map((c) => (
            <li key={c.label}>
              <span className={c.ok ? 'check-ok' : 'check-no'} aria-label={c.ok ? 'passed' : 'not met'}>
                {c.ok ? '✓' : '–'}
              </span>{' '}
              <strong>{c.label}:</strong> {c.detail}
            </li>
          ))}
        </ul>
      </div>
      <div className="evidence-section">
        <div className="muted small">Why this issue and this teammate</div>
        <ul>
          <li>{e.whyIssue}</li>
          <li>{e.whyRecipient}</li>
        </ul>
      </div>
      <div className="evidence-section">
        <div className="muted small">Inputs ({formatRange(e.window.start, e.window.end)})</div>
        <dl className="facts">
          {people.map((p) => (
            <div key={p.id} className="fact">
              <dt>
                <PersonName id={p.id} />
              </dt>
              <dd>
                {pts(p.perWeek)} pts/wk ({p.v.source === 'history' ? `own history, ${p.v.completedIssues} completed issues` : VELOCITY_SOURCE_LABEL[p.v.source]}) · {p.w.workingDays} working days ·{' '}
                {pts(p.w.oooDays)} OOO days · {pct(p.w.buffer)} buffer → {pts(p.w.plannable)} pts plannable, {pts(p.w.load)} pts load now
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="evidence-section">
        <div className="muted small">Source rows</div>
        <IssueTable issueIds={[r.issueId]} points={{ [r.issueId]: spread?.points ?? r.remainingPoints }} showState />
        {oooRows.length > 0 && (
          <table className="table table-compact">
            <caption className="muted small">OOO rows ({state.ooo?.fileName})</caption>
            <thead>
              <tr>
                <th>Row</th>
                <th>Email</th>
                <th>Dates</th>
                <th>Type</th>
                <th className="num">Fraction</th>
              </tr>
            </thead>
            <tbody>
              {oooRows.map((o) => (
                <tr key={o.id}>
                  <td>{o.row}</td>
                  <td>{o.email === '*' ? 'everyone' : o.email}</td>
                  <td>{formatRange(o.start, o.end)}</td>
                  <td>{o.type}</td>
                  <td className="num">{o.fraction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="evidence-fresh muted small">
        Linear synced {ago(state.snapshot?.fetchedAt)} ({dateTime(state.snapshot?.fetchedAt)}) · OOO {state.ooo ? `${state.ooo.fileName}, loaded ${ago(state.ooo.uploadedAt)}` : 'none imported'}
      </div>
    </div>
  );
}

/** People still over plannable capacity after the moves, with why and their teammates' headroom. */
/** People still over plannable capacity after the moves: one line. */
function StillOver({ list }: { list: Unresolved[] }) {
  return (
    <p className="rec-still-over small" data-testid="unresolved">
      <strong>Still over after these moves:</strong>{' '}
      {list.map((u, i) => (
        <span key={u.personId} title={u.reason}>
          {i > 0 && ', '}
          <PersonName id={u.personId} /> +{pts(u.overBy)} pts
        </span>
      ))}
      . Needs a scope or timeline decision.
    </p>
  );
}

function OverflowCard({ o }: { o: Overflow }) {
  const { model } = usePlanner();
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
            {model.teamName(o.teamId)} · {formatRange(o.window.start, o.window.end)}: its people carry {pts(o.teamLoad)} pts ÷ {pts(o.teamPlannable)} pts plannable (
            {pct(o.teamPlannable > 0 ? o.teamLoad / o.teamPlannable : null)})
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
