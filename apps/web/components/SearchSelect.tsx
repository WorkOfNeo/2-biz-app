'use client';
import * as React from 'react';

type Item = {
  value: string;
  label: string;
  description?: string | null;
};

export function SearchSelect({
  items,
  value,
  onChange,
  placeholder = 'Select…',
  className = '',
  clearable = true,
}: {
  items: Item[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  clearable?: boolean;
}) {
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [hoverIdx, setHoverIdx] = React.useState<number>(-1);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const selected = items.find((it) => it.value === value) || null;
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const s1 = it.label.toLowerCase();
      const s2 = (it.description || '').toLowerCase();
      const s3 = (it.value || '').toLowerCase();
      return s1.includes(q) || s2.includes(q) || s3.includes(q);
    });
  }, [items, query]);
  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  function commit(next: string) {
    onChange(next);
    setOpen(false);
    setQuery('');
    setHoverIdx(-1);
  }
  const display = selected ? selected.label : placeholder;
  return (
    <div ref={containerRef} className={'relative ' + className}>
      <button
        ref={buttonRef}
        type="button"
        className="text-xs border rounded px-2 py-1 bg-white min-w-[12rem] flex items-center justify-between gap-2"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selected ? '' : 'text-gray-500'}>{display}</span>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.086l3.71-3.855a.75.75 0 111.08 1.04l-4.24 4.4a.75.75 0 01-1.08 0l-4.24-4.4a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-[min(24rem,calc(100vw-2rem))] max-w-[24rem] rounded-md border bg-white shadow">
          <div className="p-2 border-b">
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHoverIdx(0); }}
              placeholder="Search…"
              className="w-full text-xs border rounded px-2 py-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHoverIdx((i) => Math.min((i < 0 ? -1 : i) + 1, filtered.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setHoverIdx((i) => Math.max((i < 0 ? filtered.length : i) - 1, 0)); }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const it = filtered[Math.max(0, hoverIdx)];
                  if (it) commit(it.value);
                }
                if (e.key === 'Escape') { setOpen(false); }
              }}
            />
          </div>
          <div className="max-h-64 overflow-auto">
            {clearable && (
              <button
                className={"w-full text-left px-2 py-1.5 text-[11px] hover:bg-gray-50 " + (value === '' ? 'bg-gray-50' : '')}
                onClick={() => commit('')}
              >
                Clear (All)
              </button>
            )}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-gray-500">No results.</div>
            )}
            {filtered.map((it, idx) => {
              const active = idx === hoverIdx;
              const selected = value === it.value;
              return (
                <button
                  key={it.value}
                  className={"w-full text-left px-2 py-1.5 text-xs hover:bg-gray-50 " + (active ? 'bg-gray-50 ' : '')}
                  onMouseEnter={() => setHoverIdx(idx)}
                  onClick={() => commit(it.value)}
                >
                  <div className="flex items-center justify-between">
                    <div className="truncate">{it.label}</div>
                    {selected && <span className="ml-2 text-[10px] text-gray-500">Selected</span>}
                  </div>
                  {it.description ? <div className="text-[11px] text-gray-500 truncate">{it.description}</div> : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}


