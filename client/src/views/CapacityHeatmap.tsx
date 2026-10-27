import { useMemo, useState } from 'react';
import { periodBuckets, type Bucket, type PeriodUnit } from '../../../shared/calendar';
import { isOpen, teamWindow, type CapacityModel, type LoadItem, type PersonWindow, type TeamWindow } from '../../../shared/capacity';
import type { VelocityMode } from '../../../shared/types';
import { MultiSelect } from '../components/MultiSelect';
import { Drawer } from '../components/Overlay';
import { Empty, IssueTable, PersonName, STATUS_ICON, StatusPill, TipRows, TooltipProvider, useTipTarget } from '../components/ui';
import { usePlanner, type HeatmapFilters } from '../context';
import { days, formatRange, pct, pts, STATUS_LABEL } from '../format';

const UNIT_LABEL: Record<PeriodUnit, [string, string]> = { week: ['week', 'weeks'], month: ['month', 'months'], quarter: ['quarter', 'quarters'] };
/** Average weeks per period unit, for showing a manual pts/week rate per period. */
const WEEKS_PER: Record<PeriodUnit, number> = { week: 1, month: 52 / 12, quarter: 13 };

type Selection = { kind: 'person'; personId: string; teamId: string; bucket: Bucket } | { kind: 'team'; teamId: string; bucket: Bucket };

