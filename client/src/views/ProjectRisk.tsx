import { Fragment, useMemo, useState } from 'react';
import { PRESSURE_SPAN, PRESSURE_START, summarizeProjects, type ProjectRisk as Risk, type RiskLevel } from '../../../shared/projects';
import type { VelocityMode } from '../../../shared/types';
import { Empty, IssueTable, Kpi, PersonName, StatusPill } from '../components/ui';
import { usePlanner } from '../context';
import { days, formatShort, pct, pts } from '../format';

const LEVEL_LABEL: Record<RiskLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const LEVEL_ICON: Record<RiskLevel, string> = { high: '▲', medium: '!', low: '✓' };
const HEALTH_LABEL: Record<string, string> = { onTrack: 'On track', atRisk: 'At risk', offTrack: 'Off track' };

export function velocityLabel(v: VelocityMode): string {
  return v.kind === 'history' ? 'historical (per person)' : v.kind === 'team-average' ? 'team average' : `${v.pointsPerWeek} pts/week for everyone`;
}

export function ProjectRisk() {
  const { model, filters, setFilters, state } = usePlanner();
  const all = useMemo(() => summarizeProjects(model), [model]);
  const { teamId, includeNoTarget } = filters.risk;
  const risks = all.filter((r) => (!teamId || r.teamIds.includes(teamId)) && (includeNoTarget || !r.noTargetDate));
  const [open, setOpen] = useState<string | null>(null);
  const count = (pred: (r: Risk) => boolean) => risks.filter(pred).length;
  const setRisk = (patch: Partial<typeof filters.risk>) => setFilters({ risk: { ...filters.risk, ...patch } });

  return (
    <div className="stack">
      <div className="filters filters-inline">
        <label className="field">
          <span>Team</span>
          <select value={teamId ?? ''} onChange={(e) => setRisk({ teamId: e.target.value || null })} data-testid="risk-team">
            <option value="">All teams</option>
            {state.snapshot!.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check small">
          <input type="checkbox" checked={includeNoTarget} onChange={(e) => setRisk({ includeNoTarget: e.target.checked })} /> Include projects without a target date
        </label>
        <span className="hint">
          Capacity uses {velocityLabel(filters.velocity)} velocity ·{' '}
          <button className="link-button link" onClick={() => setFilters({ view: 'heatmap' })}>
            change
          </button>
        </span>
      </div>
      <p className="lede">
        Which projects are at risk of missing their target date? The score combines how overloaded the people doing the work are through the target date (all their work, OOO included) with how much of
        the project is scheduled late, unassigned or unestimated.
      </p>
      <div className="kpis">
        <Kpi label="High risk" value={count((r) => r.level === 'high')} tone={count((r) => r.level === 'high') ? 'bad' : 'good'} />
        <Kpi label="Medium risk" value={count((r) => r.level === 'medium')} tone={count((r) => r.level === 'medium') ? 'warn' : 'good'} />
        <Kpi label="Overdue" value={count((r) => r.overdue)} tone={count((r) => r.overdue) ? 'bad' : 'good'} />
        <Kpi label="No target date" value={count((r) => r.noTargetDate)} sub="scored over the next 12 weeks" />
        <Kpi label="Open projects" value={risks.length} />
      </div>
      {!risks.length ? (
        <Empty>No open projects match these filters.</Empty>
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table className="table risk-table" data-testid="risk-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Risk</th>
                  <th>Target date</th>
                  <th className="num">Teams</th>
                  <th className="num">People</th>
                  <th className="num">Remaining</th>
                  <th className="num">Progress</th>
                  <th>Linear health</th>
                  <th>Top drivers</th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <Fragment key={r.project.id}>
                    <tr className={`clickable ${open === r.project.id ? 'row-open' : ''}`} onClick={() => setOpen(open === r.project.id ? null : r.project.id)} data-testid="risk-row">
                      <td>
                        <button className="link-button" aria-expanded={open === r.project.id}>
                          {open === r.project.id ? '▾' : '▸'} <strong>{r.project.name}</strong>
                        </button>
                        <div className="muted small">{r.project.statusName}</div>
                      </td>
                      <td>
                        <RiskScore r={r} />
                      </td>
                      <td>
                        {r.project.targetDate ? (
                          <>
                            {formatShort(r.project.targetDate)} {r.project.targetDate.slice(0, 4)}
                            <div className={`small ${r.overdue ? 'error' : 'muted'}`}>{r.overdue ? `${-r.daysLeft!} days overdue` : `${r.daysLeft} days left`}</div>
                          </>
                        ) : (
                          <span className="muted">None</span>
                        )}
                      </td>
                      <td className="num" data-testid="risk-teams">
                        {r.teamIds.length}
                      </td>
                      <td className="num" data-testid="risk-people">
                        {r.people.length}
                      </td>
                      <td className="num">
                        {pts(r.remainingPoints)} pts
                        <div className="muted small">{r.openIssueIds.length} issues</div>
                      </td>
                      <td className="num">{pct(r.project.progress)}</td>
                      <td>{r.project.health ? <span className={`health health-${r.project.health}`}>{HEALTH_LABEL[r.project.health]}</span> : <span className="muted">No update</span>}</td>
                      <td className="why">
                        <ul>
                          {r.drivers.slice(0, 3).map((d) => (
                            <li key={d}>{d}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                    {open === r.project.id && (
                      <tr className="row-detail">
                        <td colSpan={9}>
                          <RiskDetail r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function RiskScore({ r }: { r: Risk }) {
  return (
    <div className="risk-score" data-testid="risk-score" data-level={r.level}>
      <span className={`pill pill-risk-${r.level}`}>
        <span aria-hidden className="pill-icon">
          {LEVEL_ICON[r.level]}
        </span>
        {LEVEL_LABEL[r.level]}
      </span>
      <span className="risk-track" aria-hidden>
        <span className={`risk-fill risk-fill-${r.level}`} style={{ width: `${r.score}%` }} />
      </span>
      <span className="num risk-number">{r.score}</span>
    </div>
  );
}

function RiskDetail({ r }: { r: Risk }) {
  const { model, filters, setFilters } = usePlanner();
  const late = new Set(r.lateIssueIds);
  const notes = Object.fromEntries(r.lateIssueIds.map((id) => [id, 'scheduled after target']));
  const openInHeatmap = () =>
    setFilters({ view: 'heatmap', heatmap: { ...filters.heatmap, projects: [r.project.id], teams: [], people: [] } });
  return (
    <div className="risk-detail" data-testid="risk-detail">
      <div className="row">
        <button className="btn btn-primary btn-small" onClick={openInHeatmap} data-testid="open-heatmap">
          Open in heat map
        </button>
        <a className="btn btn-small" href={r.project.url} target="_blank" rel="noreferrer">
          Open in Linear
        </a>
        <span className="muted small">
          Measured from today through {formatShort(r.windowEnd)} ({r.workingDaysLeft} working days){r.noTargetDate ? ' — no target date, so the next 12 weeks' : ''}.
        </span>
      </div>
      <div className="grid-2">
        <div>
          <h4>Score: {r.score} = Σ weight × factor</h4>
          <table className="table table-compact" data-testid="risk-factors">
            <thead>
              <tr>
                <th>Factor</th>
                <th className="num">Value</th>
                <th className="num">Weight</th>
                <th className="num">Points</th>
              </tr>
            </thead>
            <tbody>
              {r.factors.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    <div className="muted small">{f.detail}</div>
                  </td>
                  <td className="num">{pct(f.value)}</td>
                  <td className="num">× {pct(f.weight)}</td>
                  <td className="num">
                    <strong>{Math.round(f.contribution)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.overdue && <p className="small error">The target date has passed with open work, so the score is 100.</p>}
          <p className="muted small">
            Capacity pressure per person = (utilization − {pct(PRESSURE_START)}) ÷ {pct(PRESSURE_SPAN)}, capped to 0–100%, then weighted by each person's share of the project's points. High ≥ 50,
            medium ≥ 25.
          </p>
          <h4>Teams ({r.teamIds.length})</h4>
          <div className="chips">
            {r.teamIds.map((t) => (
              <span className="chip" key={t}>
                {model.teamName(t)}
              </span>
            ))}
          </div>
        </div>
        <div>
          <h4>People ({r.people.length}) through {formatShort(r.windowEnd)}</h4>
          <div className="table-wrap">
            <table className="table table-compact" data-testid="risk-people-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">This project</th>
                  <th className="num">All load</th>
                  <th className="num">Capacity</th>
                  <th className="num">OOO</th>
                  <th>Utilization</th>
                </tr>
              </thead>
              <tbody>
                {r.people.map((p) => (
                  <tr key={p.personId}>
                    <td>
                      <PersonName id={p.personId} />
                    </td>
                    <td className="num">{pts(p.projectPoints)}</td>
                    <td className="num">{pts(p.load)}</td>
                    <td className="num">{pts(p.capacity)}</td>
                    <td className="num">{p.oooDays ? days(p.oooDays) : '—'}</td>
                    <td>
                      <StatusPill status={p.status} utilization={p.utilization} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.unassignedPoints > 0 && <p className="small warn-text">{pts(r.unassignedPoints)} pts are unassigned and not counted against anyone's capacity.</p>}
        </div>
      </div>
      <h4>Open issues ({r.openIssueIds.length})</h4>
      <IssueTable issueIds={r.openIssueIds} highlight={late} notes={notes} showProject={false} />
    </div>
  );
}
