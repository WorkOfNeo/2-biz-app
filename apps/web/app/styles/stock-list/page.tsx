"use client";
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';

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

  // Load style_colors for the visible styles
  const styleIds = React.useMemo(() => (styleRows ?? []).map((r: any) => r.id as string).filter(Boolean), [styleRows]);
  const { data: colorRows, mutate: mutateColors } = useSWR(styleIds.length ? ['style_colors:byStyleIds', styleIds.join(',')] : null, async () => {
    const { data, error } = await supabase
      .from('style_colors')
      .select('id, style_id, color, scrape_enabled')
      .in('style_id', styleIds);
    if (error) throw new Error(error.message);
    // Build map: style_id -> colorLower -> row
    const map = new Map<string, Map<string, { id: string; scrape_enabled: boolean | null }>>();
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      const ckey = String(r.color || '').trim().toLowerCase();
      if (!map.has(sid)) map.set(sid, new Map());
      map.get(sid)!.set(ckey, { id: r.id as string, scrape_enabled: (r.scrape_enabled as boolean | null) ?? null });
    }
    return map;
  }, { refreshInterval: 0 });

  async function toggleColorScrape(styleNo: string, color: string, next: boolean) {
    const styleId = styleMetaByNo[styleNo]?.id || null;
    if (!styleId) return;
    const styleMap = colorRows?.get(styleId) || new Map();
    const key = (color || '').trim().toLowerCase();
    const existing = styleMap.get(key) as { id: string } | undefined;
    if (existing?.id) {
      await supabase.from('style_colors').update({ scrape_enabled: next }).eq('id', existing.id);
    } else {
      await supabase.from('style_colors').insert({ style_id: styleId, color, scrape_enabled: next });
    }
    await mutateColors();
  }

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
    return out as Array<{ styleNo: string; colors: Group[] }>;
  }, [groups]);

  const [openSold, setOpenSold] = React.useState<Record<string, boolean>>({});
  const [openPurchase, setOpenPurchase] = React.useState<Record<string, boolean>>({});

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock List</h1>
      </div>

      {groupedByStyle.map(({ styleNo, colors }) => {
        const meta = styleMetaByNo[styleNo] || { name: null, supplier: null, image: null };
        return (
          <div key={styleNo} className="rounded-md border bg-white p-3">
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
                  const styleId = styleMetaByNo[g.styleNo]?.id || null;
                  const cMap = styleId ? (colorRows?.get(styleId) || new Map()) : new Map();
                  const cKey = (g.color || '').trim().toLowerCase();
                  const enabled = styleId ? ((cMap.get(cKey)?.scrape_enabled ?? true) !== false) : true;
                  return (
                    <div key={key} className="grid grid-cols-[0.5fr_1fr] items-start gap-3">
                      {/* Color label + toggle */}
                      <div className="text-sm font-semibold flex items-center gap-2">
                        <span>{g.color}</span>
                        <label className="inline-flex items-center gap-1 text-[11px] font-normal">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => toggleColorScrape(g.styleNo, g.color, e.target.checked)}
                            className="h-3 w-3 accent-slate-900 rounded"
                          />
                          <span>Scrape</span>
                        </label>
                      </div>
                      {/* Sizes table */}
                      <div className="overflow-auto border rounded">
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
                      <div className="col-span-2 text-[10px] text-gray-500 mt-1">Scraped: {new Date(g.scrapedAt).toLocaleString()}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