export function CapacityHeatmap() {
  const { model, filters, setFilters, state } = usePlanner();
  const h = filters.heatmap;
  const setH = (patch: Partial<HeatmapFilters>) => setFilters({ heatmap: { ...h, ...patch } });
  const [selection, setSelection] = useState<Selection | null>(null);

  const buckets = useMemo(() => periodBuckets(state.today, h.unit, h.size, h.count), [state.today, h.unit, h.size, h.count]);
  const projectSet = useMemo(() => new Set(h.projects), [h.projects]);
  const projectPeople = useMemo(() => {
    const ids = new Set<string>();
    for (const i of model.issues.values()) if (i.assigneeId && i.projectId && projectSet.has(i.projectId) && isOpen(i)) ids.add(i.assigneeId);
    return ids;
  }, [model, projectSet]);

  const groups = useMemo(() => {
    const teamFilter = new Set(h.teams);
    const peopleFilter = new Set(h.people);
    return [...model.teams.values()]
      .filter((t) => !teamFilter.size || teamFilter.has(t.id))
      .map((team) => {
        const members = team.memberIds
          .map((id) => model.people.get(id)!)
          .filter((p) => p?.active)
          .filter((p) => !peopleFilter.size || peopleFilter.has(p.id))
          .filter((p) => !projectSet.size || projectPeople.has(p.id));
        return {
          team,
          teamCells: buckets.map((b) => teamWindow(model, team.id, b.start, b.end)),
          rows: members.map((person) => ({ person, cells: buckets.map((b) => model.personWindow(person.id, b.start, b.end)) })),
        };
      })
      .filter((g) => g.rows.length || (!h.people.length && !h.projects.length));
  }, [model, buckets, h.teams, h.people, projectSet, projectPeople, h.projects.length]);

  const filtersActive = h.projects.length + h.teams.length + h.people.length > 0;

  return (
    <TooltipProvider>
      <div className="stack">
        <Toolbar />
        <p className="lede">
          Each cell is load as a % of capacity for that period: everything on a person's plate (all teams and projects) against their velocity × working days after OOO. Team rows compare the team's work
          with its members' time on that team. Click any cell to see what's in it.
        </p>
        {!groups.length ? (
          <Empty>
            Nobody matches these filters.{' '}
            <button className="link-button link" onClick={() => setH({ projects: [], teams: [], people: [] })}>
              Clear filters
            </button>
          </Empty>
        ) : (
          <section className="card">
            <div className="table-wrap">
              <table className="heatmap heatmap-v2" data-testid="heatmap">
                <thead>
                  <tr>
                    <th className="hm-name" />
                    {buckets.map((b, i) => (
                      <th key={b.id} title={formatRange(b.start, b.end)} data-testid="heatmap-col">
                        {b.label}
                        {i === 0 && b.start !== b.id && <div className="muted small">from today</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.team.id} data-testid={`heatmap-team-${g.team.key}`}>
                    <tr className="hm-team-row">
                      <th className="hm-name">
                        <span className="hm-team-name">{g.team.name}</span> <span className="muted small">team · {g.team.memberIds.length} people</span>
                      </th>
                      {g.teamCells.map((w, i) => (
                        <TeamCell key={buckets[i].id} w={w} bucket={buckets[i]} teamName={g.team.name} onOpen={() => setSelection({ kind: 'team', teamId: g.team.id, bucket: buckets[i] })} />
                      ))}
                    </tr>
                    {g.rows.map(({ person, cells }) => (
                      <tr key={person.id} data-testid="heatmap-person-row">
                        <th className="hm-name hm-person">
                          {person.name}
                          {person.teamIds.length > 1 && (
                            <span className="chip" title="Capacity and load cover all their teams">
                              also on {person.teamIds.filter((t) => t !== g.team.id).map((t) => model.teams.get(t)?.key).join(', ')}
                            </span>
                          )}
                          <div className="muted small">{velocityText(model, person.id)}</div>
                        </th>
                        {cells.map((w, i) => (
                          <PersonCell
                            key={buckets[i].id}
                            w={w}
                            bucket={buckets[i]}
                            name={person.name}
                            highlight={projectSet.size > 0 && w.items.some((it) => it.projectId && projectSet.has(it.projectId))}
                            onOpen={() => setSelection({ kind: 'person', personId: person.id, teamId: g.team.id, bucket: buckets[i] })}
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
            <Legend projectFilter={projectSet.size > 0} />
            {filtersActive && <p className="muted small">Team rows always show the whole team; filters narrow which people are listed.</p>}
          </section>
        )}
        {selection && (
          <Drawer
            title={selection.kind === 'person' ? model.people.get(selection.personId)?.name : `${model.teamName(selection.teamId)} (team)`}
            subtitle={
              selection.bucket.label === formatRange(selection.bucket.start, selection.bucket.end)
                ? selection.bucket.label
                : `${selection.bucket.label} · ${formatRange(selection.bucket.start, selection.bucket.end)}`
            }
            onClose={() => setSelection(null)}
            testId="cell-drawer"
          >
            {selection.kind === 'person' ? <PersonCellDetail personId={selection.personId} bucket={selection.bucket} /> : <TeamCellDetail teamId={selection.teamId} bucket={selection.bucket} />}
          </Drawer>
        )}
      </div>
    </TooltipProvider>
  );
}

function velocityText(model: CapacityModel, personId: string) {
  const v = model.velocity.get(personId)!;
  const perWeek = v.value * model.input.planner.settings.workDays.length;
  return `${pts(perWeek)} pts/wk · ${v.source}`;
}

function Toolbar() {
  const { model, filters, setFilters, state } = usePlanner();
  const h = filters.heatmap;
  const v = filters.velocity;
  const setH = (patch: Partial<HeatmapFilters>) => setFilters({ heatmap: { ...h, ...patch } });
  const setV = (velocity: VelocityMode) => setFilters({ velocity });
  const snapshot = state.snapshot!;
  const [unitSingular] = UNIT_LABEL[h.unit];
  const periodName = h.size === 1 ? unitSingular : `${h.size}-${unitSingular}`;
  const workDaysPerWeek = model.input.planner.settings.workDays.length;
  const shownPeople = [...model.people.values()].filter((p) => p.active && p.teamIds.length);
  const avgPerWeek = shownPeople.length ? (shownPeople.reduce((a, p) => a + model.velocity.get(p.id)!.value, 0) / shownPeople.length) * workDaysPerWeek : 0;
  const perWeek = v.kind === 'manual' ? v.pointsPerWeek : avgPerWeek;
  const perPeriod = perWeek * WEEKS_PER[h.unit] * h.size;

  return (
    <div className="filters filters-inline toolbar" data-testid="heatmap-toolbar">
      <fieldset className="field-group">
        <legend>Period</legend>
        <input
          type="number"
          min={1}
          max={12}
          value={h.size}
          aria-label="Period length"
          className="input-narrow"
          onChange={(e) => setH({ size: Math.min(12, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
          data-testid="period-size"
        />
        <select value={h.unit} aria-label="Period unit" onChange={(e) => setH({ unit: e.target.value as PeriodUnit, size: e.target.value === 'week' ? 2 : 1 })} data-testid="period-unit">
          <option value="week">{h.size === 1 ? 'week' : 'weeks'}</option>
          <option value="month">{h.size === 1 ? 'month' : 'months'}</option>
          <option value="quarter">{h.size === 1 ? 'quarter' : 'quarters'}</option>
        </select>
        <span className="muted small">×</span>
        <input
          type="number"
          min={1}
          max={26}
          value={h.count}
          aria-label="Number of periods"
          className="input-narrow"
          onChange={(e) => setH({ count: Math.min(26, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
          data-testid="period-count"
        />
        <span className="muted small">columns</span>
      </fieldset>
      <fieldset className="field-group">
        <legend>Velocity</legend>
        <select
          value={v.kind}
          aria-label="Velocity source"
          onChange={(e) => setV(e.target.value === 'manual' ? { kind: 'manual', pointsPerWeek: Math.max(1, Math.round(avgPerWeek)) } : { kind: e.target.value as 'history' | 'team-average' })}
          data-testid="velocity-mode"
        >
          <option value="history">Historical (per person)</option>
          <option value="team-average">Team average</option>
          <option value="manual">Points per week…</option>
        </select>
        {v.kind === 'manual' && (
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={v.pointsPerWeek}
            aria-label="Points per week"
            className="input-narrow"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) setV({ kind: 'manual', pointsPerWeek: n });
            }}
            data-testid="velocity-ppw"
          />
        )}
        <span className="muted small" data-testid="velocity-hint">
          {v.kind === 'manual' ? `pts/week = ` : `avg ${pts(avgPerWeek)} pts/week → `}
          {h.unit === 'week' ? '' : '≈ '}
          {pts(perPeriod)} pts per {periodName} period
        </span>
      </fieldset>
      <MultiSelect
        label="Projects"
        options={[...snapshot.projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name, hint: p.targetDate ?? 'no target' }))}
        value={h.projects}
        onChange={(projects) => setH({ projects })}
        testId="filter-projects"
      />
      <MultiSelect label="Teams" options={snapshot.teams.map((t) => ({ id: t.id, label: t.name }))} value={h.teams} onChange={(teams) => setH({ teams })} testId="filter-teams" />
      <MultiSelect
        label="People"
        options={shownPeople.sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name }))}
        value={h.people}
        onChange={(people) => setH({ people })}
        testId="filter-people"
      />
      {h.projects.length + h.teams.length + h.people.length > 0 && (
        <button className="btn btn-ghost btn-small" onClick={() => setH({ projects: [], teams: [], people: [] })}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function cellContent(w: { utilization: number | null; status: PersonWindow['status']; load: number }, oooDays: number) {
  if (w.utilization == null) return w.load > 0.05 ? 'OOO' : oooDays ? 'OOO' : '—';
  return (
    <>
      <span className="cell-icon" aria-hidden>
        {w.status === 'over' || w.status === 'at-risk' ? STATUS_ICON[w.status] : ''}
      </span>
      {pct(w.utilization)}
    </>
  );
}

function PersonCell({ w, bucket, name, highlight, onOpen }: { w: PersonWindow; bucket: Bucket; name: string; highlight: boolean; onOpen: () => void }) {
  const tip = useTipTarget();
  const unscheduled = Object.values(w.loadByTeam).reduce((a, l) => a + l.unscheduled, 0);
  const content = (
    <TipRows
      title={`${name} · ${bucket.label}`}
      rows={[
        { label: STATUS_LABEL[w.status], value: pct(w.utilization), strong: true },
        { label: 'load', value: `${pts(w.load)} pts` },
        { label: 'capacity', value: `${pts(w.capacity)} pts` },
        ...(w.oooDays ? [{ key: 'absence', label: 'OOO', value: days(w.oooDays) }] : []),
        ...(unscheduled > 0.05 ? [{ key: 'unscheduled', label: 'unscheduled project work', value: `${pts(unscheduled)} pts` }] : []),
        { label: '', value: 'Click for details' },
      ]}
    />
  );
  return (
    <td
      className={`cell cell-${w.status} cell-click ${highlight ? 'cell-project' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`${name}, ${bucket.label}: ${pct(w.utilization)} of capacity`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      data-testid="heatmap-cell"
      {...tip(content)}
    >
      {cellContent(w, w.oooDays)}
      {w.oooDays >= 1 && <span className="cell-ooo" />}
    </td>
  );
}

function TeamCell({ w, bucket, teamName, onOpen }: { w: TeamWindow; bucket: Bucket; teamName: string; onOpen: () => void }) {
  const tip = useTipTarget();
  const content = (
    <TipRows
      title={`${teamName} · ${bucket.label}`}
      rows={[
        { label: STATUS_LABEL[w.status], value: pct(w.utilization), strong: true },
        { label: 'team work', value: `${pts(w.load)} pts` },
        { label: 'capacity on this team', value: `${pts(w.capacity)} pts` },
        { label: 'lost to OOO', value: `−${pts(w.fullAbsence)} pts` },
        { label: 'members’ time on other teams', value: `−${pts(w.sharedLost)} pts` },
      ]}
    />
  );
  return (
    <td
      className={`cell cell-team cell-${w.status} cell-click`}
      tabIndex={0}
      role="button"
      aria-label={`${teamName} team, ${bucket.label}: ${pct(w.utilization)} of capacity`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      data-testid="heatmap-team-cell"
      {...tip(content)}
    >
      {cellContent(w, 0)}
    </td>
  );
}

function Legend({ projectFilter }: { projectFilter: boolean }) {
  const { model } = usePlanner();
  const t = model.input.planner.settings.thresholds;
  return (
    <div className="legend small hm-legend">
      <span className="legend-item">
        <span className="cell-key" />
        Under {pct(t.under)}
      </span>
      <span className="legend-item">
        <span className="cell-key cell-healthy" />
        Healthy
      </span>
      <span className="legend-item">
        <span className="cell-key cell-at-risk" />
        At risk (&gt;{pct(t.atRisk)})
      </span>
      <span className="legend-item">
        <span className="cell-key cell-over" />
        Over (&gt;{pct(t.over)})
      </span>
      <span className="legend-item">
        <span className="cell-key cell-healthy">
          <span className="cell-ooo" />
        </span>
        Has OOO
      </span>
      {projectFilter && (
        <span className="legend-item">
          <span className="cell-key cell-healthy cell-project" />
          Includes selected project work
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-down

const KIND_NOTE: Record<LoadItem['kind'], string> = {
  planned: 'cycle work',
  unplanned: 'added mid-cycle',
  unscheduled: 'no cycle · spread to target',
};

function sumBy<K extends string>(items: LoadItem[], key: (i: LoadItem) => K) {
  const out = new Map<K, number>();
  for (const i of items) out.set(key(i), (out.get(key(i)) ?? 0) + i.points);
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function Bars({ rows, max }: { rows: { label: string; value: number; cls: string; sign?: string }[]; max: number }) {
  return (
    <>
      {rows.map((r) => (
        <div className="wf-row" key={r.label}>
          <span className="wf-label">
            {r.sign && <span className="muted">{r.sign} </span>}
            {r.label}
          </span>
          <span className="wf-track">
            <span className={`wf-bar ${r.cls}`} style={{ width: `${Math.max(0, (r.value / Math.max(max, 0.01)) * 100)}%` }} />
          </span>
          <span className="wf-value num">{pts(r.value)}</span>
        </div>
      ))}
    </>
  );
}

function PersonCellDetail({ personId, bucket }: { personId: string; bucket: Bucket }) {
  const { model, state } = usePlanner();
  const w = model.personWindow(personId, bucket.start, bucket.end);
  const v = model.velocity.get(personId)!;
  const workDaysPerWeek = model.input.planner.settings.workDays.length;
  const reserve = Object.values(w.loadByTeam).reduce((a, l) => a + l.reserve, 0);
  const byKind = (k: LoadItem['kind']) => w.items.filter((i) => i.kind === k).reduce((a, i) => a + i.points, 0);
  const categories = [
    { label: 'Planned cycle work', value: byKind('planned'), cls: 'swatch-planned' },
    { label: 'Added mid-cycle (unplanned)', value: byKind('unplanned'), cls: 'swatch-unplanned' },
    { label: 'Unscheduled project work', value: byKind('unscheduled'), cls: 'swatch-unscheduled' },
    { label: 'Unplanned reserve', value: reserve, cls: 'swatch-reserve' },
  ];
  const max = Math.max(w.gross, w.load);
  const pointsById = Object.fromEntries(sumBy(w.items, (i) => i.issueId));
  const notes = Object.fromEntries(w.items.map((i) => [i.issueId, `${KIND_NOTE[i.kind]}${i.overdue ? ' (target passed)' : ''}`]));
  const ooo = w.oooEntries.map((e) => ({ ...e, entry: model.oooEntries.get(e.entryId)! }));

  return (
    <div className="stack drawer-body" data-testid="person-cell-detail">
      <div className="drawer-summary">
        <StatusPill status={w.status} utilization={w.utilization} />
        <span>
          <strong>{pts(w.load)} pts</strong> of load against <strong>{pts(w.capacity)} pts</strong> capacity
        </span>
      </div>
      <section>
        <h4>Capacity</h4>
        <Bars
          max={max}
          rows={[
            { label: 'Full time', value: w.gross, cls: 'wf-gross' },
            { label: 'Absences (OOO)', value: w.absence, cls: 'wf-absence', sign: '−' },
            { label: 'Available', value: w.capacity, cls: 'wf-capacity', sign: '=' },
          ]}
        />
        <p className="small muted">
          {pts(v.value * workDaysPerWeek)} pts/week ({v.source}
          {v.source === 'history' ? `, ${v.completedIssues} issues completed in the lookback` : ''}) × {w.workingDays} working days − {pts(w.oooDays)} OOO days.
        </p>
        {ooo.length > 0 && (
          <ul className="small plain">
            {ooo.map((o) => (
              <li key={o.entryId}>
                {o.entry.type} · {formatRange(o.entry.start, o.entry.end)}
                {o.entry.fraction < 1 ? ` (${pct(o.entry.fraction)} days)` : ''} · {days(o.days)} in this period{' '}
                <span className="muted">
                  ({state.ooo?.fileName} row {o.entry.row})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4>What's contributing to the load</h4>
        <Bars max={max} rows={categories} />
        <div className="grid-2 small">
          <div>
            <div className="muted">By team</div>
            <ul className="plain">
              {Object.entries(w.loadByTeam)
                .map(([t, l]) => [t, l.planned + l.unplanned + l.unscheduled + l.reserve] as const)
                .filter(([, n]) => n > 0.05)
                .map(([t, n]) => (
                  <li key={t}>
                    {model.teamName(t)}: {pts(n)} pts
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <div className="muted">By project</div>
            <ul className="plain" data-testid="by-project">
              {sumBy(w.items, (i) => i.projectId ?? '').map(([p, n]) => (
                <li key={p || 'none'}>
                  {p ? model.projects.get(p)?.name : 'No project'}: {pts(n)} pts
                </li>
              ))}
              {reserve > 0.05 && <li className="muted">Unplanned reserve: {pts(reserve)} pts</li>}
            </ul>
          </div>
        </div>
      </section>
      <section>
        <h4>Issues in this period ({Object.keys(pointsById).length})</h4>
        <IssueTable issueIds={Object.keys(pointsById)} points={pointsById} notes={notes} showAssignee={false} showState={false} showPriority={false} />
        <p className="muted small">"In range" is the share of each issue's points that falls in this period: cycle work is spread over the cycle's working days, project work without a cycle up to the target date.</p>
      </section>
    </div>
  );
}

function TeamCellDetail({ teamId, bucket }: { teamId: string; bucket: Bucket }) {
  const { model } = usePlanner();
  const w = teamWindow(model, teamId, bucket.start, bucket.end);
  const max = Math.max(w.fullGross, w.load);
  const pointsById = Object.fromEntries(sumBy(w.items, (i) => i.issueId));
  const notes = Object.fromEntries(w.items.map((i) => [i.issueId, `${KIND_NOTE[i.kind]}${i.assigneeId ? '' : ' · unassigned'}`]));
  return (
    <div className="stack drawer-body" data-testid="team-cell-detail">
      <div className="drawer-summary">
        <StatusPill status={w.status} utilization={w.utilization} />
        <span>
          <strong>{pts(w.load)} pts</strong> of team work against <strong>{pts(w.capacity)} pts</strong> of members' time on this team
        </span>
      </div>
      <section>
        <h4>Where the capacity went</h4>
        <Bars
          max={max}
          rows={[
            { label: "Members' full time", value: w.fullGross, cls: 'wf-gross' },
            { label: 'Absences (OOO)', value: w.fullAbsence, cls: 'wf-absence', sign: '−' },
            { label: 'Time on other teams', value: w.sharedLost, cls: 'wf-shared', sign: '−' },
            { label: 'Available', value: w.capacity, cls: 'wf-capacity', sign: '=' },
          ]}
        />
        <h4>What it's asked to carry</h4>
        <Bars
          max={max}
          rows={[
            { label: 'Planned cycle work', value: w.planned, cls: 'swatch-planned' },
            { label: 'Added mid-cycle', value: w.unplanned, cls: 'swatch-unplanned' },
            { label: 'Unscheduled project work', value: w.unscheduled, cls: 'swatch-unscheduled' },
            { label: 'Unplanned reserve', value: w.reserve, cls: 'swatch-reserve' },
            { label: 'Unassigned', value: w.unassigned, cls: 'swatch-unassigned' },
          ]}
        />
      </section>
      <section>
        <h4>Members</h4>
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Person</th>
                <th className="num">Time here</th>
                <th className="num">OOO</th>
                <th className="num">Capacity here</th>
                <th className="num">Team work</th>
                <th className="num">Other teams</th>
                <th>Overall</th>
              </tr>
            </thead>
            <tbody>
              {w.members.map((m) => (
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
      </section>
      <section>
        <h4>Team issues in this period ({Object.keys(pointsById).length})</h4>
        <IssueTable issueIds={Object.keys(pointsById)} points={pointsById} notes={notes} showState={false} showPriority={false} />
      </section>
    </div>
  );
}
