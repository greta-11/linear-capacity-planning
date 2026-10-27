import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Status } from '../../../shared/capacity';
import { cycleName } from '../../../shared/capacity';
import { usePlanner } from '../context';
import { pct, pts, STATUS_LABEL } from '../format';

export const PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

export const STATUS_ICON: Record<Status, string> = { none: '·', under: '○', healthy: '✓', 'at-risk': '!', over: '▲' };

export function StatusPill({ status, utilization }: { status: Status; utilization?: number | null }) {
  return (
    <span className={`pill pill-${status}`} title={STATUS_LABEL[status]}>
      <span aria-hidden className="pill-icon">
        {STATUS_ICON[status]}
      </span>
      {utilization !== undefined ? pct(utilization) : STATUS_LABEL[status]}
      {utilization !== undefined && <span className="sr-only"> {STATUS_LABEL[status]}</span>}
    </span>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' | 'good' }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Swatch({ kind, label }: { kind: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`swatch swatch-${kind}`} aria-hidden />
      {label}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PersonName({ id }: { id: string | null }) {
  const { model } = usePlanner();
  if (!id) return <span className="muted">Unassigned</span>;
  const p = model.people.get(id);
  return <span className="person">{p ? p.name : 'Unknown'}</span>;
}

export function CycleLabel({ id }: { id: string | null }) {
  const { model } = usePlanner();
  if (!id) return <span className="muted">No cycle</span>;
  const c = model.cycles.get(id);
  if (!c) return <span className="muted">Unknown cycle</span>;
  return (
    <span className="nowrap" title={`${c.startDate} → ${c.endDate}`}>
      {cycleName(c, model.teams.get(c.teamId))}
    </span>
  );
}

export function IssueLink({ id }: { id: string }) {
  const { model } = usePlanner();
  const issue = model.issues.get(id);
  if (!issue) return <span className="muted">{id}</span>;
  return (
    <a href={issue.url} target="_blank" rel="noreferrer" className="issue-link">
      {issue.identifier}
    </a>
  );
}

/** Issues with the fields that matter for capacity. `points` overrides the shown points (e.g. prorated). */
export function IssueTable({
  issueIds,
  highlight,
  notes,
  points,
  showCycle = true,
  showAssignee = true,
  showProject = true,
  showState = true,
  showPriority = true,
  notesInline = false,
}: {
  issueIds: string[];
  highlight?: Set<string>;
  notes?: Record<string, string>;
  points?: Record<string, number>;
  showCycle?: boolean;
  showAssignee?: boolean;
  showProject?: boolean;
  showState?: boolean;
  showPriority?: boolean;
  /** Show notes as a second line under the title instead of their own column (for narrow panels). */
  notesInline?: boolean;
}) {
  const { model } = usePlanner();
  if (!issueIds.length) return <p className="muted small">No issues.</p>;
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Title</th>
            {showAssignee && <th>Assignee</th>}
            {showCycle && <th>Cycle</th>}
            {showProject && <th>Project</th>}
            {showState && <th>State</th>}
            {showPriority && <th>Priority</th>}
            <th className="num">Estimate</th>
            {points && <th className="num">In range</th>}
            {notes && !notesInline && <th>Note</th>}
          </tr>
        </thead>
        <tbody>
          {issueIds.map((id) => {
            const issue = model.issues.get(id);
            if (!issue) return null;
            const { points: p, unestimated } = model.pointsOf(issue);
            const unplanned = model.unplannedKind(issue) === 'unplanned';
            return (
              <tr key={id} className={highlight?.has(id) ? 'row-highlight' : ''}>
                <td>
                  <IssueLink id={id} />
                </td>
                <td className={notesInline ? 'title-cell' : 'truncate'} title={issue.title}>
                  {issue.title}
                  {unplanned && <span className="tag tag-unplanned">unplanned</span>}
                  {notesInline && notes?.[id] && <div className="muted small issue-note">{notes[id]}</div>}
                </td>
                {showAssignee && (
                  <td>
                    <PersonName id={issue.assigneeId} />
                  </td>
                )}
                {showCycle && (
                  <td>
                    <CycleLabel id={issue.cycleId} />
                  </td>
                )}
                {showProject && <td className="truncate-sm">{issue.projectId ? (model.projects.get(issue.projectId)?.name ?? issue.projectName) : <span className="muted">—</span>}</td>}
                {showState && <td>{issue.stateName}</td>}
                {showPriority && <td>{PRIORITY_LABEL[issue.priority] ?? '—'}</td>}
                <td className="num">{unestimated ? <span className="muted" title="Unestimated: counted at the team median">~{pts(p)}</span> : pts(p)}</td>
                {points && <td className="num">{points[id] != null ? pts(points[id]) : '—'}</td>}
                {notes && !notesInline && <td className="small">{notes[id] ?? ''}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip: one floating layer, content set by hovered/focused marks.

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}
const TipContext = createContext<{ show: (e: { clientX: number; clientY: number }, content: ReactNode) => void; hide: () => void } | null>(null);

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = useCallback((e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14;
    let top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  return (
    <TipContext.Provider value={{ show, hide }}>
      {children}
      {tip &&
        createPortal(
          <div ref={ref} className="tooltip" role="tooltip" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
            {tip.content}
          </div>,
          document.body,
        )}
    </TipContext.Provider>
  );
}

export function useTooltip() {
  const ctx = useContext(TipContext);
  if (!ctx) throw new Error('useTooltip outside TooltipProvider');
  return ctx;
}

/** Props that make an element show `content` on hover and keyboard focus. */
export function useTipTarget() {
  const tip = useTooltip();
  return (content: ReactNode) => ({
    onPointerMove: (e: React.PointerEvent) => tip.show(e, content),
    onPointerLeave: tip.hide,
    onFocus: (e: React.FocusEvent) => {
      const r = (e.currentTarget as Element).getBoundingClientRect();
      tip.show({ clientX: r.left + r.width / 2, clientY: r.top + r.height }, content);
    },
    onBlur: tip.hide,
  });
}

export function TipRows({ title, rows }: { title: ReactNode; rows: { key?: string; label: ReactNode; value: ReactNode; strong?: boolean }[] }) {
  return (
    <div>
      <div className="tip-title">{title}</div>
      {rows.map((r, i) => (
        <div className="tip-row" key={i}>
          <span className={r.key ? `tip-key swatch-${r.key}` : 'tip-key'} aria-hidden />
          <span className={r.strong ? 'tip-value strong' : 'tip-value'}>{r.value}</span>
          <span className="tip-label">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function useElementWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
