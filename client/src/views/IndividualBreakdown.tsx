import { Fragment, useMemo, useState } from 'react';
import { summarizePeople, type PersonSummary } from '../../../shared/capacity';
import { CycleLabel, Empty, IssueTable, Kpi, StatusPill, Swatch, TipRows, TooltipProvider, useTipTarget, STATUS_ICON } from '../components/ui';
import { usePlanner } from '../context';
import { days, formatRange, formatShort, pct, pts, STATUS_LABEL } from '../format';

export function IndividualBreakdown() {
  const { model, filters } = usePlanner();
  const people = useMemo(() => summarizePeople(model, filters.teamId), [model, filters.teamId]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const counts = { over: 0, 'at-risk': 0, healthy: 0, under: 0, none: 0 };
  for (const p of people) counts[p.total.status]++;
  const weeklyOver = people.filter((p) => p.weeks.some((w) => w.window.status === 'over')).length;
  const max = Math.max(1, ...people.map((p) => Math.max(p.total.gross, p.total.load)));

  if (!people.length) return <Empty>No people in this team.</Empty>;
  return (
    <TooltipProvider>
      <div className="stack">
        <p className="lede">Who is overcommitted, when, and why. Utilization is each person's whole load (all teams) against their capacity after absences.</p>
        <div className="kpis">
          <Kpi label="Over capacity (whole range)" value={counts.over} tone={counts.over ? 'bad' : 'good'} />
          <Kpi label="At risk" value={counts['at-risk']} tone={counts['at-risk'] ? 'warn' : 'good'} />
          <Kpi label="Over in at least one week" value={weeklyOver} tone={weeklyOver ? 'warn' : 'good'} />
          <Kpi label="Healthy" value={counts.healthy} />
          <Kpi label="Under 70%" value={counts.under} sub="room to take work" />
        </div>
        <section className="card">
          <div className="card-head">
            <h2>Week by week</h2>
            <span className="muted small">Hover a cell for the breakdown; click a name for details.</span>
          </div>
          <Heatmap people={people} onPick={(id) => setExpanded(id)} />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Breakdown for {formatRange(model.from, model.to)}</h2>
            <div className="legend">
              <Swatch kind="planned" label="Planned (own team)" />
              <Swatch kind="shared" label="Shared commitments (other teams)" />
              <Swatch kind="unplanned" label="Unplanned + reserve" />
              <Swatch kind="available" label="Available capacity" />
              <Swatch kind="absence" label="Lost to absences" />
            </div>
          </div>
          <div className="table-wrap">
            <table className="table people-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Velocity</th>
                  <th className="num">Capacity</th>
                  <th className="num">Load</th>
                  <th>Utilization</th>
                  <th>Peak week</th>
                  <th className="bar-col">Load vs capacity</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <Fragment key={p.person.id}>
                    <tr className={`clickable ${expanded === p.person.id ? 'row-open' : ''}`} onClick={() => setExpanded(expanded === p.person.id ? null : p.person.id)} data-testid={`person-row-${p.person.displayName}`}>
                      <td>
                        <button className="link-button" aria-expanded={expanded === p.person.id}>
                          {expanded === p.person.id ? '▾' : '▸'} {p.person.name}
                        </button>
                        <div className="chips">
                          {p.person.teamIds.map((t) => (
                            <span key={t} className={`chip ${t === p.focusTeamId ? 'chip-focus' : ''}`}>
                              {model.teams.get(t)?.key} {p.person.teamIds.length > 1 ? pct(p.allocation.shares[t]) : ''}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="num" title={`source: ${p.velocity.source}`}>
                        {pts(p.velocity.value)}
                        <div className="muted small">{p.velocity.source === 'history' ? 'pts/day' : p.velocity.source}</div>
                      </td>
                      <td className="num">{pts(p.total.capacity)}</td>
                      <td className="num">{pts(p.total.load)}</td>
                      <td>
                        <StatusPill status={p.total.status} utilization={p.total.utilization} />
                      </td>
                      <td>
                        <PeakWeek p={p} />
                      </td>
                      <td className="bar-col">
                        <BreakdownBar p={p} max={max} />
                      </td>
                      <td className="why" data-testid="why">
                        {p.why.length ? (
                          <ul>
                            {p.why.slice(0, 3).map((w) => (
                              <li key={w}>{w}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    {expanded === p.person.id && (
                      <tr className="row-detail">
                        <td colSpan={8}>
                          <PersonDetail p={p} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </TooltipProvider>
  );
}

function PeakWeek({ p }: { p: PersonSummary }) {
  const rank = (u: number | null, load: number) => (u == null ? (load > 0 ? Infinity : -1) : u);
  const peak = p.weeks.reduce<PersonSummary['weeks'][number] | null>((best, w) => (!best || rank(w.window.utilization, w.window.load) > rank(best.window.utilization, best.window.load) ? w : best), null);
  if (!peak) return <span className="muted">—</span>;
  return (
    <div>
      <StatusPill status={peak.window.status} utilization={peak.window.utilization} />
      <div className="muted small">wk of {formatShort(peak.bucket.start)}</div>
    </div>
  );
}

function BreakdownBar({ p, max }: { p: PersonSummary; max: number }) {
  const { model } = usePlanner();
  const tip = useTipTarget();
  const b = p.breakdown;
  const w = (v: number) => `${(v / max) * 100}%`;
  const content = (
    <TipRows
      title={p.person.name}
      rows={[
        { key: 'planned', label: `planned · ${p.focusTeamId ? model.teamName(p.focusTeamId) : ''}`, value: pts(b.planned) },
        ...Object.entries(b.sharedByTeam).map(([t, v]) => ({ key: 'shared', label: `shared · ${model.teamName(t)}`, value: pts(v) })),
        { key: 'unplanned', label: 'unplanned + reserve', value: pts(b.unplanned) },
        { label: 'load', value: pts(b.load), strong: true },
        { key: 'available', label: 'available capacity', value: pts(b.capacity) },
        { key: 'absence', label: `absences (${days(p.total.oooDays)})`, value: `−${pts(b.absence)}` },
      ]}
    />
  );
  return (
    <div className="bbar" tabIndex={0} {...tip(content)} aria-label={`Load ${pts(b.load)} vs capacity ${pts(b.capacity)}`}>
      <div className="bbar-row">
        {b.planned > 0.01 && <span className="bseg swatch-planned" style={{ width: w(b.planned) }} />}
        {b.shared > 0.01 && <span className="bseg swatch-shared" style={{ width: w(b.shared) }} />}
        {b.unplanned > 0.01 && <span className="bseg swatch-unplanned" style={{ width: w(b.unplanned) }} />}
      </div>
      <div className="bbar-row bbar-cap">
        <span className="bseg swatch-available" style={{ width: w(b.capacity) }} />
        {b.absence > 0.01 && <span className="bseg swatch-absence" style={{ width: w(b.absence) }} />}
      </div>
    </div>
  );
}

function Heatmap({ people, onPick }: { people: PersonSummary[]; onPick: (id: string) => void }) {
  const { model } = usePlanner();
  const tip = useTipTarget();
  const weeks = people[0]?.weeks.map((w) => w.bucket) ?? [];
  return (
    <div className="table-wrap">
      <table className="heatmap" data-testid="heatmap">
        <thead>
          <tr>
            <th />
            {weeks.map((w) => (
              <th key={w.id} title={formatRange(w.start, w.end)}>
                {formatShort(w.start)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.person.id}>
              <th>
                <button className="link-button" onClick={() => onPick(p.person.id)}>
                  {p.person.name}
                </button>
              </th>
              {p.weeks.map(({ bucket, window: w }) => {
                const shared = Object.entries(w.loadByTeam)
                  .filter(([t]) => t !== p.focusTeamId)
                  .reduce((a, [, l]) => a + l.planned + l.unplanned + l.reserve, 0);
                const content = (
                  <TipRows
                    title={`${p.person.name} · ${formatRange(bucket.start, bucket.end)}`}
                    rows={[
                      { label: `utilization · ${STATUS_LABEL[w.status]}`, value: pct(w.utilization), strong: true },
                      { label: 'load', value: `${pts(w.load)} pts` },
                      { label: 'capacity', value: `${pts(w.capacity)} pts` },
                      ...(w.oooDays ? [{ key: 'absence', label: 'OOO', value: days(w.oooDays) }] : []),
                      ...(shared > 0.05 ? [{ key: 'shared', label: 'on other teams', value: `${pts(shared)} pts` }] : []),
                    ]}
                  />
                );
                return (
                  <td key={bucket.id} className={`cell cell-${w.status}`} tabIndex={0} {...tip(content)}>
                    {w.utilization == null ? (w.oooDays ? 'OOO' : '') : (
                      <>
                        <span className="cell-icon" aria-hidden>
                          {w.status === 'over' || w.status === 'at-risk' ? STATUS_ICON[w.status] : ''}
                        </span>
                        {pct(w.utilization)}
                      </>
                    )}
                    {w.oooDays >= 1 && w.status !== 'none' && <span className="cell-ooo" title="Out of office this week" />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="legend small">
        <span className="legend-item"><span className="cell-key cell-under" />Under 70%</span>
        <span className="legend-item"><span className="cell-key cell-healthy" />Healthy</span>
        <span className="legend-item"><span className="cell-key cell-at-risk" />At risk (&gt;{pct(model.input.planner.settings.thresholds.atRisk)})</span>
        <span className="legend-item"><span className="cell-key cell-over" />Over (&gt;{pct(model.input.planner.settings.thresholds.over)})</span>
        <span className="legend-item"><span className="cell-key cell-healthy"><span className="cell-ooo" /></span>Has OOO that week</span>
      </div>
    </div>
  );
}

function PersonDetail({ p }: { p: PersonSummary }) {
  const { model, state } = usePlanner();
  const v = p.velocity;
  const itemsByIssue = new Map<string, number>();
  for (const i of p.total.items) itemsByIssue.set(i.issueId, (itemsByIssue.get(i.issueId) ?? 0) + i.points);
  const issueIds = [...itemsByIssue.keys()].sort((a, b) => (model.issues.get(a)!.cycleId ?? '').localeCompare(model.issues.get(b)!.cycleId ?? ''));
  const ooo = p.total.oooEntries.map((e) => ({ ...e, entry: model.oooEntries.get(e.entryId)! }));
  return (
    <div className="person-detail">
      <div className="grid-3">
        <div>
          <h4>Capacity</h4>
          <dl className="facts">
            <dt>Working days</dt>
            <dd>{p.total.workingDays}</dd>
            <dt>OOO days</dt>
            <dd>{days(p.total.oooDays)}</dd>
            <dt>Velocity</dt>
            <dd>
              {pts(v.value)} pts/day ({v.source})
            </dd>
            <dt>Capacity</dt>
            <dd>
              {pts(v.value)} × ({p.total.workingDays} − {pts(p.total.oooDays)}) = {pts(p.total.capacity)} pts
            </dd>
            {p.person.teamIds.length > 1 && (
              <>
                <dt>Time split</dt>
                <dd>
                  {p.person.teamIds.map((t) => `${model.teams.get(t)?.key} ${pct(p.allocation.shares[t])}`).join(' / ')} ({p.allocation.source})
                </dd>
              </>
            )}
          </dl>
        </div>
        <div>
          <h4>Velocity evidence</h4>
          {v.window ? (
            <>
              <p className="small">
                {v.completedIssues} issues · {pts(v.points)} pts completed between {v.window.start} and {v.window.end}, over {pts(v.availableDays)} available days ({pts(v.oooDays)} OOO days excluded).
              </p>
              <ul className="small plain">
                {v.cycles.map((c) => (
                  <li key={c.cycleId}>
                    <CycleLabel id={c.cycleId} />: {pts(c.points)} pts
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="small muted">No completed cycles yet.</p>
          )}
          {v.source !== 'history' && <p className="small muted">Not enough history (needs 3+ completed issues), so {v.source === 'override' ? 'a planner override' : `the ${v.source}`} is used.</p>}
        </div>
        <div>
          <h4>Absences in range</h4>
          {ooo.length ? (
            <ul className="small plain">
              {ooo.map((o) => (
                <li key={o.entryId}>
                  {o.entry.type} · {formatRange(o.entry.start, o.entry.end)}
                  {o.entry.fraction < 1 ? ` (${pct(o.entry.fraction)} days)` : ''} · {days(o.days)} working{' '}
                  <span className="muted">
                    ({state.ooo?.fileName} row {o.entry.row}
                    {o.entry.email === '*' ? ', company-wide' : ''})
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None in {state.ooo ? state.ooo.fileName : 'OOO data (none imported)'}.</p>
          )}
        </div>
      </div>
      <h4>Scheduled issues ({issueIds.length})</h4>
      <IssueTable issueIds={issueIds} points={Object.fromEntries(itemsByIssue)} showAssignee={false} />
    </div>
  );
}
