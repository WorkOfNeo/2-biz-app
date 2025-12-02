'use client';
import * as React from 'react';

type Item = {
  value: string;
  label: string;
};

export function MultiSelect({
  items,
  values,
  onChange,
  placeholder = 'Select…',
  className = '',
}: {
  items: Item[];
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const s1 = it.label.toLowerCase();
      const s2 = (it.value || '').toLowerCase();
      return s1.includes(q) || s2.includes(q);
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
  
  function toggle(value: string) {
    if (values.includes(value)) {
      onChange(values.filter(v => v !== value));
    } else {
      onChange([...values, value]);
    }
  }
  
  function clearAll() {
    onChange([]);
  }
  
  const display = values.length === 0 
    ? placeholder 
    : values.length === 1 
      ? items.find(it => it.value === values[0])?.label || `${values.length} selected`
      : `${values.length} selected`;
  
  return (
    <div ref={containerRef} className={'relative ' + className}>
      <button
        ref={buttonRef}
        type="button"
        className="text-xs border rounded px-2 py-1 bg-white min-w-[12rem] flex items-center justify-between gap-2"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={values.length === 0 ? 'text-gray-500' : ''}>{display}</span>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.086l3.71-3.855a.75.75 0 111.08 1.04l-4.24 4.4a.75.75 0 01-1.08 0l-4.24-4.4a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-[min(24rem,calc(100vw-2rem))] max-w-[24rem] rounded-md border bg-white shadow">
          <div className="p-2 border-b">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full text-xs border rounded px-2 py-1"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-auto">
            <button
              className="w-full text-left px-2 py-1.5 text-[11px] hover:bg-gray-50"
              onClick={clearAll}
            >
              Clear All
            </button>
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-gray-500">No results.</div>
            )}
            {filtered.map((it) => {
              const selected = values.includes(it.value);
              return (
                <button
                  key={it.value}
                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2"
                  onClick={() => toggle(it.value)}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => {}}
                    className="h-3.5 w-3.5 rounded"
                  />
                  <span className="truncate">{it.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

