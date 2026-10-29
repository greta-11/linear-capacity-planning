import type { ReactNode } from 'react';
import type { Bucket } from '../../../shared/calendar';
import type { Status } from '../../../shared/capacity';
import { classify } from '../../../shared/capacity';
import type { Deferral, Reassignment } from '../../../shared/reassign';
import { usePlanner } from '../context';
import { ago, dateTime, formatRange, pct, pts } from '../format';
import { VELOCITY_SOURCE_LABEL } from '../views/velocity';
import { Empty, IssueLink, IssueTable, PersonName, PRIORITY_LABEL, STATUS_ICON } from './ui';

// Recommendations for one heat map cell, read-only. Every recommendation (same-team
// reallocation, cross-team borrow, defer) is the same card: a headline naming the action, a
// tag, one meta line, before → after for only the people it changes, at most one note, and
// the evidence behind "Show evidence".

export type CellScope = { kind: 'person'; personId: string } | { kind: 'team'; teamId: string } | { kind: 'project'; teamId: string; projectKey: string };

const NO_PROJECT = 'none';

export function CellRecommendations({ scope, bucket }: { scope: CellScope; bucket: Bucket }) {
  const { model, plan, buckets } = usePlanner();
  const bi = buckets.findIndex((b) => b.id === bucket.id);
  const inBucket = <T extends { bucketIndex: number }>(list: T[]) => list.filter((x) => x.bucketIndex === bi);
  const projectOf = (issueId: string | null) => (issueId ? (model.issues.get(issueId)?.projectId ?? NO_PROJECT) : null);

  let moves: Reassignment[] = [];
  let defers: Deferral[] = [];
  let share = 0;
  if (scope.kind === 'person') {
    moves = inBucket(plan.reassignments).filter((r) => r.from === scope.personId || r.to === scope.personId);
    defers = inBucket(plan.deferrals).filter((d) => d.personId === scope.personId);
  } else if (scope.kind === 'team') {
    moves = inBucket(plan.reassignments).filter((r) => r.teamId === scope.teamId || r.toTeamId === scope.teamId);
    defers = inBucket(plan.deferrals).filter((d) => d.teamId === scope.teamId);
    share = inBucket(plan.overflow).find((o) => o.teamId === scope.teamId)?.share ?? 0;
  } else {
    moves = inBucket(plan.reassignments).filter((r) => (r.teamId === scope.teamId || r.toTeamId === scope.teamId) && projectOf(r.issueId) === scope.projectKey);
    defers = inBucket(plan.deferrals).filter((d) => d.teamId === scope.teamId && projectOf(d.issueId) === scope.projectKey);
  }

  if (bi < 0) return <Empty>This period isn't in view.</Empty>;
  if (!moves.length && !defers.length) {
    return (
      <p className="muted small" data-testid="recs-none">
        No changes suggested.
      </p>
    );
  }
  return (
    <div className="stack-tight" data-testid="cell-recs">
      {scope.kind === 'team' && share > 0.5 && (
        <p className="small" data-testid="team-share">
          {model.teamName(scope.teamId)} is still <strong>+{pts(share)} pts</strong> over this period after these moves.
        </p>
      )}
      {moves.map((r) => (
        <ReassignmentCard key={r.issueId} r={r} />
      ))}
      {defers.map((d) => (
        <DeferCard key={`${d.personId}-${d.issueId ?? 'replan'}`} d={d} />
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

/** The one card layout every recommendation uses. */
function RecCard({
  kind,
  headline,
  tag,
  tagClass,
  meta,
  rows,
  note,
  evidence,
}: {
  kind: string;
  headline: ReactNode;
  tag: string;
  tagClass?: string;
  meta?: ReactNode;
  rows: { personId: string; before: number | null; after: number | null }[];
  note?: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <article className="rec rec-card" data-testid="reassignment" data-kind={kind}>
      <div className="rec-card-head">
        <h5 className="rec-headline">{headline}</h5>
        <span className={`rec-tag ${tagClass ?? ''}`}>{tag}</span>
      </div>
      {meta && <div className="rec-meta">{meta}</div>}
      <div className="before-after" role="table" aria-label="Utilization before and after">
        <div role="row" className="ba-row ba-head">
          <span role="columnheader" />
          <span role="columnheader">Before</span>
          <span role="columnheader" aria-hidden />
          <span role="columnheader">After</span>
        </div>
        {rows.map((p) => (
          <div role="row" className="ba-row" key={p.personId} data-testid="before-after-row">
            <span role="rowheader">
              <PersonName id={p.personId} />
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
      {note && (
        <p className="rec-note muted small" data-testid="rec-note">
          {note}
        </p>
      )}
      <details className="evidence-toggle">
        <summary data-testid="evidence-toggle">Show evidence</summary>
        {evidence}
      </details>
    </article>
  );
}

const metaLine = (model: ReturnType<typeof usePlanner>['model'], issueId: string, points: number) => {
  const issue = model.issues.get(issueId)!;
  return `${issue.title} · ${pts(points)} pts · ${PRIORITY_LABEL[issue.priority] ?? 'No priority'} · ${issue.stateName}`;
};

function ReassignmentCard({ r }: { r: Reassignment }) {
  const { model } = usePlanner();
  const toName = model.people.get(r.to)?.name ?? 'Unknown';
  const borrow = r.kind === 'borrow';
  // One note at most: the borrow note wins; "both still over" moves into the evidence then.
  const note = borrow
    ? `Needs agreement from ${model.teamName(r.teamId)} and ${model.teamName(r.toTeamId)} leads.`
    : r.bothStillOver
      ? 'Both still over; a scope or timeline decision is needed too.'
      : undefined;
  return (
    <RecCard
      kind={r.kind}
      headline={
        <>
          Reassign <IssueLink id={r.issueId} /> to {toName}
        </>
      }
      tag={borrow ? '⇄ Cross-team borrow' : 'Same team'}
      tagClass={borrow ? 'rec-tag-borrow' : ''}
      meta={metaLine(model, r.issueId, r.periodPoints)}
      rows={[
        { personId: r.from, before: r.fromBefore, after: r.fromAfter },
        { personId: r.to, before: r.toBefore, after: r.toAfter },
      ]}
      note={note}
      evidence={<ReassignmentEvidence r={r} />}
    />
  );
}

function DeferCard({ d }: { d: Deferral }) {
  const { model } = usePlanner();
  const replan = d.kind === 'replan';
  return (
    <RecCard
      kind={d.kind}
      headline={
        replan ? (
          <>Re-plan in-progress work for {model.people.get(d.personId)?.name}</>
        ) : (
          <>
            Defer <IssueLink id={d.issueId!} /> to a later cycle
          </>
        )
      }
      tag="⚑ Scope or timeline"
      tagClass="rec-tag-scope"
      meta={replan ? undefined : metaLine(model, d.issueId!, d.periodPoints)}
      rows={[{ personId: d.personId, before: d.before, after: d.after }]}
      note={!replan && d.stillOverBy > 0.05 ? `Still +${pts(d.stillOverBy)} pts over after this.` : undefined}
      evidence={<DeferEvidence d={d} />}
    />
  );
}

function Trigger({ personId, window, trigger }: { personId: string; window: { start: string; end: string }; trigger: { load: number; plannable: number } }) {
  return (
    <div className="evidence-metric">
      <div className="muted small">Trigger</div>
      <div>
        <strong>
          <PersonName id={personId} />
        </strong>{' '}
        in {formatRange(window.start, window.end)}: {pts(trigger.load)} pts remaining load vs {pts(trigger.plannable)} pts plannable ={' '}
        {pct(trigger.plannable > 0 ? trigger.load / trigger.plannable : null)} <span className="muted">· over above 100%</span>
      </div>
    </div>
  );
}

function Inputs({ ids, window }: { ids: string[]; window: { start: string; end: string } }) {
  const { model } = usePlanner();
  return (
    <div className="evidence-section">
      <div className="muted small">Inputs ({formatRange(window.start, window.end)})</div>
      <dl className="facts">
        {ids.map((id) => {
          const w = model.personWindow(id, window.start, window.end);
          const v = model.velocity.get(id)!;
          const perWeek = v.value * model.input.planner.settings.workDays.length;
          return (
            <div key={id} className="fact">
              <dt>
                <PersonName id={id} />
              </dt>
              <dd>
                {pts(perWeek)} pts/wk ({v.source === 'history' ? `own history, ${v.completedIssues} completed issues` : VELOCITY_SOURCE_LABEL[v.source]}) · {w.workingDays} working days ·{' '}
                {pts(w.oooDays)} OOO days · {pct(w.buffer)} buffer → {pts(w.plannable)} pts plannable, {pts(w.load)} pts load now
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function SourceRows({ issueIds, people, window }: { issueIds: string[]; people: string[]; window: { start: string; end: string } }) {
  const { model, state } = usePlanner();
  const oooRows = people
    .flatMap((id) => model.personWindow(id, window.start, window.end).oooEntries.map((x) => model.oooEntries.get(x.entryId)!))
    .filter((x, i, all) => x && all.indexOf(x) === i);
  const points = Object.fromEntries(issueIds.map((id) => [id, model.spreadOf(id)?.points ?? 0]));
  return (
    <div className="evidence-section">
      <div className="muted small">Source rows</div>
      {issueIds.length > 0 && <IssueTable issueIds={issueIds} points={points} showState />}
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
  );
}

function Freshness() {
  const { state } = usePlanner();
  return (
    <div className="evidence-fresh muted small">
      Linear synced {ago(state.snapshot?.fetchedAt)} ({dateTime(state.snapshot?.fetchedAt)}) · OOO {state.ooo ? `${state.ooo.fileName}, loaded ${ago(state.ooo.uploadedAt)}` : 'none imported'}
    </div>
  );
}

function ReassignmentEvidence({ r }: { r: Reassignment }) {
  const e = r.evidence;
  return (
    <div className="evidence" data-testid="evidence">
      <Trigger personId={r.from} window={e.window} trigger={e.trigger} />
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
        <div className="muted small">Why this issue and this person</div>
        <ul>
          <li>{e.whyIssue}</li>
          <li>{e.whyRecipient}</li>
          {r.kind === 'borrow' && r.bothStillOver && <li>Both are still over after this move; a scope or timeline decision is needed too.</li>}
        </ul>
      </div>
      <Inputs ids={[r.from, r.to]} window={e.window} />
      <SourceRows issueIds={[r.issueId]} people={[r.from, r.to]} window={e.window} />
      <Freshness />
    </div>
  );
}

function DeferEvidence({ d }: { d: Deferral }) {
  const { model } = usePlanner();
  const e = d.evidence;
  const total = e.projects.reduce((a, p) => a + p.points, 0);
  return (
    <div className="evidence" data-testid="evidence">
      <Trigger personId={d.personId} window={e.window} trigger={e.trigger} />
      <div className="evidence-section">
        <div className="muted small">Why this {d.kind === 'replan' ? 'suggestion' : 'issue'}</div>
        <ul>
          <li>{e.whyIssue}</li>
          {d.kind === 'defer' && (
            <li>
              Frees {pts(d.periodPoints)} pts this period
              {e.later.length ? `, plus ${e.later.map((x) => `${pts(x.points)} pts in ${x.label}`).join(', ')}` : ''}.
            </li>
          )}
        </ul>
      </div>
      <div className="evidence-section">
        <div className="muted small">{model.teamName(d.teamId)} this period</div>
        <ul>
          {e.projects.length > 0 && (
            <li>
              Driving the load:{' '}
              {e.projects
                .slice(0, 4)
                .map((p) => `${p.projectId ? model.projects.get(p.projectId)?.name : 'No project'} ${pts(p.points)} pts (${pct(total ? p.points / total : 0)})`)
                .join(' · ')}
            </li>
          )}
          {e.othersOver.length > 0 && <li>Also still over: {e.othersOver.join(', ')}</li>}
        </ul>
      </div>
      <Inputs ids={[d.personId]} window={e.window} />
      <SourceRows issueIds={d.issueId ? [d.issueId] : e.startedIssueIds} people={[d.personId]} window={e.window} />
      <Freshness />
    </div>
  );
}
