"use client";
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';
import { useRoles } from '../../../lib/supabaseClient';

type Row = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  po_link: string | null;
  scraped_at: string;
};

export default function StockListPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  const [searchQuery, setSearchQuery] = React.useState<string>('');
  const { data } = useSWR('style_stock:list', async () => {
    const pageSize = 2000;
    const cap = 50000; // avoid runaway
    let from = 0;
    const rows: any[] = [];
    while (from < cap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, po_link, scraped_at')
        .order('scraped_at', { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return rows as Row[];
  }, { refreshInterval: 30000 });

  // Collect distinct style numbers from current data
  const styleNos = React.useMemo(() => Array.from(new Set((data ?? []).map((r) => r.style_no))), [data]);
  // Lookup style names/images for those style numbers
  const { data: styleRows } = useSWR(styleNos.length ? ['styles:byNo', styleNos.join(',')] : null, async () => {
    const { data: rows, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, dg')
      .in('style_no', styleNos);
    if (error) throw new Error(error.message);
    return rows as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; dg?: string | null }>;
  }, { refreshInterval: 0 });
  const styleMetaByNo = React.useMemo(() => {
    const m: Record<string, { id: string | null; name: string | null; supplier: string | null; image: string | null; dg?: string | null }> = {};
    for (const r of (styleRows ?? []) as any[]) {
      m[r.style_no] = { id: r.id || null, name: r.style_name || null, supplier: r.supplier || null, image: r.image_url || null, dg: (r as any).dg ?? null };
    }
    return m;
  }, [styleRows]);
  const styleIds = React.useMemo(() => (styleRows ?? []).map((r: any) => r.id as string).filter(Boolean), [styleRows]);

  // Seasons list for chips and selector
  const { data: seasons } = useSWR('seasons:list', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').order('year', { ascending: false }).order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; year: number | null }>;
  }, { refreshInterval: 0 });

  // Colors → ids for seasons mapping
  const { data: styleColors } = useSWR(styleIds.length ? ['style_colors:ids', styleIds.join(',')] : null, async () => {
    const { data, error } = await supabase.from('style_colors').select('id, style_id, color').in('style_id', styleIds);
    if (error) throw new Error(error.message);
    const map = new Map<string, Map<string, string>>(); // style_id -> (colorLower -> style_color_id)
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      const ckey = String(r.color || '').trim().toLowerCase();
      if (!map.has(sid)) map.set(sid, new Map());
      map.get(sid)!.set(ckey, r.id as string);
    }
    return map;
  }, { refreshInterval: 0 });

  // style_color_id -> seasons (computed after groups is defined)
  let colorIds: string[] = [];

  const { data: colorSeasons, mutate: mutateColorSeasons } = useSWR(colorIds.length ? ['style_color_seasons:byColorIds', colorIds.join(',')] : null, async () => {
    const { data, error } = await supabase
      .from('style_color_seasons')
      .select('style_color_id, season_id')
      .in('style_color_id', colorIds)
      .limit(100000);
    if (error) throw new Error(error.message);
    const map = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const set = map.get(r.style_color_id) || new Set<string>();
      set.add(r.season_id);
      map.set(r.style_color_id, set);
    }
    return map as Map<string, Set<string>>;
  }, { refreshInterval: 0 });

  // Removed per-user selection and view toggles

  type Group = {
    styleNo: string;
    color: string;
    sizes: string[];
    stock: number[];
    soldSum: number[];
    purchaseSum: number[];
    available: number[];
    soldRows: Row[];
    purchaseRows: Row[];
    scrapedAt: string;
  };
  const ensureNums = (arr: any[], len: number) => Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
  const groups: Group[] = React.useMemo(() => {
    const res: Group[] = [];
    // Build map style->color->rows and pick latest per (section,row_label)
    const byStyle = new Map<string, Map<string, Row[]>>();
    for (const r of (data ?? [])) {
      if (!byStyle.has(r.style_no)) byStyle.set(r.style_no, new Map());
      const byColor = byStyle.get(r.style_no)!;
      if (!byColor.has(r.color)) byColor.set(r.color, []);
      byColor.get(r.color)!.push(r);
    }
    for (const [styleNo, byColor] of byStyle.entries()) {
      for (const [color, rows] of byColor.entries()) {
        if (rows.length === 0) continue;
        // latest per (section,row_label)
        const latestMap = new Map<string, Row>();
        for (const r of rows) {
          const key = `${r.section}|${r.row_label ?? ''}`;
          const curr = latestMap.get(key);
          if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) latestMap.set(key, r);
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
        const latestAt = latestRows.reduce((max, r) => (new Date(r.scraped_at).getTime() > new Date(max).getTime() ? r.scraped_at : max), latestRows[0]?.scraped_at || new Date(0).toISOString());
        res.push({ styleNo, color, sizes, stock, soldSum, purchaseSum, available, soldRows, purchaseRows, scrapedAt: latestAt });
      }
    }
    // Sort by style then color for deterministic order
    res.sort((a, b) => (a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color)));
    return res;
  }, [data]);

  // Now that groups are available, compute style_color_ids we need seasons for
  colorIds = React.useMemo(() => {
    const out: string[] = [];
    for (const r of (styleRows ?? []) as any[]) {
      const sid = r.id as string;
      const cmap = styleColors?.get(sid) || new Map<string, string>();
      for (const g of groups.filter((gr) => styleMetaByNo[gr.styleNo]?.id === sid)) {
        const id = cmap.get((g.color || '').trim().toLowerCase());
        if (id) out.push(id);
      }
    }
    return Array.from(new Set(out));
  }, [groups, styleRows, styleColors, styleMetaByNo]);

  // Load visibility flags for colors for styles shown
  const { data: colorVisibility } = useSWR(styleIds.length ? ['style_colors:visible', styleIds.join(',')] : null, async () => {
    // Chunk large IN lists to avoid long URLs (400 Bad Request)
    async function fetchChunks<T extends { style_id: string; color: string; visible?: boolean | null }>(
      selectCols: string
    ): Promise<T[]> {
      const ids = styleIds.slice();
      const out: T[] = [];
      const chunkSize = 50;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('style_colors')
          .select(selectCols)
          .in('style_id', chunk);
        if (error) throw error as any;
        out.push(...(((data ?? []) as unknown) as T[]));
      }
      return out;
    }
    async function loadWithVisible(): Promise<Map<string, Map<string, boolean>>> {
      const rows = await fetchChunks<{ style_id: string; color: string; visible: boolean | null }>('style_id, color, visible');
      const map = new Map<string, Map<string, boolean>>();
      for (const r of rows) {
        const sid = String(r.style_id || '');
        const ckey = String(r.color || '').trim().toLowerCase();
        if (!map.has(sid)) map.set(sid, new Map());
        map.get(sid)!.set(ckey, (r.visible as boolean | null) !== false);
      }
      return map;
    }
    try {
      return await loadWithVisible();
    } catch (e: any) {
      // Fallback if column is missing or any error occurs
      const rows = await fetchChunks<{ style_id: string; color: string }>('style_id, color');
      const map = new Map<string, Map<string, boolean>>();
      for (const r of rows) {
        const sid = String(r.style_id || '');
        const ckey = String(r.color || '').trim().toLowerCase();
        if (!map.has(sid)) map.set(sid, new Map());
        map.get(sid)!.set(ckey, true);
      }
      return map;
    }
  }, { refreshInterval: 0 });

  // Group merged rows by style, then list colors within
  const groupedByStyle = React.useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const g of groups) {
      if (!map.has(g.styleNo)) map.set(g.styleNo, []);
      map.get(g.styleNo)!.push(g);
    }
    const out = Array.from(map.entries()).map(([styleNo, list]) => ({ styleNo, colors: list.sort((a, b) => a.color.localeCompare(b.color)) }));
    // Sort styles numerically-then-lexicographically
    out.sort((a, b) => a.styleNo.localeCompare(b.styleNo));
    // Filter colors by visibility (if defined); default visible
    const filtered = out.map((row) => {
      const sid = styleMetaByNo[row.styleNo]?.id || null;
      if (!sid) return row;
      const visMap = colorVisibility?.get(sid) || new Map<string, boolean>();
      const colors = row.colors.filter((c) => {
        const key = (c.color || '').trim().toLowerCase();
        const vis = visMap.has(key) ? (visMap.get(key) as boolean) : true;
        return vis;
      });
      return { ...row, colors };
    });
    return filtered as Array<{ styleNo: string; colors: Group[] }>;
  }, [groups, colorVisibility, styleMetaByNo]);

  const [openSold, setOpenSold] = React.useState<Record<string, boolean>>({});
  const [openPurchase, setOpenPurchase] = React.useState<Record<string, boolean>>({});

  // Load style lists (visible to all)
  const { data: styleLists } = useSWR('app-settings:style-lists', async () => {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'style_lists').maybeSingle();
    const lists = (((data as any)?.value || {}) as { lists?: Record<string, string[]> }).lists || {};
    return lists as Record<string, string[]>;
  });
  const [activeList, setActiveList] = React.useState<string>('');
  React.useEffect(() => {
    if (styleLists && activeList === '') {
      // default remains 'All' (empty denotes All)
    }
  }, [styleLists, activeList]);

  // Filter rows based on active Style List and search
  const filteredForView = React.useMemo(() => {
    let base = groupedByStyle;
    if (activeList && styleLists) {
      const list = (styleLists[activeList] || []) as string[];
      base = base.filter(({ styleNo }) => list.includes(styleNo));
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(({ styleNo, colors }) => {
      const name = styleMetaByNo[styleNo]?.name || '';
      if (styleNo.toLowerCase().includes(q) || (name || '').toLowerCase().includes(q)) return true;
      return colors.some((c) => (c.color || '').toLowerCase().includes(q));
    });
  }, [groupedByStyle, activeList, styleLists, searchQuery, styleMetaByNo]);

  const emptyState: JSX.Element | null = React.useMemo(() => {
    if (activeList && filteredForView.length === 0) {
      return <div className="text-sm text-gray-600">No stock data yet for styles in the selected list.</div>;
    }
    if (filteredForView.length === 0) {
      return <div className="text-sm text-gray-600">No scraped stock data available yet.</div>;
    }
    return null;
  }, [activeList, filteredForView.length]);

  return (
    <div className="space-y-4 sl-root">
      <div>
        <div className="text-xs text-gray-500 sl-header-eyebrow">Styles</div>
        <h1 className="text-xl font-semibold sl-header-title">Stock List</h1>
      </div>

      <div className="flex items-center justify-between gap-3 sl-controls">
        <div className="flex items-center gap-2 sl-lists">
          <button
            className={(activeList===''?'bg-slate-900 text-white ':'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded sl-list-chip sl-list-all'}
            onClick={()=>setActiveList('')}
          >All</button>
          {Object.keys(styleLists || {}).map((name) => (
            <button key={name} className={(activeList===name?'bg-slate-900 text-white ':'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded sl-list-chip'} onClick={()=>setActiveList(name)}>{name}</button>
          ))}
        </div>
        <div className="sl-search">
          <input
            className="text-xs border rounded px-2 py-1 w-56 sl-search-input"
            placeholder="Search style no, name or color…"
            value={searchQuery}
            onChange={(e)=>setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Main content */}
      <div className="space-y-4 sl-main">
      {emptyState || filteredForView.map(({ styleNo, colors }) => {
        const meta = styleMetaByNo[styleNo] || { name: null, supplier: null, image: null };
        return (
          <div key={styleNo} id={`style-${styleNo}`} className="bg-white p-3 space-y-3 sl-style">
            <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4 sl-style-grid">
              {/* Left: style header */}
              <div className="sl-style-left">
                <div className="flex items-start gap-3 sl-style-header">
                  <div className="shrink-0 sl-style-image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {meta.image ? <img src={meta.image} alt={meta.name ?? styleNo} className="h-20 w-20 object-cover rounded border" /> : <div className="h-20 w-20 rounded border bg-gray-50" />}
                  </div>
                  <div className="min-w-0 sl-style-meta">
                    <div className="text-xs text-gray-500 sl-style-no">{styleNo}</div>
                    <div className="text-base font-semibold text-black truncate sl-style-name">{meta.name ?? '—'}</div>
                    {meta.supplier && <div className="text-xs text-gray-500 sl-style-supplier">{meta.supplier}</div>}
                    {styleMetaByNo[styleNo]?.dg && (
                      <div className="text-[11px] text-gray-600 sl-style-dg">DG: <span className="font-medium">{styleMetaByNo[styleNo]?.dg}</span></div>
                    )}
                  </div>
                </div>
              </div>
              {/* Right: per-color tables */}
              <div className="space-y-4 sl-color-sections">
              {colors.map((g) => {
                const key = `${g.styleNo}:${g.color}`;
                const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
                const stockTotal = sum(g.stock);
                const soldTotal = sum(g.soldSum);
                const purchaseTotal = sum(g.purchaseSum);
                const availableTotal = sum(g.available);
                return (
                  <div key={key} className="space-y-1 sl-color-block">
                    {/* Seasons chips and add control */}
                    <div className="flex flex-wrap items-center gap-1 sl-season-chips">
                        {(() => {
                          const sid = styleMetaByNo[g.styleNo]?.id || null;
                          const cmap = sid ? (styleColors?.get(sid) || new Map<string, string>()) : new Map<string, string>();
                          const scId = cmap.get((g.color || '').trim().toLowerCase()) || null;
                          const set = (scId && colorSeasons) ? (colorSeasons.get(scId) || new Set<string>()) : new Set<string>();
                          const labels = (seasons || []).filter(s => set.has(s.id));
                          return (
                            <>
                              {labels.map((s) => (
                                <span key={s.id} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] sl-season-chip">
                                  <span>{s.name}{s.year ? ` ${s.year}` : ''}</span>
                                  {!has('salesman') && (
                                    <button
                                      className="text-gray-500 hover:text-black sl-season-remove"
                                      onClick={async () => {
                                        if (!scId) return;
                                        await supabase.from('style_color_seasons').delete().eq('style_color_id', scId).eq('season_id', s.id);
                                        await mutateColorSeasons();
                                      }}
                                      title="Remove"
                                    >×</button>
                                  )}
                                </span>
                              ))}
                              {!has('salesman') && scId && (
                                <SeasonAdder
                                  // @ts-ignore
                                  className="sl-season-adder"
                                  seasons={seasons || []}
                                  selected={set}
                                  onAdd={async (seasonId) => {
                                    if (!seasonId) return;
                                    await supabase.from('style_color_seasons').insert({ style_color_id: scId, season_id: seasonId });
                                    await mutateColorSeasons();
                                  }}
                                />
                              )}
                            </>
                          );
                        })()}
                    </div>
                    {/* Sizes table with image + color columns */}
                    <div className="overflow-auto sl-table-wrap">
                      <table className="min-w-full text-xs sl-table">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="p-2 text-left border-b sl-th sl-th-color" style={{ width: 140 }}>Color</th>
                            <th className="p-2 text-left border-b whitespace-nowrap sl-th sl-th-section" style={{ width: 160 }}>Section</th>
                            {g.sizes.map((s, i) => (
                              <th key={i} className="p-2 text-right border-b sl-th sl-th-size" style={{ width: 64 }}>{s}</th>
                            ))}
                            <th className="p-2 text-right border-b sl-th sl-th-total" style={{ width: 72 }}>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="sl-row sl-row-stock">
                            <td className="p-2 border-b align-top sl-cell sl-cell-color" rowSpan={4} style={{ width: 140 }}>{g.color}</td>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Stock</td>
                            {g.stock.map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-black sl-cell sl-cell-size" style={{ width: 64 }}>{v}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-black sl-cell sl-cell-total" style={{ width: 72 }}>{stockTotal}</td>
                          </tr>
                          <tr className="cursor-pointer hover:bg-gray-50 sl-row sl-row-sold-sum" onClick={() => setOpenSold((m) => ({ ...m, [key]: !m[key] }))}>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Sold (sum)</td>
                            {g.soldSum.map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-red-600 sl-cell sl-cell-size" style={{ width: 64 }}>{v > 0 ? `-${v}` : v}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-red-700 sl-cell sl-cell-total" style={{ width: 72 }}>{soldTotal > 0 ? `-${soldTotal}` : soldTotal}</td>
                          </tr>
                          {openSold[key] && g.soldRows.map((r, idx) => (
                            <tr key={`sold-${idx}`} className="bg-gray-50 sl-row sl-row-sold-detail">
                              <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>• {r.row_label ?? 'Row'}</td>
                              {g.soldSum.map((_, i) => (
                                <td key={i} className="p-2 border-b text-right text-red-600 sl-cell sl-cell-size" style={{ width: 64 }}>{(r.values[i] ?? 0) > 0 ? `-${r.values[i] ?? 0}` : (r.values[i] ?? 0)}</td>
                              ))}
                              <td className="p-2 border-b text-right text-red-700 sl-cell sl-cell-total" style={{ width: 72 }}>{(() => { const val = sum((r.values as any[]) || []); return val > 0 ? `-${val}` : val; })()}</td>
                            </tr>
                          ))}
                          <tr className="cursor-pointer hover:bg-gray-50 sl-row sl-row-purchase-sum" onClick={() => setOpenPurchase((m) => ({ ...m, [key]: !m[key] }))}>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Purchase (sum)</td>
                            {g.purchaseSum.map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-green-700 sl-cell sl-cell-size" style={{ width: 64 }}>{v}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-green-800 sl-cell sl-cell-total" style={{ width: 72 }}>{purchaseTotal}</td>
                          </tr>
                          {openPurchase[key] && g.purchaseRows.map((r, idx) => (
                            <tr key={`purchase-${idx}`} className="bg-gray-50 sl-row sl-row-purchase-detail">
                              <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>• {r.row_label ?? 'Row'}</td>
                              {g.purchaseSum.map((_, i) => (
                                <td key={i} className="p-2 border-b text-right text-green-700 sl-cell sl-cell-size" style={{ width: 64 }}>{r.values[i] ?? 0}</td>
                              ))}
                              <td className="p-2 border-b text-right text-green-800 sl-cell sl-cell-total" style={{ width: 72 }}>{sum((r.values as any[]) || [])}</td>
                            </tr>
                          ))}
                          <tr className="sl-row sl-row-available">
                            <td className="p-2 whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Available</td>
                            {g.available.map((v, i) => (
                              <td key={i} className={"p-2 text-right font-semibold sl-cell sl-cell-size " + (v < 0 ? 'text-red-700' : (v > 0 ? 'text-green-800' : '') )} style={{ width: 64 }}>{v}</td>
                            ))}
                            <td className={"p-2 text-right font-semibold sl-cell sl-cell-total " + (availableTotal < 0 ? 'text-red-700' : (availableTotal > 0 ? 'text-green-800' : '') )} style={{ width: 72 }}>{availableTotal}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function SeasonAdder({ seasons, selected, onAdd }: { seasons: Array<{ id: string; name: string; year: number | null }>; selected: Set<string>; onAdd: (seasonId: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const list = React.useMemo(() => {
    const base = seasons.filter((s) => !selected.has(s.id));
    const qq = q.trim().toLowerCase();
    if (!qq) return base.slice(0, 20);
    return base.filter((s) => (s.name || '').toLowerCase().includes(qq) || String(s.year || '').includes(qq)).slice(0, 20);
  }, [seasons, selected, q]);
  return (
    <div className="relative inline-block sl-season-adder">
      <button className="text-[11px] border rounded px-1.5 py-0.5 sl-season-adder-trigger" onClick={() => setOpen((v) => !v)}>+ Season</button>
      {open && (
        <div className="absolute z-10 mt-1 w-56 rounded border bg-white shadow p-1 sl-season-adder-popover">
          <input className="w-full border rounded px-2 py-1 text-[12px] mb-1 sl-season-adder-search" placeholder="Search seasons" value={q} onChange={(e)=>setQ(e.target.value)} />
          <div className="max-h-48 overflow-auto sl-season-adder-list">
            {list.length === 0 && <div className="px-2 py-1 text-[12px] text-gray-500 sl-season-adder-empty">No matches</div>}
            {list.map((s) => (
              <button key={s.id} className="block w-full text-left px-2 py-1 text-[12px] hover:bg-gray-50 sl-season-adder-item" onClick={()=>{ onAdd(s.id); setOpen(false); setQ(''); }}>
                {s.name}{s.year ? ` ${s.year}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


