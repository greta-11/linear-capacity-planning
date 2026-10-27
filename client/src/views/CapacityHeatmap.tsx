import { useMemo, useState } from 'react';
import { addDays, countWorkingDays, dayInTimezone, formatShort, maxDay, overlap, weekStart, type Bucket, type PeriodUnit } from '../../../shared/calendar';
import { cycleName, isOpen, teamWindow, type CapacityModel, type LoadItem, type PersonWindow, type Status, type TeamWindow } from '../../../shared/capacity';
import type { VelocityMode } from '../../../shared/types';
import { MultiSelect } from '../components/MultiSelect';
import { Drawer } from '../components/Overlay';
import { Empty, IssueTable, PersonName, STATUS_ICON, StatusPill, TipRows, TooltipProvider, useTipTarget } from '../components/ui';
import { usePlanner, type HeatmapFilters, type HeatmapMode } from '../context';
import { days, formatRange, pct, pts, STATUS_LABEL } from '../format';
import { VELOCITY_SOURCE_LABEL } from './velocity';

const UNIT_LABEL: Record<PeriodUnit, string> = { week: 'week', month: 'month', quarter: 'quarter' };
/** Average weeks per period unit, for showing a pts/week rate per period. */
const WEEKS_PER: Record<PeriodUnit, number> = { week: 1, month: 52 / 12, quarter: 13 };
const STATUS_OPTIONS: { id: Status; label: string }[] = [
  { id: 'over', label: 'Over' },
  { id: 'at-risk', label: 'At risk' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'under', label: 'Under' },
];
const NO_PROJECT = 'none';

type Selection =
  | { kind: 'person'; personId: string; bucket: Bucket }
  | { kind: 'team'; teamId: string; bucket: Bucket }
  | { kind: 'project'; teamId: string; projectKey: string; bucket: Bucket };

interface ProjectRow {
  key: string;
  name: string;
  cells: { points: number; share: number | null; issueIds: string[] }[];
  total: number;
}

