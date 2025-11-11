'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';

export default function PurchaseMakeOrderPage() {
  const STORAGE_KEYS = React.useMemo(() => ({
    started: 'makeOrder.process1.started',
    step: 'makeOrder.process1.step',
    returnPath: 'makeOrder.process1.returnPath',
    step1Note: 'makeOrder.process1.step1.note',
    selections: 'makeOrder.process1.step1.selections',
    inputs: 'makeOrder.process1.step2.inputs'
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [step, setStep] = React.useState<number>(1);
  const [note, setNote] = React.useState<string>('');
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  type Selection = { style_no: string; color: string };
  const [selections, setSelections] = React.useState<Selection[]>([]);

  // Load persisted state
  React.useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.started);
      const n = localStorage.getItem(STORAGE_KEYS.step1Note);
      const r = localStorage.getItem(STORAGE_KEYS.returnPath);
      const st = localStorage.getItem(STORAGE_KEYS.step);
      const sel = localStorage.getItem(STORAGE_KEYS.selections);
      if (s === '1') setStarted(true);
      if (typeof n === 'string') setNote(n);
      if (typeof r === 'string') setReturnPath(r);
      if (st) {
        const num = Number(st) || 1;
        setStep(num >= 1 && num <= 2 ? num : 1);
      }
      if (sel) {
        try { setSelections(JSON.parse(sel) as Selection[]); } catch {}
      }
    } catch {}
  }, [STORAGE_KEYS.started, STORAGE_KEYS.step1Note, STORAGE_KEYS.returnPath, STORAGE_KEYS.step, STORAGE_KEYS.selections]);

  // Persist note (debounced)
  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEYS.step1Note, note || '');
        setSavedAt(Date.now());
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [note, STORAGE_KEYS.step1Note]);

  // Persist step/selections
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.step, String(step)); } catch {}
  }, [step, STORAGE_KEYS.step]);
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selections, JSON.stringify(selections)); } catch {}
  }, [selections, STORAGE_KEYS.selections]);

  function startProcess() {
    try {
      // Determine where the user came from (same-origin only)
      let from: string | null = null;
      try {
        const ref = document.referrer || '';
        if (ref) {
          const u = new URL(ref);
          const cur = new URL(window.location.href);
          if (u.origin === cur.origin) from = u.pathname + u.search + u.hash;
        }
      } catch {}
      // Fallback to home if referrer is missing or cross-origin
      if (!from) from = '/';
      localStorage.setItem(STORAGE_KEYS.returnPath, from);
      localStorage.setItem(STORAGE_KEYS.started, '1');
      setReturnPath(from);
      setStarted(true);
      setStep(1);
    } catch {}
  }

  // Sync step with URL slug /purchase/make-order/step/[n]
  React.useEffect(() => {
    try {
      const m = pathname?.match(/\/purchase\/make-order\/step\/(\d+)/i);
      if (m && m[1]) {
        const n = Math.max(1, Math.min(2, Number(m[1]) || 1));
        setStep(n);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  React.useEffect(() => {
    // When step changes and process started, push slug URL for navigation
    if (!started) return;
    const target = `/purchase/make-order/step/${step}`;
    if (pathname !== target) {
      try { router.push(target as any); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, started]);

  // Step 1: choose Styles > Colors
  const [q, setQ] = React.useState('');
  const { data: styleList } = useSWR(started && step === 1 ? ['makeOrder:styles', q] : null, async () => {
    let query = supabase.from('styles').select('id, style_no, style_name, image_url').order('style_no', { ascending: true }).limit(200);
    const qq = q.trim();
    if (qq) {
      // Search by style_no OR style_name
      query = query.or(`style_no.ilike.%${qq}%,style_name.ilike.%${qq}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; style_no: string; style_name: string | null; image_url: string | null }>;
  });
  const colorsCache = React.useRef(new Map<string, string[]>()); // style_id -> colors
  async function loadColorsFor(styleId: string): Promise<string[]> {
    if (colorsCache.current.has(styleId)) return colorsCache.current.get(styleId)!;
    const { data, error } = await supabase.from('style_colors').select('color').eq('style_id', styleId).order('color', { ascending: true });
    if (error) throw new Error(error.message);
    const list = (data ?? []).map((r: any) => (String(r.color || '').trim())).filter(Boolean);
    colorsCache.current.set(styleId, list);
    return list;
  }
  function addSelection(style_no: string, color: string) {
    const key = `${style_no}|${color}`.toLowerCase();
    setSelections((prev) => {
      const set = new Set(prev.map((s) => `${s.style_no}|${s.color}`.toLowerCase()));
      if (set.has(key)) return prev;
      return [...prev, { style_no, color }];
    });
  }
  function removeSelection(style_no: string, color: string) {
    const key = `${style_no}|${color}`.toLowerCase();
    setSelections((prev) => prev.filter((s) => (`${s.style_no}|${s.color}`.toLowerCase()) !== key));
  }

  // Step 2 data: current stock for selected style/color pairs
  type StockRow = { style_no: string; color: string; sizes: string[]; section: string; row_label: string | null; values: number[]; scraped_at: string };
  const selectedStyleNos = React.useMemo(() => Array.from(new Set(selections.map(s => s.style_no))), [selections]);
  const selectedColors = React.useMemo(() => Array.from(new Set(selections.map(s => s.color))), [selections]);
  const { data: stockRows } = useSWR(started && step === 2 && selectedStyleNos.length ? ['makeOrder:stock', selectedStyleNos.join(','), selectedColors.join(',')] : null, async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', selectedStyleNos)
      .in('color', selectedColors);
    if (error) throw new Error(error.message);
    return (data ?? []) as StockRow[];
  });
  const { data: metaRows } = useSWR(started && step === 2 && selectedStyleNos.length ? ['makeOrder:styles:meta', selectedStyleNos.join(',')] : null, async () => {
    const { data, error } = await supabase.from('styles').select('style_no, style_name, image_url').in('style_no', selectedStyleNos);
    if (error) throw new Error(error.message);
    const map = new Map<string, { name: string | null; image: string | null }>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, { name: r.style_name || null, image: r.image_url || null });
    return map;
  });
  const ensureNums = (arr: any[], len: number) => Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
  type Group = { style_no: string; color: string; sizes: string[]; stock: number[]; available: number[] };
  const groups = React.useMemo(() => {
    const want = new Set(selections.map(s => `${s.style_no}|${s.color}`.toLowerCase()));
    const out: Group[] = [];
    const byKey = new Map<string, StockRow[]>();
    for (const r of (stockRows ?? [])) {
      const key = `${r.style_no}|${r.color}`.toLowerCase();
      if (!want.has(key)) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }
    for (const key of Array.from(byKey.keys())) {
      const rows = byKey.get(key)!;
      // latest per (section,row_label)
      const latestMap = new Map<string, StockRow>();
      for (const r of rows) {
        const k = `${r.section}|${r.row_label ?? ''}`;
        const curr = latestMap.get(k);
        if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) latestMap.set(k, r);
      }
      const latestRows = Array.from(latestMap.values());
      const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0] || rows[0])?.sizes || [];
      const num = sizes.length;
      const zero = Array.from({ length: num }, () => 0);
      const stockRow = latestRows.find(r => r.section === 'Stock');
      const stock = stockRow ? ensureNums(Array.isArray(stockRow.values) ? (stockRow.values as any[]) : JSON.parse(String(stockRow.values || '[]')), num) : zero.slice();
      const soldRows = latestRows.filter(r => r.section === 'Sold');
      const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
      const soldSum = soldRows.reduce((acc, r) => {
        const vals = ensureNums(Array.isArray(r.values) ? (r.values as any[]) : JSON.parse(String(r.values || '[]')), num);
        return acc.map((v, i) => v + (vals[i] ?? 0));
      }, zero.slice());
      const purchaseSum = purchaseRows.reduce((acc, r) => {
        const vals = ensureNums(Array.isArray(r.values) ? (r.values as any[]) : JSON.parse(String(r.values || '[]')), num);
        return acc.map((v, i) => v + (vals[i] ?? 0));
      }, zero.slice());
      const available = stock.map((v, i) => v - (soldSum[i] ?? 0) + (purchaseSum[i] ?? 0));
      const [style_no, color] = key.split('|') as [string, string];
      out.push({ style_no, color, sizes, stock, available });
    }
    // Keep order same as selection
    const index = new Map(selections.map((s, i) => [`${s.style_no}|${s.color}`.toLowerCase(), i] as [string, number]));
    out.sort((a, b) => (index.get(`${a.style_no}|${a.color}`.toLowerCase())! - index.get(`${b.style_no}|${b.color}`.toLowerCase())!));
    return out;
  }, [stockRows, selections]);
  // Inputs per group
  const [inputsByKey, setInputsByKey] = React.useState<Record<string, number[]>>({});
  // Load persisted inputs
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.inputs);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, number[]>;
        setInputsByKey(map);
      }
    } catch {}
  }, [STORAGE_KEYS.inputs]);
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.inputs, JSON.stringify(inputsByKey)); } catch {}
  }, [inputsByKey, STORAGE_KEYS.inputs]);

  return (
    <div className="p-4 space-y-4">
      <div className="text-xs text-slate-500">Purchase</div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Make Order</h1>
        {returnPath && (
          <a href={returnPath} className="text-sm underline text-blue-700">Back to previous page</a>
        )}
      </div>

      {!started && (
        <div className="rounded-md border p-4 bg-white">
          <div className="text-sm text-slate-700">Process #1</div>
          <div className="mt-1 text-slate-500 text-sm">Start the guided, multi-step order flow.</div>
          <button
            className="mt-3 rounded border px-3 py-1.5 text-sm bg-slate-900 text-white hover:opacity-90"
            onClick={startProcess}
          >
            Start Process #1
          </button>
        </div>
      )}

      {started && step === 1 && (
        <div className="rounded-md border p-4 bg-white space-y-3">
          <div className="text-lg font-semibold">Welcome to step #1</div>
          <div className="text-sm text-slate-600">
            This step is saved locally. If you leave and come back, your progress remains.
          </div>
          <label className="block text-sm text-slate-700">
            Confirm persistence
            <input
              type="text"
              value={note}
              onChange={(e) => { setNote(e.target.value); setSaving(true); }}
              onBlur={() => setSaving(false)}
              className="mt-1 w-full max-w-md rounded border px-2 py-1 text-sm"
              placeholder="Type something, refresh, and see it persist"
            />
          </label>
          <div className="text-xs text-slate-500">
            {saving ? 'Saving…' : (savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : 'Not saved yet')}
          </div>
          <div className="pt-2">
            <div className="text-sm font-semibold mb-1">Choose Styles → Colors</div>
            <div className="flex items-center gap-2 mb-2">
              <input
                className="rounded border px-2 py-1 text-sm w-64"
                placeholder="Search style no…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(styleList ?? []).map((s) => (
                <StylePickerCard
                  key={s.id}
                  styleNo={s.style_no}
                  styleName={s.style_name || ''}
                  imageUrl={s.image_url || ''}
                  selections={selections}
                  onAdd={addSelection}
                  onRemove={removeSelection}
                  loadColors={() => loadColorsFor(String(s.id))}
                />
              ))}
            </div>
          </div>
          {selections.length > 0 && (
            <div className="flex items-center justify-between pt-3">
              <div className="text-xs text-slate-600">
                Selected: {selections.map(s => `${s.style_no} · ${s.color}`).join(', ')}
              </div>
              <button
                className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white hover:opacity-90"
                onClick={() => setStep(2)}
              >
                Continue to step #2
              </button>
            </div>
          )}
        </div>
      )}

      {started && step === 2 && (
        <div className="rounded-md border p-4 bg-white space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Step #2</div>
            <button className="text-sm underline" onClick={() => setStep(1)}>Back to step #1</button>
          </div>
          <div className="text-sm text-slate-600">
            Review each selected style/color. Only Stock is shown. Enter order quantities per size.
          </div>
          <div className="space-y-8">
            {Array.from(new Map(groups.map(g => [g.style_no, true])).keys()).map((styleNo) => {
              const meta = metaRows?.get(styleNo) || { name: null, image: null };
              const rows = groups.filter(g => g.style_no === styleNo);
              const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
              return (
                <div key={styleNo} className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-3">
                    {/* Image (one per style) */}
                    <div className="md:row-span-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {meta.image ? <img src={meta.image} alt={styleNo} className="h-24 w-24 object-cover rounded border" /> : <div className="h-24 w-24 rounded border bg-gray-50" />}
                    </div>
                    {/* Number + Name */}
                    <div>
                      <div className="text-sm text-slate-500">{styleNo}</div>
                      <div className="text-base font-semibold">{meta.name || '—'}</div>
                    </div>
                  </div>
                  {/* Per-color rows: three columns layout */}
                  <div className="space-y-4">
                    {rows.map((g) => {
                      const key = `${g.style_no}|${g.color}`.toLowerCase();
                      const inputs = (inputsByKey[key] && inputsByKey[key].length === g.sizes.length)
                        ? inputsByKey[key]
                        : Array.from({ length: g.sizes.length }, () => 0);
                      const setInput = (idx: number, val: number) => {
                        setInputsByKey((prev) => {
                          const base = (prev[key] && prev[key].length === g.sizes.length) ? prev[key].slice() : Array.from({ length: g.sizes.length }, () => 0);
                          base[idx] = val;
                          return { ...prev, [key]: base };
                        });
                      };
                      return (
                        <div key={key} className="grid grid-cols-1 md:grid-cols-[120px_1fr_2fr] gap-3">
                          {/* Column 1: empty spacer to align under image */}
                          <div className="hidden md:block" />
                          {/* Column 2: Number + Name + Color */}
                          <div className="space-y-0.5">
                            <div className="text-sm text-slate-500">{g.style_no}</div>
                            <div className="text-sm">{meta.name || '—'}</div>
                            <div className="text-sm text-slate-600">Color: {g.color}</div>
                          </div>
                          {/* Column 3: Sizes & inputs (Stock only + inputs) */}
                          <div className="overflow-auto">
                            <table className="min-w-full text-xs">
                              <thead className="bg-gray-50">
                                <tr>
                                  {g.sizes.map((s, i) => (<th key={i} className="p-2 text-right">{s}</th>))}
                                  <th className="p-2 text-right">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  {g.stock.map((v, i) => (<td key={i} className="p-2 text-right">{v}</td>))}
                                  <td className="p-2 text-right font-medium">{sum(g.stock)}</td>
                                </tr>
                                <tr>
                                  {g.sizes.map((_, i) => (
                                    <td key={i} className="p-2">
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        className="w-20 rounded border px-2 py-1 text-right"
                                        value={inputs[i] ?? 0}
                                        onChange={(e) => setInput(i, Number(e.target.value || 0))}
                                        min={0}
                                      />
                                    </td>
                                  ))}
                                  <td className="p-2 text-right font-semibold">{sum(inputs)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

function StylePickerCard({
  styleNo,
  styleName,
  imageUrl,
  selections,
  onAdd,
  onRemove,
  loadColors
}: {
  styleNo: string;
  styleName: string;
  imageUrl: string;
  selections: Array<{ style_no: string; color: string }>;
  onAdd: (style_no: string, color: string) => void;
  onRemove: (style_no: string, color: string) => void;
  loadColors: () => Promise<string[]>;
}) {
  const [open, setOpen] = React.useState(false);
  const [colors, setColors] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!colors) {
      setLoading(true);
      try { const list = await loadColors(); setColors(list); } finally { setLoading(false); }
    }
  }
  const selectedColors = new Set(selections.filter(s => s.style_no === styleNo).map(s => s.color.toLowerCase()));
  return (
    <div className="border rounded p-3 bg-white">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {imageUrl ? <img src={imageUrl} alt={styleName || styleNo} className="h-12 w-12 object-cover rounded border" /> : <div className="h-12 w-12 rounded border bg-gray-50" />}
        <div className="min-w-0">
          <div className="text-xs text-slate-500">{styleNo}</div>
          <div className="text-sm font-semibold text-black truncate">{styleName || '—'}</div>
        </div>
      </div>
      <div className="mt-2">
        <button className="text-xs underline" onClick={toggle}>{open ? 'Hide colors' : 'Choose colors'}</button>
      </div>
      {open && (
        <div className="mt-2">
          {loading && <div className="text-xs text-slate-500">Loading colors…</div>}
          {colors && colors.length === 0 && <div className="text-xs text-slate-500">No colors found.</div>}
          {colors && colors.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {colors.map((c) => {
                const checked = selectedColors.has(c.toLowerCase());
                return (
                  <label key={c} className="inline-flex items-center gap-1 text-xs border rounded px-1.5 py-0.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => e.target.checked ? onAdd(styleNo, c) : onRemove(styleNo, c)}
                    />
                    <span>{c}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

