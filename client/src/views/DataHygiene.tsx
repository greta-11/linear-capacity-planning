import { useMemo, useState } from 'react';
import { HYGIENE_FLAGS, HYGIENE_INFO, type HygieneFlag } from '../../../shared/hygiene';
import { CycleLabel, Empty, IssueLink, PersonName, PRIORITY_LABEL } from '../components/ui';
import { usePlanner } from '../context';

// Issues missing a date, an estimate or a project. The fix happens in Linear; this tab
// only lists them and links to each one.

export function DataHygiene() {
  const { hygiene, model } = usePlanner();
  const [flag, setFlag] = useState<HygieneFlag | 'all'>('all');
  const [teamId, setTeamId] = useState<string>('');
  const issues = useMemo(
    () => hygiene.issues.filter((i) => (flag === 'all' || i.flags.includes(flag)) && (!teamId || i.teamId === teamId)),
    [hygiene, flag, teamId],
  );

  return (
    <div className="stack">
      <div className="hygiene-cards">
        {HYGIENE_FLAGS.map((f) => (
          <button key={f} className={`hygiene-card ${flag === f ? 'hygiene-card-active' : ''}`} onClick={() => setFlag(flag === f ? 'all' : f)} aria-pressed={flag === f} data-testid={`hygiene-${f}`}>
            <div className="hygiene-count">{hygiene.counts[f]}</div>
            <div className="hygiene-label">{HYGIENE_INFO[f].label}</div>
          </button>
        ))}
      </div>

      <section className="card">
        <h2>By team</h2>
        <div className="table-wrap">
          <table className="table table-compact" data-testid="hygiene-teams">
            <thead>
              <tr>
                <th>Team</th>
                <th className="num">Open issues</th>
                {HYGIENE_FLAGS.map((f) => (
                  <th key={f} className="num">
                    {HYGIENE_INFO[f].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hygiene.byTeam.map((t) => (
                <tr key={t.teamId} className="clickable" onClick={() => setTeamId(teamId === t.teamId ? '' : t.teamId)}>
                  <td>
                    {model.teamName(t.teamId)} {teamId === t.teamId && <span className="chip">filtered</span>}
                  </td>
                  <td className="num">{t.checked}</td>
                  {HYGIENE_FLAGS.map((f) => (
                    <td key={f} className={`num ${t.counts[f] ? 'warn-text' : 'muted'}`}>
                      {t.counts[f]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            Issues to fix ({issues.length}){flag !== 'all' && <span className="muted"> · {HYGIENE_INFO[flag].label}</span>}
            {teamId && <span className="muted"> · {model.teamName(teamId)}</span>}
          </h2>
          {(flag !== 'all' || teamId) && (
            <button
              className="btn btn-ghost btn-small"
              onClick={() => {
                setFlag('all');
                setTeamId('');
              }}
            >
              Show all
            </button>
          )}
        </div>
        {!issues.length ? (
          <Empty>Nothing to fix here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact" data-testid="hygiene-issues">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Title</th>
                  <th>Problems</th>
                  <th>Assignee</th>
                  <th>Team</th>
                  <th>Cycle</th>
                  <th>Priority</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {issues.map((h) => {
                  const issue = model.issues.get(h.issueId)!;
                  return (
                    <tr key={h.issueId}>
                      <td>
                        <IssueLink id={h.issueId} />
                      </td>
                      <td className="truncate" title={issue.title}>
                        {issue.title}
                      </td>
                      <td>
                        <div className="chips">
                          {h.flags.map((f) => (
                            <span key={f} className="chip chip-warn">
                              {HYGIENE_INFO[f].short}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <PersonName id={issue.assigneeId} />
                      </td>
                      <td>{model.teams.get(issue.teamId)?.key}</td>
                      <td>
                        <CycleLabel id={issue.cycleId} />
                      </td>
                      <td>{PRIORITY_LABEL[issue.priority] ?? '—'}</td>
                      <td>
                        <a className="btn btn-small" href={issue.url} target="_blank" rel="noreferrer">
                          Open in Linear ↗
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
