'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { useRoles } from '../../../lib/supabaseClient';

type Movement = {
  style_no: string;
  color: string;
  size: string;
  prev_value: number | null;
  value: number;
  delta: number;
  scraped_at: string;
};

export default function StockMovementsPage() {
  const { has } = useRoles();
  const isAdmin = has('admin');

  const todayIso = new Date().toISOString().slice(0, 10);
  const last7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [from, setFrom] = React.useState<string>(last7);
  const [to, setTo] = React.useState<string>(todayIso);
  const [styleNo, setStyleNo] = React.useState<string>('');
  const [styleQuery, setStyleQuery] = React.useState<string>('');
  const [comboOpen, setComboOpen] = React.useState<boolean>(false);
  const { data: stylesList } = useSWR(isAdmin ? 'styles:list' : null, async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('style_no, style_name')
      .order('style_no', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_no: string; style_name: string | null }>;
  }, { refreshInterval: 0 });
  const filteredStyles = React.useMemo(() => {
    const q = (styleQuery || '').toLowerCase().trim();
    if (!stylesList) return [] as Array<{ style_no: string; style_name: string | null }>;
    if (!q) return stylesList.slice(0, 50);
    return stylesList.filter(s => (s.style_name || '').toLowerCase().includes(q)).slice(0, 50);
  }, [stylesList, styleQuery]);
  const [color, setColor] = React.useState<string>('');
  const [size, setSize] = React.useState<string>('');

  const { data, error, isLoading } = useSWR(isAdmin ? ['movements', from, to, styleNo, color, size] : null, async () => {
    const fromIso = from ? new Date(from + 'T00:00:00').toISOString() : new Date('1970-01-01').toISOString();
    const toIso = to ? new Date(to + 'T23:59:59').toISOString() : new Date().toISOString();
    let q = supabase
      .from('style_stock_movements')
      .select('style_no,color,size,prev_value,value,delta,scraped_at')
      .gte('scraped_at', fromIso)
      .lte('scraped_at', toIso)
      .order('scraped_at', { ascending: false })
      .limit(2000);
    if (styleNo && styleNo.trim()) q = q.ilike('style_no', `%${styleNo.trim()}%`);
    if (color && color.trim()) q = q.ilike('color', `%${color.trim()}%`);
    if (size && size.trim()) q = q.ilike('size', `%${size.trim()}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as Movement[];
  }, { refreshInterval: 10000 });

  // Map style_no -> style_name for display and grouping by day+style
  const styleNameMap = React.useMemo(() => {
    const m = new Map<string, string>();
    (stylesList || []).forEach((s) => m.set(s.style_no, s.style_name || s.style_no));
    return m;
  }, [stylesList]);

  const grouped = React.useMemo(() => {
    const out: Array<{ day: string; style_no: string; items: Movement[] }> = [];
    const map = new Map<string, { day: string; style_no: string; items: Movement[] }>();
    for (const mv of (data ?? [])) {
      const day = (mv.scraped_at || '').slice(0, 10);
      const key = day + '|' + mv.style_no;
      if (!map.has(key)) map.set(key, { day, style_no: mv.style_no, items: [] });
      map.get(key)!.items.push(mv);
    }
    for (const g of map.values()) {
      g.items.sort((a, b) => (a.color.localeCompare(b.color) || a.size.localeCompare(b.size)));
      out.push(g);
    }
    out.sort((a, b) => (b.day.localeCompare(a.day) || (styleNameMap.get(a.style_no) || a.style_no).localeCompare(styleNameMap.get(b.style_no) || b.style_no)));
    return out;
  }, [data, styleNameMap]);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock Movements</h1>
      </div>
      {!isAdmin && (
        <div className="rounded-md border bg-white p-3 text-sm text-gray-600">Not authorized.</div>
      )}
      {isAdmin && (
        <>
          <div className="rounded-md border bg-white p-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
              <div>
                <label className="block text-xs text-gray-600 mb-1">From</label>
                <input type="date" className="w-full border rounded px-2 py-1 text-sm" value={from} onChange={(e)=>setFrom(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">To</label>
                <input type="date" className="w-full border rounded px-2 py-1 text-sm" value={to} onChange={(e)=>setTo(e.target.value)} />
              </div>
              <div className="relative">
                <label className="block text-xs text-gray-600 mb-1">Style</label>
                <div className="flex gap-2">
                  <input
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="Search by style name"
                    value={styleNo ? (stylesList?.find(s=>s.style_no===styleNo)?.style_name || '') : styleQuery}
                    onChange={(e)=>{ setStyleQuery(e.target.value); setStyleNo(''); setComboOpen(true); }}
                    onFocus={()=>setComboOpen(true)}
                  />
                  {styleNo && (
                    <button className="text-xs border rounded px-2 py-1" onClick={()=>{ setStyleNo(''); setStyleQuery(''); }}>Clear</button>
                  )}
                </div>
                {comboOpen && (
                  <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border bg-white shadow">
                    {filteredStyles.length === 0 && (
                      <div className="px-2 py-1 text-xs text-gray-500">No matches</div>
                    )}
                    {filteredStyles.map((s, i) => (
                      <button
                        type="button"
                        key={s.style_no + String(i)}
                        className="block w-full text-left px-2 py-1 text-sm hover:bg-gray-50"
                        onClick={()=>{ setStyleNo(s.style_no); setStyleQuery(''); setComboOpen(false); }}
                      >
                        <span className="font-medium">{s.style_name || '—'}</span>
                        <span className="ml-2 text-xs text-gray-500">{s.style_no}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Color</label>
                <input className="w-full border rounded px-2 py-1 text-sm" placeholder="optional" value={color} onChange={(e)=>setColor(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Size</label>
                <input className="w-full border rounded px-2 py-1 text-sm" placeholder="optional" value={size} onChange={(e)=>setSize(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {isLoading && <div className="text-sm text-gray-600">Loading…</div>}
            {error && <div className="text-sm text-red-700">{String(error.message || error)}</div>}
            {!isLoading && !error && grouped.length === 0 && <div className="text-sm">No movements in range.</div>}
            {grouped.map((g, idx) => {
              const sizeSet = new Set<string>();
              for (const it of g.items) sizeSet.add(it.size);
              const sizes = Array.from(sizeSet).sort((a,b)=> a.localeCompare(b));
              const net: Record<string, number> = {};
              sizes.forEach((s)=> net[s] = 0);
              for (const it of g.items) net[it.size] = (net[it.size] || 0) + Number(it.delta || 0);
              return (
                <div key={g.day + g.style_no + String(idx)} className="rounded border bg-white overflow-auto">
                  <div className="px-2 py-2 flex items-center justify-between bg-gray-50 border-b">
                    <div className="text-sm font-semibold">{g.day} — {styleNameMap.get(g.style_no) || g.style_no}</div>
                    <div className="text-xs text-gray-600">Changes per size</div>
                  </div>
                  <div className="px-2 py-2">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr>
                          <th className="p-1 text-left border-b">Size</th>
                          {sizes.map((s) => (
                            <th key={s} className="p-1 text-right border-b">{s}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="p-1 border-b text-left">Δ</td>
                          {sizes.map((s) => {
                            const d = net[s] || 0;
                            return (
                              <td key={s} className={`p-1 border-b text-right ${d>0?'text-green-700':d<0?'text-red-700':'text-gray-700'}`}>{d>0?`+${d}`:d}</td>
                            );
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="px-2 pb-2">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="p-1 text-left border-b">Color</th>
                          <th className="p-1 text-left border-b">Size</th>
                          <th className="p-1 text-right border-b">Δ</th>
                          <th className="p-1 text-right border-b">From → To</th>
                          <th className="p-1 text-left border-b">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((m, i) => (
                          <tr key={i}>
                            <td className="p-1 border-b whitespace-nowrap">{m.color}</td>
                            <td className="p-1 border-b whitespace-nowrap">{m.size}</td>
                            <td className={`p-1 border-b text-right ${m.delta>0?'text-green-700':m.delta<0?'text-red-700':'text-gray-700'}`}>{m.delta>0?`+${m.delta}`:m.delta}</td>
                            <td className="p-1 border-b text-right">{(m.prev_value ?? 0)} → {m.value}</td>
                            <td className="p-1 border-b whitespace-nowrap">{new Date(m.scraped_at).toLocaleTimeString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