export function CapacityHeatmap() {
  const { model, filters, setFilters, buckets } = usePlanner();
  const h = filters.heatmap;
  const setH = (patch: Partial<HeatmapFilters>) => setFilters({ heatmap: { ...h, ...patch } });
  const [selection, setSelection] = useState<Selection | null>(null);
  // Team groups start collapsed (team-level view). Person, project and capacity-type
  // filters are about rows inside a team, so they expand every group while active.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const autoExpand = h.people.length > 0 || h.projects.length > 0 || h.statuses.length > 0;
  const isExpanded = (teamId: string) => autoExpand || expanded.has(teamId);
  const toggle = (teamId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });

  const projectSet = useMemo(() => new Set(h.projects), [h.projects]);
  const statusSet = useMemo(() => new Set(h.statuses), [h.statuses]);
  const projectPeople = useMemo(() => {
    const ids = new Set<string>();
    for (const i of model.issues.values()) if (i.assigneeId && i.projectId && projectSet.has(i.projectId) && isOpen(i)) ids.add(i.assigneeId);
    return ids;
  }, [model, projectSet]);

  const groups = useMemo(() => {
    const matches = (cells: { status: Status }[]) => !statusSet.size || cells.some((c) => statusSet.has(c.status));
    const teamFilter = new Set(h.teams);
    const peopleFilter = new Set(h.people);
    return [...model.teams.values()]
      .filter((t) => !teamFilter.size || teamFilter.has(t.id))
      .map((team) => {
        const teamCells = buckets.map((b) => teamWindow(model, team.id, b.start, b.end));
        const allPeople = team.memberIds
          .map((id) => model.people.get(id)!)
          .filter((p) => p?.active)
          .filter((p) => !peopleFilter.size || peopleFilter.has(p.id))
          .filter((p) => !projectSet.size || projectPeople.has(p.id))
          .map((person) => ({ person, cells: buckets.map((b) => model.personWindow(person.id, b.start, b.end)) }));
        const keys = new Set(teamCells.flatMap((c) => Object.keys(c.byProject)));
        const projects: ProjectRow[] = [...keys]
          .filter((k) => !projectSet.size || projectSet.has(k))
          .map((key) => {
            const cells = teamCells.map((c) => {
              const p = c.byProject[key];
              return { points: p?.points ?? 0, share: c.plannable > 0 ? (p?.points ?? 0) / c.plannable : null, issueIds: p?.issueIds ?? [] };
            });
            return { key, name: key === NO_PROJECT ? 'No project' : (model.projects.get(key)?.name ?? 'Unknown project'), cells, total: cells.reduce((a, c) => a + c.points, 0) };
          })
          .sort((a, b) => (a.key === NO_PROJECT ? 1 : b.key === NO_PROJECT ? -1 : b.total - a.total));
        const overCount = allPeople.filter((r) => r.cells.some((c) => c.status === 'over')).length;
        const people = allPeople.filter((r) => matches(r.cells));
        return { team, teamCells, people, projects, overCount, teamMatches: matches(teamCells) };
      })
      .filter((g) => {
        if (h.mode === 'people') {
          if ((h.people.length || h.projects.length) && !g.people.length) return false;
          return g.teamMatches || g.people.length > 0;
        }
        if (h.projects.length && !g.projects.length) return false;
        return g.teamMatches;
      });
  }, [model, buckets, h.teams, h.people, h.mode, projectSet, projectPeople, statusSet, h.projects.length]);

  const allExpanded = groups.length > 0 && groups.every((g) => isExpanded(g.team.id));
  const filtersActive = h.projects.length + h.teams.length + h.people.length + h.statuses.length > 0;

  return (
    <TooltipProvider>
      <div className="stack">
        <Toolbar />
        <p className="lede">
          {h.mode === 'people'
            ? "Each cell is a person's planned load as a % of their plannable capacity for that period (all their teams and projects). Team rows compare the team's work with its members' plannable time on that team."
            : "Team rows show the team's planned load as a % of its plannable capacity. Project rows show how much of that capacity each project takes, so they add up to the team row."}{' '}
          Click any cell to see what's in it.
        </p>
        {!groups.length ? (
          <Empty>
            Nothing matches these filters.{' '}
            <button className="link-button link" onClick={() => setH({ projects: [], teams: [], people: [], statuses: [] })}>
              Clear filters
            </button>
          </Empty>
        ) : (
          <section className="card">
            <div className="hm-head">
              <div className="segmented" role="group" aria-label="Rows">
                <button className={h.mode === 'people' ? 'seg-active' : ''} aria-pressed={h.mode === 'people'} onClick={() => setH({ mode: 'people' })} data-testid="mode-people">
                  Individuals
                </button>
                <button className={h.mode === 'projects' ? 'seg-active' : ''} aria-pressed={h.mode === 'projects'} onClick={() => setH({ mode: 'projects' })} data-testid="mode-projects">
                  Projects
                </button>
              </div>
              <button className="btn btn-ghost btn-small" disabled={autoExpand} onClick={() => setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.team.id)))} data-testid="expand-all">
                {allExpanded ? 'Collapse all' : 'Expand all teams'}
              </button>
              {autoExpand && <span className="muted small">Teams are expanded while a person, project or capacity-type filter is active.</span>}
            </div>
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
                        <button className="hm-toggle" aria-expanded={isExpanded(g.team.id)} onClick={() => toggle(g.team.id)} disabled={autoExpand} data-testid={`toggle-${g.team.key}`}>
                          <span aria-hidden className="hm-caret">
                            {isExpanded(g.team.id) ? '▾' : '▸'}
                          </span>
                          <span className="hm-team-name">{g.team.name}</span>
                        </button>
                        <div className="muted small hm-team-meta">
                          {h.mode === 'people' ? (
                            <>
                              {g.people.length} {g.people.length === 1 ? 'person' : 'people'}
                              {g.overCount > 0 && <span className="hm-over"> · {g.overCount} over in a period</span>}
                            </>
                          ) : (
                            <>
                              {g.projects.filter((p) => p.key !== NO_PROJECT).length} projects{g.projects.some((p) => p.key === NO_PROJECT) ? ' + work with no project' : ''}
                            </>
                          )}
                        </div>
                      </th>
                      {g.teamCells.map((w, i) => (
                        <TeamCell key={buckets[i].id} w={w} bucket={buckets[i]} teamName={g.team.name} onOpen={() => setSelection({ kind: 'team', teamId: g.team.id, bucket: buckets[i] })} />
                      ))}
                    </tr>
                    {isExpanded(g.team.id) &&
                      h.mode === 'people' &&
                      g.people.map(({ person, cells }) => {
                        const v = model.velocity.get(person.id)!;
                        return (
                          <tr key={person.id} data-testid="heatmap-person-row">
                            <th className="hm-name hm-person">
                              {person.name}
                              {person.teamIds.length > 1 && (
                                <span className="chip" title="Capacity and load cover all their teams">
                                  also on {person.teamIds.filter((t) => t !== g.team.id).map((t) => model.teams.get(t)?.key).join(', ')}
                                </span>
                              )}
                              <div className="muted small">{velocityText(model, person.id)}</div>
                              {v.fallbackNote && (
                                <div className="small velocity-note" data-testid="velocity-note">
                                  {v.fallbackNote}
                                </div>
                              )}
                            </th>
                            {cells.map((w, i) => (
                              <PersonCell
                                key={buckets[i].id}
                                w={w}
                                bucket={buckets[i]}
                                name={person.name}
                                highlight={projectSet.size > 0 && w.items.some((it) => it.projectId && projectSet.has(it.projectId))}
                                onOpen={() => setSelection({ kind: 'person', personId: person.id, bucket: buckets[i] })}
                              />
                            ))}
                          </tr>
                        );
                      })}
                    {isExpanded(g.team.id) &&
                      h.mode === 'projects' &&
                      g.projects.map((p) => (
                        <tr key={p.key} data-testid="heatmap-project-row">
                          <th className="hm-name hm-person">
                            {p.name}
                            <div className="muted small">{pts(p.total)} pts in view</div>
                          </th>
                          {p.cells.map((c, i) => (
                            <ProjectCell
                              key={buckets[i].id}
                              cell={c}
                              bucket={buckets[i]}
                              name={p.name}
                              teamName={g.team.name}
                              teamPlannable={g.teamCells[i].plannable}
                              onOpen={() => setSelection({ kind: 'project', teamId: g.team.id, projectKey: p.key, bucket: buckets[i] })}
                            />
                          ))}
                        </tr>
                      ))}
                  </tbody>
                ))}
              </table>
            </div>
            <Legend mode={h.mode} projectFilter={projectSet.size > 0} />
            {filtersActive && <p className="muted small">Team rows always show the whole team; filters narrow which rows are listed.</p>}
          </section>
        )}
        {selection && (
          <Drawer
            title={
              selection.kind === 'person'
                ? model.people.get(selection.personId)?.name
                : selection.kind === 'team'
                  ? `${model.teamName(selection.teamId)} (team)`
                  : `${selection.projectKey === NO_PROJECT ? 'No project' : model.projects.get(selection.projectKey)?.name} · ${model.teamName(selection.teamId)}`
            }
            subtitle={
              selection.bucket.label === formatRange(selection.bucket.start, selection.bucket.end)
                ? selection.bucket.label
                : `${selection.bucket.label} · ${formatRange(selection.bucket.start, selection.bucket.end)}`
            }
            onClose={() => setSelection(null)}
            testId="cell-drawer"
          >
            {selection.kind === 'person' && <PersonCellDetail personId={selection.personId} bucket={selection.bucket} />}
            {selection.kind === 'team' && <TeamCellDetail teamId={selection.teamId} bucket={selection.bucket} />}
            {selection.kind === 'project' && <ProjectCellDetail teamId={selection.teamId} projectKey={selection.projectKey} bucket={selection.bucket} />}
          </Drawer>
        )}
      </div>
    </TooltipProvider>
  );
}

