import { useMemo, useState } from 'react';
import { cycleName, summarizeTeam, type TeamCycleSummary, type TeamSummary } from '../../../shared/capacity';
import { CycleChart } from '../components/CycleChart';
import { Empty, IssueTable, Kpi, PersonName, StatusPill, TooltipProvider } from '../components/ui';
import { usePlanner } from '../context';
import { days, formatRange, pct, pts } from '../format';

export function TeamOverview() {
  const { model, filters } = usePlanner();
  const teams = useMemo(
    () => [...model.teams.values()].filter((t) => !filters.teamId || t.id === filters.teamId).map((t) => summarizeTeam(model, t.id)),
    [model, filters.teamId],
  );
  return (
    <TooltipProvider>
      <div className="stack">
        <p className="lede">Is each team realistically equipped for the work scheduled in its cycles? Load is compared with capacity after absences, time on other teams, and an unplanned-work reserve.</p>
        {teams.map((t) => (
          <TeamCard key={t.team.id} summary={t} single={teams.length === 1} />
        ))}
      </div>
    </TooltipProvider>
  );
}

function TeamCard({ summary, single }: { summary: TeamSummary; single: boolean }) {
  const { model } = usePlanner();
  const { team, cycles, totals, unplanned } = summary;
  const firstRisky = cycles.find((c) => c.status === 'over' || c.status === 'at-risk');
  const [selected, setSelected] = useState<string | null>(single ? (firstRisky?.cycle.id ?? cycles[0]?.cycle.id ?? null) : null);
  const selectedCycle = cycles.find((c) => c.cycle.id === selected) ?? null;
  const risky = cycles.filter((c) => c.status === 'over' || c.status === 'at-risk');

  return (
    <section className="card" data-testid={`team-card-${team.key}`}>
      <div className="card-head">
        <div>
          <h2>
            {team.name} <span className="muted">{team.key}</span>
          </h2>
          <p className="muted small">
            {team.cyclesEnabled ? `${team.cycleDuration}-week cycles` : 'Cycles disabled — no scheduled load'} · {team.memberIds.length} members ·{' '}
            {team.estimationType === 'notUsed' ? 'no estimates (1 issue = 1 pt)' : `${team.estimationType} estimates`} · unplanned reserve {pct(unplanned.buffer)} ({unplanned.bufferSource}), measured{' '}
            {pct(unplanned.ratio)}
          </p>
        </div>
      </div>
      {!cycles.length ? (
        <Empty>No open cycles in this date range.</Empty>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Available capacity" value={`${pts(totals.capacity)} pts`} sub={`${cycles.length} cycle${cycles.length === 1 ? '' : 's'} in range`} />
            <Kpi label="Scheduled load" value={`${pts(totals.load)} pts`} sub="incl. unplanned reserve" />
            <Kpi
              label={totals.net >= 0 ? 'Headroom' : 'Overcommitted by'}
              value={`${pts(Math.abs(totals.net))} pts`}
              tone={totals.net < 0 ? 'bad' : 'good'}
              sub={pct(totals.capacity > 0 ? totals.load / totals.capacity : null) + ' utilization'}
            />
            <Kpi label="Cycles at risk or over" value={`${risky.length} of ${cycles.length}`} tone={risky.length ? 'warn' : 'good'} sub={risky.length ? risky.map((c) => c.cycle.name ?? `Cycle ${c.cycle.number}`).join(', ') : 'none'} />
            <Kpi label="People over capacity" value={totals.peopleOver} tone={totals.peopleOver ? 'bad' : 'good'} sub="in at least one cycle" />
          </div>
          <CycleChart team={team} cycles={cycles} selectedId={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />
          {selectedCycle ? <CycleDetail cycle={selectedCycle} teamName={team.name} /> : <p className="muted small">Select a cycle to see where its capacity went and who is carrying the load.</p>}
          {summary.avgCompletedPerCycle != null && (
            <p className="muted small">
              Velocity-only capacity is what {team.name} completed per cycle on average over its last {model.input.planner.settings.lookbackCycles} cycles ({pts(summary.avgCompletedPerCycle)} pts) — it ignores
              upcoming absences and shared people.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function CycleDetail({ cycle, teamName }: { cycle: TeamCycleSummary; teamName: string }) {
  const { model } = usePlanner();
  const team = model.teams.get(cycle.cycle.teamId)!;
  const max = Math.max(cycle.fullGross, cycle.load, 1);
  const w = (v: number) => `${Math.max(0, (v / max) * 100)}%`;
  const rows = [
    { label: "Members' full time", value: cycle.fullGross, cls: 'wf-gross', sign: '' },
    { label: 'Absences (OOO)', value: cycle.fullAbsence, cls: 'wf-absence', sign: '−' },
    { label: 'Time on other teams', value: cycle.sharedLost, cls: 'wf-shared', sign: '−' },
    { label: `Available for ${teamName}`, value: cycle.capacity, cls: 'wf-capacity', sign: '=' },
  ];
  const loadRows = [
    { label: 'Planned', value: cycle.planned, cls: 'swatch-planned' },
    { label: 'Unplanned (added mid-cycle)', value: cycle.unplanned, cls: 'swatch-unplanned' },
    { label: 'Unplanned reserve', value: cycle.reserve, cls: 'swatch-reserve' },
    { label: 'Unassigned', value: cycle.unassigned, cls: 'swatch-unassigned' },
  ];
  return (
    <div className="detail" data-testid="cycle-detail">
      <h3>
        {cycleName(cycle.cycle, team)} · {formatRange(cycle.start, cycle.end)} <StatusPill status={cycle.status} utilization={cycle.utilization} />
      </h3>
      <div className="grid-2">
        <div>
          <h4>Where the capacity went</h4>
          {rows.map((r) => (
            <div className="wf-row" key={r.label}>
              <span className="wf-label">
                {r.sign && <span className="muted">{r.sign} </span>}
                {r.label}
              </span>
              <span className="wf-track">
                <span className={`wf-bar ${r.cls}`} style={{ width: w(r.value) }} />
              </span>
              <span className="wf-value num">{pts(r.value)}</span>
            </div>
          ))}
          <h4>What it's asked to carry</h4>
          <div className="wf-row">
            <span className="wf-label">Load</span>
            <span className="wf-track wf-stack">
              {loadRows
                .filter((r) => r.value > 0.01)
                .map((r) => (
                  <span key={r.label} className={`wf-bar ${r.cls}`} style={{ width: w(r.value) }} title={`${r.label}: ${pts(r.value)} pts`} />
                ))}
            </span>
            <span className="wf-value num">{pts(cycle.load)}</span>
          </div>
          <ul className="legend-list small">
            {loadRows.map((r) => (
              <li key={r.label}>
                <span className={`swatch ${r.cls}`} aria-hidden /> {r.label} <span className="num">{pts(r.value)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Who is carrying it</h4>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Time here</th>
                  <th className="num">OOO</th>
                  <th className="num">Capacity here</th>
                  <th className="num">This cycle</th>
                  <th className="num">Other teams</th>
                  <th>Overall</th>
                </tr>
              </thead>
              <tbody>
                {cycle.members.map((m) => (
                  <tr key={m.personId}>
                    <td>
                      <PersonName id={m.personId} />
                    </td>
                    <td className="num">{pct(m.share)}</td>
                    <td className="num">{m.oooDays ? days(m.oooDays) : '—'}</td>
                    <td className="num">{pts(m.capacity)}</td>
                    <td className="num">{pts(m.teamLoad)}</td>
                    <td className="num">{m.otherTeamLoad > 0.05 ? pts(m.otherTeamLoad) : '—'}</td>
                    <td>
                      <StatusPill status={m.status} utilization={m.utilization} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">"Overall" is each person's utilization across all their teams in this window.</p>
        </div>
      </div>
      <details className="issues-details">
        <summary>
          {cycle.issueIds.length} open issue{cycle.issueIds.length === 1 ? '' : 's'} in this cycle
          {cycle.unestimatedIssueIds.length ? ` · ${cycle.unestimatedIssueIds.length} unestimated` : ''}
        </summary>
        <IssueTable issueIds={sortIssues(model, cycle.issueIds)} showCycle={false} highlight={new Set(cycle.unestimatedIssueIds)} />
      </details>
    </div>
  );
}

function sortIssues(model: ReturnType<typeof usePlanner>['model'], ids: string[]) {
  return [...ids].sort((a, b) => {
    const ia = model.issues.get(a)!;
    const ib = model.issues.get(b)!;
    return (ia.assigneeId ?? '~').localeCompare(ib.assigneeId ?? '~') || ia.identifier.localeCompare(ib.identifier, undefined, { numeric: true });
  });
}
