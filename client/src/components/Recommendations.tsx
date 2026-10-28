import type { Bucket } from '../../../shared/calendar';
import type { Overflow, Reassignment, Unresolved } from '../../../shared/reassign';
import { usePlanner } from '../context';
import { ago, dateTime, formatRange, pct, pts } from '../format';
import { VELOCITY_SOURCE_LABEL } from '../views/velocity';
import { Empty, IssueLink, IssueTable, PersonName } from './ui';

// Recommendations for one heat map cell, read-only: reassignments to make in Linear, people
// still over capacity and why, and the team's remaining overflow. Each reassignment keeps
// its evidence: the trigger, every constraint it passed, the inputs and the source rows.

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
    moves = inBucket(plan.reassignments).filter((r) => r.teamId === scope.teamId);
    stuck = inBucket(plan.unresolved).filter((u) => model.teams.get(scope.teamId)?.memberIds.includes(u.personId));
    overflow = inBucket(plan.overflow).filter((o) => o.teamId === scope.teamId);
  } else {
    moves = inBucket(plan.reassignments).filter((r) => r.teamId === scope.teamId && projectOf(r.issueId) === scope.projectKey);
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
        <div className="muted small">Constraints checked</div>
        <ul className="checks" data-testid="evidence-checks">
          {e.checks.map((c) => (
            <li key={c.label}>
              <span className="check-ok" aria-hidden>
                ✓
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
function StillOver({ list }: { list: Unresolved[] }) {
  const { model } = usePlanner();
  return (
    <div className="rec rec-stuck" data-testid="unresolved">
      <div className="rec-move-head">
        <strong>Still over capacity after reassignment</strong>
      </div>
      <ul className="stuck-list">
        {list.map((u) => (
          <li key={u.personId}>
            <strong>
              <PersonName id={u.personId} />
            </strong>{' '}
            over by {pts(u.overBy)} pts ({model.teamName(u.teamId)}): {u.reason}.
            {u.teammates.length > 0 && (
              <div className="muted small">
                Teammates' headroom {formatRange(u.window.start, u.window.end)}:{' '}
                {u.teammates
                  .sort((a, b) => b.headroom - a.headroom)
                  .slice(0, 6)
                  .map((t) => `${model.people.get(t.personId)?.displayName ?? '?'} ${t.headroom >= 0 ? '+' : ''}${pts(t.headroom)}`)
                  .join(' · ')}{' '}
                pts
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
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
            {model.teamName(o.teamId)} · {formatRange(o.window.start, o.window.end)}: {pts(o.teamLoad)} pts planned ÷ {pts(o.teamPlannable)} pts plannable (
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
