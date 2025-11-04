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
  const { data } = useSWR('style_stock:list', async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, po_link, scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }, { refreshInterval: 15000 });

  // Collect distinct style numbers from current data
  const styleNos = React.useMemo(() => Array.from(new Set((data ?? []).map((r) => r.style_no))), [data]);
  // Lookup style names/images for those style numbers
  const { data: styleRows } = useSWR(styleNos.length ? ['styles:byNo', styleNos.join(',')] : null, async () => {
    const { data: rows, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .in('style_no', styleNos);
    if (error) throw new Error(error.message);
    return rows as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null }>;
  }, { refreshInterval: 0 });
  const styleMetaByNo = React.useMemo(() => {
    const m: Record<string, { id: string | null; name: string | null; supplier: string | null; image: string | null }> = {};
    for (const r of (styleRows ?? []) as any[]) {
      m[r.style_no] = { id: r.id || null, name: r.style_name || null, supplier: r.supplier || null, image: r.image_url || null };
    }
    return m;
  }, [styleRows]);
  const styleIds = React.useMemo(() => (styleRows ?? []).map((r: any) => r.id as string).filter(Boolean), [styleRows]);

  // Per-user selection for Default view
  const { data: selectionMap } = useSWR('app-settings:styles-user-selection', async () => {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_user_selection').maybeSingle();
    return ((data?.value as any) || {}) as Record<string, string[]>;
  });
  const [currentUserId, setCurrentUserId] = React.useState<string | null>(null);
  React.useEffect(() => { (async () => { const { data: { session } } = await supabase.auth.getSession(); setCurrentUserId(session?.user?.id ?? null); })(); }, []);
  const userSelected = React.useMemo(() => {
    if (!currentUserId) return new Set<string>();
    const arr = selectionMap?.[currentUserId] || [];
    return new Set<string>(arr);
  }, [selectionMap, currentUserId]);
  const [view, setView] = React.useState<'default' | 'all'>('default');
  const selectionLoading = selectionMap === undefined || currentUserId === null;

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
    // Filter styles by Default view selection
    let filtered = (view === 'default') ? (selectionLoading ? [] : out.filter((row) => userSelected.has(row.styleNo))) : out;
    // Filter colors by visibility (if defined); default visible
    filtered = filtered.map((row) => {
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
  }, [groups, view, userSelected, selectionLoading, colorVisibility, styleMetaByNo]);

  const [openSold, setOpenSold] = React.useState<Record<string, boolean>>({});
  const [openPurchase, setOpenPurchase] = React.useState<Record<string, boolean>>({});

  // Build left sidebar: selected styles grouped by supplier
  const selectedSidebar = React.useMemo(() => {
    const items: Array<{ supplier: string; styleNo: string; name: string | null }> = [];
    for (const styleNo of Array.from(userSelected.values())) {
      const meta = styleMetaByNo[styleNo];
      if (!meta) continue;
      items.push({ supplier: meta.supplier || '—', styleNo, name: meta.name });
    }
    // sort by supplier then style no
    items.sort((a, b) => (a.supplier.localeCompare(b.supplier) || a.styleNo.localeCompare(b.styleNo)));
    // group
    const groups = new Map<string, Array<{ styleNo: string; name: string | null }>>();
    for (const it of items) {
      const arr = groups.get(it.supplier) || [];
      arr.push({ styleNo: it.styleNo, name: it.name });
      groups.set(it.supplier, arr);
    }
    return Array.from(groups.entries()).map(([supplier, list]) => ({ supplier, list }));
  }, [userSelected, styleMetaByNo]);

  // Sidebar colors per style (from current grouped data)
  const colorsByStyleNoSidebar = React.useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const row of groupedByStyle) {
      m[row.styleNo] = row.colors.map((c) => c.color).sort((a, b) => a.localeCompare(b));
    }
    return m;
  }, [groupedByStyle]);

  // Salesman: load style lists and use tabs
  const { data: styleLists } = useSWR(has('salesman') ? 'app-settings:style-lists' : null, async () => {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'style_lists').maybeSingle();
    const lists = (((data as any)?.value || {}) as { lists?: Record<string, string[]> }).lists || {};
    return lists as Record<string, string[]>;
  });
  const [activeList, setActiveList] = React.useState<string>('');
  React.useEffect(() => {
    if (has('salesman') && styleLists && !activeList) {
      const names = Object.keys(styleLists);
      const first = (names.length > 0 ? names[0] : '') as string;
      if (first) setActiveList(first);
    }
  }, [styleLists, activeList, has]);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock List</h1>
      </div>

      {!has('salesman') ? (
        <>
          <div className="flex items-center gap-2">
            <button
              className={(view==='default' ? 'bg-slate-900 text-white ' : 'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded'}
              onClick={() => setView('default')}
            >Default</button>
            <button
              className={(view==='all' ? 'bg-slate-900 text-white ' : 'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded'}
              onClick={() => setView('all')}
            >All</button>
          </div>
          {view==='default' && selectionLoading && (
            <div className="text-xs text-gray-500">Loading your selection…</div>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2">
          {Object.keys(styleLists || {}).map((name) => (
            <button key={name} className={(activeList===name?'bg-slate-900 text-white ':'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded'} onClick={()=>setActiveList(name)}>{name}</button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr] gap-4 items-start">
        {/* Left: selected styles by supplier */}
        {!has('salesman') && (
        <aside className="hidden lg:block sticky top-4 self-start">
          <div className="bg-[#f7f7f7] p-2 max-h-[70vh] overflow-auto">
            <div className="text-xs font-semibold text-gray-700 px-1 pb-1">Your styles</div>
            {selectedSidebar.length === 0 ? (
              <div className="text-[11px] text-gray-500 px-1 py-2">No styles selected.</div>
            ) : (
              <div className="space-y-2">
                {selectedSidebar.map((grp) => (
                  <div key={grp.supplier}>
                    <div className="text-[11px] font-medium text-gray-500 px-1 mb-1">{grp.supplier}</div>
                    <ul className="space-y-0.5">
                      {grp.list.map((it) => (
                        <li key={it.styleNo} className="group">
                          <a
                            href={`#style-${it.styleNo}`}
                            className="block text-xs px-2 py-1 rounded hover:bg-slate-50"
                            title={it.name || it.styleNo}
                          >
                            <span className="text-[12px] text-black">{it.name || it.styleNo}</span>
                          </a>
                          <div className="pl-3 text-[11px] text-gray-600 max-h-0 opacity-0 translate-y-1 overflow-hidden transition-all duration-300 ease-out group-hover:max-h-40 group-hover:opacity-100 group-hover:translate-y-0">
                            {(colorsByStyleNoSidebar[it.styleNo] || []).map((c) => (
                              <a key={c} href={`#style-${it.styleNo}`} className="block py-0.5 hover:underline">{c}</a>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
        )}

        {/* Right: main content */}
        <div className="space-y-4">
      {groupedByStyle
        .filter(({ styleNo }) => {
          if (!has('salesman')) return true;
          const list = (styleLists?.[activeList] || []) as string[];
          return list.includes(styleNo);
        })
        .map(({ styleNo, colors }) => {
        const meta = styleMetaByNo[styleNo] || { name: null, supplier: null, image: null };
        return (
          <div key={styleNo} id={`style-${styleNo}`} className="bg-white p-3">
            <div className="grid grid-cols-[1fr_0.5fr_1fr] gap-3">
              {/* Left: sticky style info */}
              <div className="sticky top-2 self-start">
                <div className="text-xs text-gray-500">{styleNo}</div>
                <div className="text-base font-semibold text-black">{meta.name ?? '—'}</div>
                {meta.supplier && <div className="text-xs text-gray-500">{meta.supplier}</div>}
                {meta.image && (
                  <div className="mt-2 border rounded overflow-hidden w-full max-w-xs">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={meta.image} alt={meta.name ?? styleNo} className="block w-full h-auto object-cover" />
                  </div>
                )}
              </div>

              {/* Middle+Right: repeat per color */}
              <div className="col-span-2 space-y-4">
                {colors.map((g) => {
                  const key = `${g.styleNo}:${g.color}`;
                  const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
                  const stockTotal = sum(g.stock);
                  const soldTotal = sum(g.soldSum);
                  const purchaseTotal = sum(g.purchaseSum);
                  const availableTotal = sum(g.available);
                  return (
                    <div key={key} className="space-y-2">
                      {/* Color heading above table */}
                      <div className="text-sm font-semibold text-black">{g.color}</div>
                      {/* Sizes table */}
                      <div className="overflow-auto">
                        <table className="min-w-full text-xs">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="p-2 text-left border-b">Section</th>
                              {g.sizes.map((s, i) => (
                                <th key={i} className="p-2 text-right border-b">{s}</th>
                              ))}
                              <th className="p-2 text-right border-b">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                        <tr>
                          <td className="p-2 border-b">Stock</td>
                          {g.stock.map((v, i) => (
                            <td key={i} className="p-2 border-b text-right text-black">{v}</td>
                          ))}
                          <td className="p-2 border-b text-right font-medium text-black">{stockTotal}</td>
                        </tr>
                            <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenSold((m) => ({ ...m, [key]: !m[key] }))}>
                              <td className="p-2 border-b">Sold (sum)</td>
                              {g.soldSum.map((v, i) => (
                                <td key={i} className="p-2 border-b text-right text-red-600">{v > 0 ? `-${v}` : v}</td>
                              ))}
                              <td className="p-2 border-b text-right font-medium text-red-700">{soldTotal > 0 ? `-${soldTotal}` : soldTotal}</td>
                            </tr>
                            {openSold[key] && g.soldRows.map((r, idx) => (
                              <tr key={`sold-${idx}`} className="bg-gray-50">
                                <td className="p-2 border-b pl-6">{r.row_label ?? 'Row'}</td>
                              {g.soldSum.map((_, i) => (
                              <td key={i} className="p-2 border-b text-right text-red-600">{(r.values[i] ?? 0) > 0 ? `-${r.values[i] ?? 0}` : (r.values[i] ?? 0)}</td>
                                ))}
                              <td className="p-2 border-b text-right text-red-700">{(() => { const val = sum((r.values as any[]) || []); return val > 0 ? `-${val}` : val; })()}</td>
                              </tr>
                            ))}
                            <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenPurchase((m) => ({ ...m, [key]: !m[key] }))}>
                              <td className="p-2 border-b">Purchase (sum)</td>
                              {g.purchaseSum.map((v, i) => (
                                <td key={i} className="p-2 border-b text-right text-green-700">{v}</td>
                              ))}
                              <td className="p-2 border-b text-right font-medium text-green-800">{purchaseTotal}</td>
                            </tr>
                            {openPurchase[key] && g.purchaseRows.map((r, idx) => (
                              <tr key={`purchase-${idx}`} className="bg-gray-50">
                                <td className="p-2 border-b pl-6">{r.row_label ?? 'Row'}</td>
                              {g.purchaseSum.map((_, i) => (
                              <td key={i} className="p-2 border-b text-right text-green-700">{r.values[i] ?? 0}</td>
                                ))}
                              <td className="p-2 border-b text-right text-green-800">{sum((r.values as any[]) || [])}</td>
                              </tr>
                            ))}
                            <tr>
                              <td className="p-2">Available</td>
                              {g.available.map((v, i) => (
                                <td key={i} className={"p-2 text-right font-semibold " + (v < 0 ? 'text-red-700' : (v > 0 ? 'text-green-800' : ''))}>{v}</td>
                              ))}
                              <td className={"p-2 text-right font-semibold " + (availableTotal < 0 ? 'text-red-700' : (availableTotal > 0 ? 'text-green-800' : ''))}>{availableTotal}</td>
                            </tr>
                          </tbody>
                          <tfoot>
                            <tr className="bg-gray-50">
                              <td className="p-2 font-medium">Σ by size</td>
                              {g.available.map((v, i) => (
                                <td key={i} className={"p-2 text-right font-medium " + (v < 0 ? 'text-red-700' : (v > 0 ? 'text-green-800' : ''))}>{v}</td>
                              ))}
                              <td className={"p-2 text-right font-semibold " + (availableTotal < 0 ? 'text-red-700' : (availableTotal > 0 ? 'text-green-800' : ''))}>{availableTotal}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                      {/* Scraped timestamp removed per request */}
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
    </div>
  );
}


