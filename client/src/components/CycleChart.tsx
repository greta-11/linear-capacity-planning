import { useState } from 'react';
import { cycleName, type TeamCycleSummary } from '../../../shared/capacity';
import type { Team } from '../../../shared/types';
import { formatRange, pct, pts } from '../format';
import { STATUS_ICON, Swatch, TipRows, useElementWidth, useTipTarget } from './ui';

// Per-cycle load (stacked) against available capacity (line) and Linear's
// velocity-only capacity (dotted). One axis: points.

const SEGMENTS = [
  { key: 'planned', label: 'Planned' },
  { key: 'unplanned', label: 'Unplanned (added mid-cycle)' },
  { key: 'reserve', label: 'Unplanned reserve' },
  { key: 'unassigned', label: 'Unassigned' },
] as const;

/** A round tick step so that 4 steps cover `v`. */
function niceStep(v: number) {
  const raw = Math.max(v, 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export function CycleChart({ team, cycles, selectedId, onSelect }: { team: Team; cycles: TeamCycleSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [asTable, setAsTable] = useState(false);
  const tip = useTipTarget();
  const height = 260;
  const m = { top: 28, right: 12, bottom: 44, left: 40 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const step = niceStep(Math.max(1, ...cycles.flatMap((c) => [c.load, c.capacity, c.linearStyleCapacity ?? 0])) * 1.08);
  const max = step * 4;
  const y = (v: number) => m.top + innerH - (v / max) * innerH;
  const band = innerW / Math.max(1, cycles.length);
  const barW = Math.min(56, band * 0.56);
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const labelEvery = band < 64 ? Math.ceil(64 / band) : 1;

  return (
    <div className="chart">
      <div className="chart-head">
        <div className="legend">
          {SEGMENTS.map((s) => (
            <Swatch key={s.key} kind={s.key} label={s.label} />
          ))}
          <Swatch kind="capacity" label="Available capacity" />
          <Swatch kind="linear" label="Velocity-only capacity (Linear-style)" />
        </div>
        <button className="btn btn-ghost btn-small" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Dates in range</th>
                <th className="num">Members' time</th>
                <th className="num">− Absences</th>
                <th className="num">− Other teams</th>
                <th className="num">Available</th>
                <th className="num">Planned</th>
                <th className="num">Unplanned</th>
                <th className="num">Reserve</th>
                <th className="num">Unassigned</th>
                <th className="num">Load</th>
                <th className="num">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.cycle.id}>
                  <td>{cycleName(c.cycle, team)}</td>
                  <td>{formatRange(c.start, c.end)}</td>
                  <td className="num">{pts(c.fullGross)}</td>
                  <td className="num">{pts(c.fullAbsence)}</td>
                  <td className="num">{pts(c.sharedLost)}</td>
                  <td className="num">{pts(c.capacity)}</td>
                  <td className="num">{pts(c.planned)}</td>
                  <td className="num">{pts(c.unplanned)}</td>
                  <td className="num">{pts(c.reserve)}</td>
                  <td className="num">{pts(c.unassigned)}</td>
                  <td className="num">{pts(c.load)}</td>
                  <td className="num">{pct(c.utilization)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="chart-svg-wrap">
          <svg width={width} height={height} role="img" aria-label={`${team.name} load vs capacity per cycle`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="grid" />
                <text x={m.left - 6} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">
                  {Math.round(t)}
                </text>
              </g>
            ))}
            <text x={m.left - 6} y={m.top - 14} className="axis" textAnchor="end">
              pts
            </text>
            {cycles.map((c, i) => {
              const cx = m.left + band * i + band / 2;
              const x = cx - barW / 2;
              const values = { planned: c.planned, unplanned: c.unplanned, reserve: c.reserve, unassigned: c.unassigned };
              const visible = SEGMENTS.filter((s) => values[s.key] > 0.01);
              let acc = 0;
              const selected = c.cycle.id === selectedId;
              const content = (
                <TipRows
                  title={`${cycleName(c.cycle, team)} · ${formatRange(c.start, c.end)}${c.isActive ? ' (active, remaining days)' : ''}`}
                  rows={[
                    { label: `utilization · ${STATUS_ICON[c.status]} ${c.status}`, value: pct(c.utilization), strong: true },
                    { label: 'load', value: `${pts(c.load)} pts` },
                    ...SEGMENTS.map((s) => ({ key: s.key, label: s.label.toLowerCase(), value: pts(values[s.key]) })),
                    { key: 'capacity', label: 'available capacity', value: pts(c.capacity) },
                    { label: 'members’ full time', value: pts(c.fullGross) },
                    { label: 'lost to absences', value: `−${pts(c.fullAbsence)}` },
                    { label: 'members’ time on other teams', value: `−${pts(c.sharedLost)}` },
                    ...(c.linearStyleCapacity != null ? [{ key: 'linear', label: 'velocity-only (Linear-style)', value: pts(c.linearStyleCapacity) }] : []),
                  ]}
                />
              );
              return (
                <g
                  key={c.cycle.id}
                  className={`bar-group ${selected ? 'bar-selected' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${cycleName(c.cycle, team)}: ${pct(c.utilization)} utilization`}
                  onClick={() => onSelect(c.cycle.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(c.cycle.id)}
                  data-testid={`cycle-bar-${c.cycle.number}`}
                  {...tip(content)}
                >
                  <rect x={m.left + band * i} y={m.top} width={band} height={innerH} className="hit" />
                  {selected && <rect x={x - 6} y={m.top - 2} width={barW + 12} height={innerH + 4} rx={6} className="select-ring" />}
                  {visible.map((s, j) => {
                    const v = values[s.key];
                    const top = y(acc + v);
                    const bottom = y(acc);
                    acc += v;
                    const gap = j > 0 ? 2 : 0;
                    const h = Math.max(1, bottom - top - gap);
                    const isTop = j === visible.length - 1;
                    return isTop ? (
                      <path key={s.key} d={roundedTop(x, top, barW, h, 4)} className={`seg seg-${s.key}`} />
                    ) : (
                      <rect key={s.key} x={x} y={top} width={barW} height={h} className={`seg seg-${s.key}`} />
                    );
                  })}
                  {c.linearStyleCapacity != null && (
                    <line x1={cx - barW / 2 - 8} x2={cx + barW / 2 + 8} y1={y(c.linearStyleCapacity)} y2={y(c.linearStyleCapacity)} className="mark-linear" />
                  )}
                  <line x1={cx - barW / 2 - 8} x2={cx + barW / 2 + 8} y1={y(c.capacity)} y2={y(c.capacity)} className="mark-capacity" />
                  <text x={cx} y={Math.min(y(Math.max(c.load, c.capacity, c.linearStyleCapacity ?? 0)) - 8, m.top + innerH - 4)} textAnchor="middle" className={`bar-label bar-label-${c.status}`}>
                    {STATUS_ICON[c.status]} {pct(c.utilization)}
                  </text>
                  {i % labelEvery === 0 && (
                    <>
                      <text x={cx} y={height - m.bottom + 16} textAnchor="middle" className="axis axis-strong">
                        {c.cycle.name ?? `Cycle ${c.cycle.number}`}
                        {c.isActive ? ' •' : ''}
                      </text>
                      <text x={cx} y={height - m.bottom + 30} textAnchor="middle" className="axis">
                        {formatRange(c.start, c.end)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
