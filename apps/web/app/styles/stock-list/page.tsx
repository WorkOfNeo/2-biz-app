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

  const [openSold, setOpenSold] = React.useState<Record<string, boolean>>({});
  const [openPurchase, setOpenPurchase] = React.useState<Record<string, boolean>>({});

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock List</h1>
      </div>

      {groups.map((g) => {
        const key = `${g.styleNo}:${g.color}`;
        return (
          <div key={key} className="rounded-md border bg-white">
            <div className="px-3 py-2 border-b">
              <div className="text-xs text-gray-500">{g.styleNo}</div>
              <div className="text-sm font-semibold text-black">{g.color}</div>
            </div>
            <div className="px-3 py-2">
              <div className="overflow-auto border rounded">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left border-b">Section</th>
                      {g.sizes.map((s, i) => (
                        <th key={i} className="p-2 text-right border-b">{s}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-2 border-b">Stock</td>
                      {g.stock.map((v, i) => (
                        <td key={i} className="p-2 border-b text-right">{v}</td>
                      ))}
                    </tr>
                    <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenSold((m) => ({ ...m, [key]: !m[key] }))}>
                      <td className="p-2 border-b">Sold (sum)</td>
                      {g.soldSum.map((v, i) => (
                        <td key={i} className="p-2 border-b text-right">{v}</td>
                      ))}
                    </tr>
                    {openSold[key] && g.soldRows.map((r, idx) => (
                      <tr key={`sold-${idx}`} className="bg-gray-50">
                        <td className="p-2 border-b pl-6">{r.row_label ?? 'Row'}</td>
                        {g.soldSum.map((_, i) => (
                          <td key={i} className="p-2 border-b text-right">{r.values[i] ?? 0}</td>
                        ))}
                      </tr>
                    ))}
                    <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenPurchase((m) => ({ ...m, [key]: !m[key] }))}>
                      <td className="p-2 border-b">Purchase (sum)</td>
                      {g.purchaseSum.map((v, i) => (
                        <td key={i} className="p-2 border-b text-right">{v}</td>
                      ))}
                    </tr>
                    {openPurchase[key] && g.purchaseRows.map((r, idx) => (
                      <tr key={`purchase-${idx}`} className="bg-gray-50">
                        <td className="p-2 border-b pl-6">{r.row_label ?? 'Row'}</td>
                        {g.purchaseSum.map((_, i) => (
                          <td key={i} className="p-2 border-b text-right">{r.values[i] ?? 0}</td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <td className="p-2">Available</td>
                      {g.available.map((v, i) => (
                        <td key={i} className="p-2 text-right font-semibold">{v}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="text-[10px] text-gray-500 mt-1">Scraped: {new Date(g.scrapedAt).toLocaleString()}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