function velocityText(model: CapacityModel, personId: string) {
  const v = model.velocity.get(personId)!;
  const perWeek = v.value * model.input.planner.settings.workDays.length;
  return `${pts(perWeek)} pts/wk · ${VELOCITY_SOURCE_LABEL[v.source]}`;
}

function Toolbar() {
  const { model, filters, setFilters, state } = usePlanner();
  const h = filters.heatmap;
  const v = filters.velocity;
  const setH = (patch: Partial<HeatmapFilters>) => setFilters({ heatmap: { ...h, ...patch } });
  const setV = (velocity: VelocityMode) => setFilters({ velocity });
  const snapshot = state.snapshot!;
  const periodName = h.size === 1 ? UNIT_LABEL[h.unit] : `${h.size}-${UNIT_LABEL[h.unit]}`;
  const workDaysPerWeek = model.input.planner.settings.workDays.length;
  const shownPeople = [...model.people.values()].filter((p) => p.active && p.teamIds.length);
  const avgPerWeek = shownPeople.length ? (shownPeople.reduce((a, p) => a + model.velocity.get(p.id)!.value, 0) / shownPeople.length) * workDaysPerWeek : 0;
  const perWeek = v.kind === 'manual' ? v.pointsPerWeek : avgPerWeek;
  const perPeriod = perWeek * WEEKS_PER[h.unit] * h.size;
  const bufferPctWhole = Math.round(filters.bufferPct * 100);

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
      <fieldset className="field-group">
        <legend>Buffer</legend>
        <input
          type="number"
          min={0}
          max={90}
          step={5}
          value={bufferPctWhole}
          aria-label="Buffer percent"
          className="input-narrow"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setFilters({ bufferPct: Math.min(90, Math.max(0, n)) / 100 });
          }}
          data-testid="buffer-pct"
        />
        <span className="muted small" data-testid="buffer-hint">
          % for everyone · plannable = available × {100 - bufferPctWhole}%
        </span>
      </fieldset>
      <MultiSelect label="Capacity type" options={STATUS_OPTIONS} value={h.statuses} onChange={(statuses) => setH({ statuses: statuses as Status[] })} testId="filter-status" />
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
      {h.projects.length + h.teams.length + h.people.length + h.statuses.length > 0 && (
        <button className="btn btn-ghost btn-small" onClick={() => setH({ projects: [], teams: [], people: [], statuses: [] })}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function cellContent(w: { utilization: number | null; status: Status; load: number }, oooDays: number) {
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

const cellKeys = (onOpen: () => void) => ({
  tabIndex: 0,
  role: 'button',
  onClick: onOpen,
  onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen()),
});

function PersonCell({ w, bucket, name, highlight, onOpen }: { w: PersonWindow; bucket: Bucket; name: string; highlight: boolean; onOpen: () => void }) {
  const tip = useTipTarget();
  const unscheduled = Object.values(w.loadByTeam).reduce((a, l) => a + l.unscheduled, 0);
  const content = (
    <TipRows
      title={`${name} · ${bucket.label}`}
      rows={[
        { label: STATUS_LABEL[w.status], value: pct(w.utilization), strong: true },
        { label: 'planned load', value: `${pts(w.load)} pts` },
        { label: 'plannable capacity', value: `${pts(w.plannable)} pts` },
        ...(w.oooDays ? [{ key: 'absence', label: 'OOO', value: days(w.oooDays) }] : []),
        ...(unscheduled > 0.05 ? [{ key: 'unscheduled', label: 'unscheduled work', value: `${pts(unscheduled)} pts` }] : []),
        { label: '', value: 'Click for details' },
      ]}
    />
  );
  return (
    <td
      className={`cell cell-${w.status} cell-click ${highlight ? 'cell-project' : ''}`}
      aria-label={`${name}, ${bucket.label}: ${pct(w.utilization)} of plannable capacity`}
      data-testid="heatmap-cell"
      data-status={w.status}
      {...cellKeys(onOpen)}
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
        { label: 'planned team work', value: `${pts(w.load)} pts` },
        { label: 'plannable capacity on this team', value: `${pts(w.plannable)} pts` },
        { label: 'lost to OOO', value: `−${pts(w.fullOoo)} pts` },
        { label: 'members’ time on other teams', value: `−${pts(w.sharedLost)} pts` },
        { label: 'buffer', value: `−${pts(w.bufferPoints)} pts` },
      ]}
    />
  );
  return (
    <td
      className={`cell cell-team cell-${w.status} cell-click`}
      aria-label={`${teamName} team, ${bucket.label}: ${pct(w.utilization)} of plannable capacity`}
      data-testid="heatmap-team-cell"
      data-status={w.status}
      {...cellKeys(onOpen)}
      {...tip(content)}
    >
      {cellContent(w, 0)}
    </td>
  );
}

