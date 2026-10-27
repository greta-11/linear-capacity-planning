import { useEffect, useRef, useState } from 'react';

// Compact multi-select: a button that opens a checkbox list with a search box.

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: { id: string; label: string; hint?: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const selected = new Set(value);
  const shown = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const summary = value.length === 0 ? 'All' : value.length === 1 ? (options.find((o) => o.id === value[0])?.label ?? '1 selected') : `${value.length} selected`;
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="field multiselect" ref={ref}>
      <span>{label}</span>
      <button type="button" className={`ms-button ${value.length ? 'ms-active' : ''}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        <span className="ms-summary">{summary}</span> <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ms-pop" role="listbox" aria-multiselectable="true">
          {options.length > 6 && <input className="ms-search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />}
          <div className="ms-list">
            {shown.map((o) => (
              <label key={o.id} className="ms-option">
                <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
                <span>{o.label}</span>
                {o.hint && <span className="muted small ms-hint">{o.hint}</span>}
              </label>
            ))}
            {!shown.length && <div className="muted small ms-empty">No matches</div>}
          </div>
          {value.length > 0 && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