function ProjectCell({
  cell,
  bucket,
  name,
  teamName,
  teamPlannable,
  onOpen,
}: {
  cell: ProjectRow['cells'][number];
  bucket: Bucket;
  name: string;
  teamName: string;
  teamPlannable: number;
  onOpen: () => void;
}) {
  const tip = useTipTarget();
  const share = cell.share ?? 0;
  const content = (
    <TipRows
      title={`${name} · ${bucket.label}`}
      rows={[
        { label: `of ${teamName}'s plannable capacity`, value: pct(cell.share), strong: true },
        { label: 'planned load', value: `${pts(cell.points)} pts` },
        { label: 'team plannable capacity', value: `${pts(teamPlannable)} pts` },
        { label: 'issues', value: String(cell.issueIds.length) },
      ]}
    />
  );
  // Neutral, single-hue tint: a project's share of team capacity isn't good or bad on its own.
  const alpha = Math.min(0.55, share * 0.6);
  return (
    <td
      className="cell cell-proj cell-click"
      style={{ background: cell.points > 0.05 ? `rgba(42, 120, 214, ${alpha.toFixed(3)})` : undefined }}
      aria-label={`${name}, ${bucket.label}: ${pct(cell.share)} of team capacity`}
      data-testid="heatmap-project-cell"
      {...cellKeys(onOpen)}
      {...tip(content)}
    >
      {cell.points > 0.05 ? pct(cell.share) : '—'}
    </td>
  );
}

function Legend({ mode, projectFilter }: { mode: HeatmapMode; projectFilter: boolean }) {
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
      {mode === 'people' ? (
        <span className="legend-item">
          <span className="cell-key cell-healthy">
            <span className="cell-ooo" />
          </span>
          Has OOO
        </span>
      ) : (
        <span className="legend-item">
          <span className="cell-key cell-proj-key" />
          Project's share of team capacity (darker = larger)
        </span>
      )}
      {projectFilter && mode === 'people' && (
        <span className="legend-item">
          <span className="cell-key cell-healthy cell-project" />
          Includes selected project work
        </span>
      )}
      <span className="legend-item muted">% of plannable capacity (after OOO and buffer)</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-down

/** Where an item's remaining points are spread, and how many of those working days fall in the period. */
function itemMath(model: CapacityModel, item: LoadItem, bucket: Bucket) {
  const today = model.input.today;
  const workDays = model.input.planner.settings.workDays;
  const issue = model.issues.get(item.issueId)!;
  const cycle = item.cycleId ? model.cycles.get(item.cycleId) : undefined;
  const project = item.projectId ? model.projects.get(item.projectId) : undefined;
  const target = issue.dueDate ?? project?.targetDate ?? null;
  let start = today;
  let end = today;
  if (cycle) {
    start = maxDay(cycle.startDate, today);
    end = cycle.endDate;
  } else if (target) {
    end = item.overdue ? addDays(weekStart(today), 6) : target;
  }
  const spreadDays = countWorkingDays(start, end, workDays);
  const ov = overlap(bucket.start, bucket.end, start, end);
  const inPeriod = ov ? countWorkingDays(ov[0], ov[1], workDays) : 0;
  const team = model.teams.get(issue.teamId);
  const addedDay = issue.addedToCycleAt ? dayInTimezone(issue.addedToCycleAt, team?.timezone ?? 'UTC') : null;
  return { issue, cycle, project, target, spreadDays: Math.max(1, spreadDays), inPeriod: spreadDays ? inPeriod : 1, addedDay };
}

/** One-line note for the issue table. */
function itemNote(model: CapacityModel, item: LoadItem, bucket: Bucket): string {
  const m = itemMath(model, item, bucket);
  const who = item.assigneeId ? '' : ' · unassigned';
  const share = item.weight < 1 ? ` · ${pct(item.weight)} left (${m.issue.stateName})` : '';
  if (item.kind === 'unplanned') return `added mid-cycle (${m.addedDay ? formatShort(m.addedDay) : '?'}, after ${formatShort(m.cycle!.startDate)} start)${share}${who}`;
  if (item.kind === 'unscheduled') {
    const what = item.dateSource === 'due' ? 'due' : 'project target';
    return item.overdue ? `no cycle · ${what} ${formatShort(m.target!)} passed → this week${share}${who}` : `no cycle · spread to ${what} ${formatShort(m.target!)}${share}${who}`;
  }
  return `cycle work · ${m.spreadDays} working days left in cycle${share}${who}`;
}

/** "5 pts × 50% = 2.5 remaining over 19 working days, 10 in this period = 1.3 pts" */
function spreadMath(model: CapacityModel, item: LoadItem, bucket: Bucket) {
  const m = itemMath(model, item, bucket);
  const remaining = item.weight < 1 ? ` × ${pct(item.weight)} = ${pts(item.remainingPoints)} remaining` : '';
  return `${pts(item.fullPoints)} pts${item.unestimated ? ' (unestimated → team median)' : ''}${remaining} over ${m.spreadDays} working day${m.spreadDays === 1 ? '' : 's'}, ${m.inPeriod} in this period = ${pts(item.points)} pts`;
}

const PRIORITY_RANK = (p: number) => (p === 0 ? 5 : p);
/** Issue ids ordered by priority (urgent first), then by points in the period. */
function byPriority(model: CapacityModel, pointsById: Record<string, number>) {
  return Object.keys(pointsById).sort(
    (a, b) => PRIORITY_RANK(model.issues.get(a)!.priority) - PRIORITY_RANK(model.issues.get(b)!.priority) || pointsById[b] - pointsById[a],
  );
}

function sumBy<K extends string>(items: LoadItem[], key: (i: LoadItem) => K) {
  const out = new Map<K, number>();
  for (const i of items) out.set(key(i), (out.get(key(i)) ?? 0) + i.points);
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function Bars({ rows, max }: { rows: { label: string; value: number; cls: string; sign?: string; testId?: string }[]; max: number }) {
  return (
    <>
      {rows.map((r) => (
        <div className="wf-row" key={r.label} data-testid={r.testId}>
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

/** "How this is calculated" for the derived load categories, with this cell's numbers. */
function CalcExplainer({ items, bucket }: { items: LoadItem[]; bucket: Bucket }) {
  const { model } = usePlanner();
  const unplanned = items.filter((i) => i.kind === 'unplanned');
  const unscheduled = items.filter((i) => i.kind === 'unscheduled');
  const partial = items.filter((i) => i.weight < 1);
  const total = (list: LoadItem[]) => pts(list.reduce((a, i) => a + i.points, 0));
  const id = (i: LoadItem) => model.issues.get(i.issueId)!.identifier;
  const w = model.input.planner.settings.statusWeights;
  return (
    <div className="calc" data-testid="calc-explainer">
      <details>
        <summary>
          <span className="swatch swatch-unplanned" aria-hidden /> How <strong>Added mid-cycle (unplanned)</strong> is calculated · {total(unplanned)} pts
        </summary>
        <p>
          An issue counts as added mid-cycle when it entered its current cycle after the cycle's first day (from the issue's history in Linear, or its created date if there is no cycle change). Like
          other cycle work, its remaining points are spread evenly over the cycle's remaining working days, and this period gets its share.
        </p>
        {unplanned.length ? (
          <ul>
            {unplanned.map((i) => {
              const m = itemMath(model, i, bucket);
              return (
                <li key={i.issueId}>
                  <strong>{id(i)}</strong> added {m.addedDay ? formatShort(m.addedDay) : '?'}; {cycleName(m.cycle!, model.teams.get(m.cycle!.teamId))} started {formatShort(m.cycle!.startDate)} ·{' '}
                  {spreadMath(model, i, bucket)}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No issues added mid-cycle fall in this period.</p>
        )}
      </details>
      <details>
        <summary>
          <span className="swatch swatch-unscheduled" aria-hidden /> How <strong>Unscheduled work</strong> is calculated · {total(unscheduled)} pts
        </summary>
        <p>
          Open issues that aren't in a cycle but have a date: their own due date, or else their project's target date. Each issue's remaining points are spread evenly over the working days from today to
          that date, and this period gets its share. If the date has passed, the points land on the current week. Issues with no date at all aren't counted; they're listed under Data hygiene.
        </p>
        {unscheduled.length ? (
          <ul>
            {unscheduled.map((i) => {
              const m = itemMath(model, i, bucket);
              return (
                <li key={i.issueId}>
                  <strong>{id(i)}</strong> ({i.dateSource === 'due' ? `due ${formatShort(m.target!)}` : `${m.project?.name}, target ${formatShort(m.target!)}`}
                  {i.overdue ? ', passed' : ''}) · {spreadMath(model, i, bucket)}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No unscheduled work falls in this period.</p>
        )}
      </details>
      <details>
        <summary>
          How <strong>remaining work by status</strong> is calculated · {partial.length} issue{partial.length === 1 ? '' : 's'} partly done
        </summary>
        <p>
          Each issue counts for the share of its estimate still to do, by status: Triage, Backlog and Todo {pct(w.notStarted)}, In Progress {pct(w.inProgress)}, In Review {pct(w.inReview)}. The weights
          can be changed in Settings.
        </p>
        {partial.length ? (
          <ul>
            {partial.map((i) => (
              <li key={i.issueId}>
                <strong>{id(i)}</strong> · {pts(i.fullPoints)} pts × {pct(i.weight)} ({model.issues.get(i.issueId)!.stateName}) = {pts(i.remainingPoints)} remaining
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">All work in this period is not started yet, so it counts in full.</p>
        )}
      </details>
    </div>
  );
}

function PersonCellDetail({ personId, bucket }: { personId: string; bucket: Bucket }) {
  const { model, state } = usePlanner();
  const w = model.personWindow(personId, bucket.start, bucket.end);
  const v = model.velocity.get(personId)!;
  const workDaysPerWeek = model.input.planner.settings.workDays.length;
  const byKind = (k: LoadItem['kind']) => w.items.filter((i) => i.kind === k).reduce((a, i) => a + i.points, 0);
  const max = Math.max(w.baseline, w.load);
  const pointsById = Object.fromEntries(sumBy(w.items, (i) => i.issueId));
  const notes = Object.fromEntries(w.items.map((i) => [i.issueId, itemNote(model, i, bucket)]));
  const ooo = w.oooEntries.map((e) => ({ ...e, entry: model.oooEntries.get(e.entryId)! }));

  return (
    <div className="stack drawer-body" data-testid="person-cell-detail">
      <div className="drawer-summary">
        <StatusPill status={w.status} utilization={w.utilization} />
        <span>
          <strong>{pts(w.load)} pts</strong> planned load ÷ <strong>{pts(w.plannable)} pts</strong> plannable capacity
        </span>
      </div>
      <section>
        <h4>Capacity</h4>
        <Bars
          max={max}
          rows={[
            { label: 'Baseline', value: w.baseline, cls: 'wf-gross', testId: 'cap-baseline' },
            { label: `OOO (${pct(w.oooShare)} of days)`, value: w.baseline - w.available, cls: 'wf-absence', sign: '−' },
            { label: 'Available', value: w.available, cls: 'wf-available', sign: '=' },
            { label: `Buffer (${pct(w.buffer)})`, value: w.bufferPoints, cls: 'wf-buffer', sign: '−' },
            { label: 'Plannable', value: w.plannable, cls: 'wf-capacity', sign: '=', testId: 'cap-plannable' },
          ]}
        />
        <p className="small muted" data-testid="capacity-formula">
          Baseline = {pts(v.value * workDaysPerWeek)} pts/week × {w.workingDays} working days. Available = baseline × (1 − {pct(w.oooShare)} OOO). Plannable = available × (1 − {pct(w.buffer)} buffer).
          Velocity: {v.source === 'history' ? `own history, ${v.completedIssues} completed issues` : VELOCITY_SOURCE_LABEL[v.source]}.
        </p>
        {v.fallbackNote && <p className="small velocity-note">{v.fallbackNote}</p>}
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
        <h4>Planned load</h4>
        <Bars
          max={max}
          rows={[
            { label: 'Cycle work', value: byKind('planned'), cls: 'swatch-planned' },
            { label: 'Added mid-cycle (unplanned)', value: byKind('unplanned'), cls: 'swatch-unplanned' },
            { label: 'Unscheduled work (spread to date)', value: byKind('unscheduled'), cls: 'swatch-unscheduled' },
          ]}
        />
        <CalcExplainer items={w.items} bucket={bucket} />
        <div className="grid-2 small">
          <div>
            <div className="muted">By team</div>
            <ul className="plain">
              {Object.entries(w.loadByTeam)
                .map(([t, l]) => [t, l.planned + l.unplanned + l.unscheduled] as const)
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
            </ul>
          </div>
        </div>
      </section>
      <section>
        <h4>Issues in this period ({Object.keys(pointsById).length})</h4>
        <IssueTable issueIds={byPriority(model, pointsById)} points={pointsById} notes={notes} notesInline showAssignee={false} showState={false} />
        <p className="muted small">Sorted by priority. "In range" is the share of each issue's remaining points that falls in this period.</p>
      </section>
    </div>
  );
}

function TeamCellDetail({ teamId, bucket }: { teamId: string; bucket: Bucket }) {
  const { model } = usePlanner();
  const w = teamWindow(model, teamId, bucket.start, bucket.end);
  const max = Math.max(w.fullBaseline, w.load);
  const pointsById = Object.fromEntries(sumBy(w.items, (i) => i.issueId));
  const notes = Object.fromEntries(w.items.map((i) => [i.issueId, itemNote(model, i, bucket)]));
  return (
    <div className="stack drawer-body" data-testid="team-cell-detail">
      <div className="drawer-summary">
        <StatusPill status={w.status} utilization={w.utilization} />
        <span>
          <strong>{pts(w.load)} pts</strong> of planned team work ÷ <strong>{pts(w.plannable)} pts</strong> of members' plannable time on this team
        </span>
      </div>
      <section>
        <h4>Capacity</h4>
        <Bars
          max={max}
          rows={[
            { label: "Members' baseline", value: w.fullBaseline, cls: 'wf-gross' },
            { label: 'OOO', value: w.fullOoo, cls: 'wf-absence', sign: '−' },
            { label: 'Time on other teams', value: w.sharedLost, cls: 'wf-shared', sign: '−' },
            { label: 'Available', value: w.available, cls: 'wf-available', sign: '=' },
            { label: `Buffer (${pct(model.bufferPct)})`, value: w.bufferPoints, cls: 'wf-buffer', sign: '−' },
            { label: 'Plannable', value: w.plannable, cls: 'wf-capacity', sign: '=' },
          ]}
        />
        <h4>Planned load</h4>
        <Bars
          max={max}
          rows={[
            { label: 'Cycle work', value: w.planned, cls: 'swatch-planned' },
            { label: 'Added mid-cycle (unplanned)', value: w.unplanned, cls: 'swatch-unplanned' },
            { label: 'Unscheduled work (spread to date)', value: w.unscheduled, cls: 'swatch-unscheduled' },
          ]}
        />
        {w.unassigned > 0.05 && <p className="small muted">{pts(w.unassigned)} pts of this has no assignee; it still counts toward the team.</p>}
        <CalcExplainer items={w.items} bucket={bucket} />
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
                <th className="num">Plannable here</th>
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
        <IssueTable issueIds={byPriority(model, pointsById)} points={pointsById} notes={notes} notesInline showState={false} />
        <p className="muted small">Sorted by priority. "In range" is the share of each issue's remaining points that falls in this period.</p>
      </section>
    </div>
  );
}

function ProjectCellDetail({ teamId, projectKey, bucket }: { teamId: string; projectKey: string; bucket: Bucket }) {
  const { model } = usePlanner();
  const w = teamWindow(model, teamId, bucket.start, bucket.end);
  const items = w.items.filter((i) => (i.projectId ?? NO_PROJECT) === projectKey);
  const points = items.reduce((a, i) => a + i.points, 0);
  const pointsById = Object.fromEntries(sumBy(items, (i) => i.issueId));
  const notes = Object.fromEntries(items.map((i) => [i.issueId, itemNote(model, i, bucket)]));
  const project = projectKey === NO_PROJECT ? null : model.projects.get(projectKey);
  const byPerson = sumBy(items, (i) => i.assigneeId ?? '');
  return (
    <div className="stack drawer-body" data-testid="project-cell-detail">
      <div className="drawer-summary">
        <span>
          <strong>{pts(points)} pts</strong> of {model.teamName(teamId)}'s planned work ÷ <strong>{pts(w.plannable)} pts</strong> plannable team capacity ={' '}
          <strong>{pct(w.plannable > 0 ? points / w.plannable : null)}</strong> of the team's capacity
        </span>
      </div>
      {project && (
        <p className="small muted">
          {project.statusName}
          {project.targetDate ? ` · target ${formatShort(project.targetDate)} ${project.targetDate.slice(0, 4)}` : ' · no target date'} ·{' '}
          <a href={project.url} target="_blank" rel="noreferrer">
            Open in Linear
          </a>
        </p>
      )}
      {!project && <p className="small muted">Work with no project. Data hygiene lists these issues so they can be added to a project in Linear.</p>}
      <section>
        <h4>Who is doing it</h4>
        <ul className="plain small">
          {byPerson.map(([p, n]) => (
            <li key={p || 'none'}>
              <PersonName id={p || null} />: {pts(n)} pts
            </li>
          ))}
        </ul>
        <CalcExplainer items={items} bucket={bucket} />
      </section>
      <section>
        <h4>Issues in this period ({Object.keys(pointsById).length})</h4>
        <IssueTable issueIds={byPriority(model, pointsById)} points={pointsById} notes={notes} notesInline showState={false} showProject={false} />
      </section>
    </div>
  );
}
