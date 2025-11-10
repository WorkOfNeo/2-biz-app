'use client';

import * as React from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

type ExcelRow = {
  ShopID: string | number | null;
  ShopName: string;
  EAN: string | number | null;
  Article: string; // StyleNo
  Style?: string | null;
  Color: string;
  Size: string;
  Qty: number;
  Costprice?: number | null;
  RRP?: number | null;
  _sourceFile?: string;
};

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  scraped_at: string;
};

type GroupedStock = {
  sizes: string[];
  available: number[]; // computed: stock - sold + purchase
};

function normalize(s: string | null | undefined): string {
  return String(s || '').trim().toLowerCase();
}

function normalizeColor(s: string | null | undefined): string {
  // Remove non-alphanumeric to match e.g., "999 Black" vs "Black-999"
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toNumber(val: any): number {
  const n = Number(String(val || '').replace(/[^0-9.,-]/g, '').replace('.', '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function NielsensSalesPage() {
  const supabase = createClientComponentClient();
  // Load stock snapshots
  const { data: stock } = useSWR<StockRow[]>('style_stock:latest', async () => {
    const pageSize = 2000;
    const cap = 40000; // hard cap to avoid runaway
    let from = 0;
    const rows: any[] = [];
    // Page through all rows in descending scraped_at order
    // Supabase default max rows per request ~1000; range works for pagination
    while (from < cap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, scraped_at')
        .order('scraped_at', { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return rows.map((r: any) => ({
      ...r,
      sizes: Array.isArray(r.sizes) ? r.sizes : JSON.parse(String(r.sizes || '[]')),
      values: Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]'))
    })) as StockRow[];
  }, { refreshInterval: 0 });

  // Build availability map styleNo|color -> { sizes, available[] }
  const availability = React.useMemo(() => {
    const map = new Map<string, GroupedStock>();
    if (!stock) return map;
    // Group rows per (style_no, color) and keep latest per (section,row_label)
    const byKey = new Map<string, StockRow[]>();
    for (const r of stock) {
      const key = `${normalize(r.style_no)}|${normalize(r.color)}`;
      const arr = byKey.get(key) || [];
      arr.push(r);
      byKey.set(key, arr);
    }
    for (const [key, rows] of byKey.entries()) {
      const latest = new Map<string, StockRow>();
      for (const r of rows) {
        const k2 = `${r.section}|${r.row_label ?? ''}`;
        const curr = latest.get(k2);
        if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) latest.set(k2, r);
      }
      const latestRows = Array.from(latest.values());
      const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0] || rows[0])?.sizes || [];
      const len = sizes.length;
      const zero = Array.from({ length: len }, () => 0);
      const stockRow = latestRows.find(r => r.section === 'Stock');
      const stockVals = stockRow ? ensureNums(stockRow.values, len) : zero;
      const soldVals = latestRows.filter(r => r.section === 'Sold').reduce((acc, r) => {
        const v: number[] = ensureNums(r.values, len);
        return acc.map((x, i) => x + (v[i] ?? 0));
      }, zero.slice());
      const purchaseVals = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)').reduce((acc, r) => {
        const v: number[] = ensureNums(r.values, len);
        return acc.map((x, i) => x + (v[i] ?? 0));
      }, zero.slice());
      const available = stockVals.map((v, i) => v - (soldVals[i] ?? 0) + (purchaseVals[i] ?? 0));
      map.set(key, { sizes, available });
    }
    return map;
  }, [stock]);

  function ensureNums(arr: any[], len: number): number[] {
    return Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
  }

  const [rows, setRows] = React.useState<ExcelRow[]>([]);
  const [grouped, setGrouped] = React.useState<Array<{ shop: string; items: (ExcelRow & { approved: boolean })[] }>>([]);
  const [ran, setRan] = React.useState(false);

  // Load style names for the uploaded rows
  const styleNos = React.useMemo(() => Array.from(new Set(rows.map(r => r.Article))).filter(Boolean), [rows]);
  const { data: styleNameRows } = useSWR(styleNos.length ? ['nielsens:stylesByNo', styleNos.join(',')] : null, async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('style_no, style_name')
      .in('style_no', styleNos);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_no: string; style_name: string | null }>;
  }, { refreshInterval: 0 });
  const styleNameByNo = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of (styleNameRows ?? [])) m.set(r.style_no, r.style_name);
    return m;
  }, [styleNameRows]);

  function parseWorkbook(fileName: string, wb: XLSX.WorkBook): ExcelRow[] {
    const out: ExcelRow[] = [];
    const firstSheetName = wb.SheetNames?.[0];
    if (!firstSheetName) return out;
    const sheet = wb.Sheets[firstSheetName];
    if (!sheet) return out;
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as any[];
    for (const r of json) {
      // Flexible column picking by header name variants
      const shopId = r['ShopID'] ?? r['Shop Id'] ?? r['Shop ID'] ?? r['Shop'] ?? null;
      const shopName = r['ShopName'] ?? r['Shop Name'] ?? r['Shop'] ?? '';
      const ean = r['EAN'] ?? r['Ean'] ?? r['Barcode'] ?? null;
      const article = r['Article'] ?? r['StyleNo'] ?? r['Article(StyleNo)'] ?? r['Style No'] ?? r['Style'] ?? '';
      const styleTxt = r['Style'] ?? r['Style Name'] ?? null;
      const color = r['Color'] ?? r['Colour'] ?? '';
      const size = r['Size'] ?? '';
      const qty = toNumber(r['Qty'] ?? r['Quantity']);
      const cost = toNumber(r['Costprice'] ?? r['Cost'] ?? r['Cost Price']);
      const rrp = toNumber(r['RRP'] ?? r['Retail'] ?? r['Price']);
      const row: ExcelRow = {
        ShopID: shopId, ShopName: String(shopName || '').trim(),
        EAN: ean, Article: String(article || '').trim(),
        Style: styleTxt ? String(styleTxt) : null,
        Color: String(color || '').trim(),
        Size: String(size || '').trim(),
        Qty: qty || 0,
        Costprice: Number.isFinite(cost) ? cost : null,
        RRP: Number.isFinite(rrp) ? rrp : null,
        _sourceFile: fileName
      };
      if (row.Article && row.ShopName && row.Color && row.Size) out.push(row);
    }
    return out;
  }

  async function onFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const all: ExcelRow[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const rows = parseWorkbook(file.name, wb);
      all.push(...rows);
    }
    setRows(all);
  }

  // Clear results when new files are uploaded
  React.useEffect(() => { setRan(false); setGrouped([]); }, [rows.length]);

  function runAgainstStock() {
    // Build working inventory snapshot so deductions persist across lines
    const inv = new Map<string, { sizes: string[]; avail: number[] }>();
    for (const [k, v] of availability.entries()) {
      inv.set(k, { sizes: v.sizes.slice(), avail: v.available.slice() });
    }
    // Build variant index per style for fuzzy color match
    const styleToVariants = new Map<string, Array<{ key: string; colorNorm: string; sizes: string[]; avail: number[] }>>();
    for (const [key, v] of inv.entries()) {
      const parts = key.split('|');
      const sty = parts[0] || '';
      const col = parts[1] || '';
      const list = styleToVariants.get(sty) || [];
      list.push({ key, colorNorm: normalizeColor(col), sizes: v.sizes, avail: v.avail });
      styleToVariants.set(sty, list);
    }
    // Evaluate rows sequentially with deductions
    const decided: Array<ExcelRow & { approved: boolean }> = rows.map((r) => {
      const key = `${normalize(r.Article)}|${normalize(r.Color)}`;
      const g = inv.get(key);
      const want = r.Qty || 0;
      const sizeNorm = normalize(r.Size);
      // First try exact color match
      if (g) {
        const idx = g.sizes.findIndex((s) => normalize(s) === sizeNorm);
        if (idx !== -1) {
          const have = g.avail[idx] ?? 0;
          if (have >= want) {
            g.avail[idx] = have - want;
            return { ...r, approved: true };
          }
        }
      }
      // Fuzzy color match: find any variant for this style where color contains request or vice versa
      const styleKey = normalize(r.Article);
      const variants = styleToVariants.get(styleKey) || [];
      const reqColorNorm = normalizeColor(r.Color);
      // score: 2 if variant includes request, 1 if request includes variant, 0 otherwise
      let best: { v: { key: string; colorNorm: string; sizes: string[]; avail: number[] }; idx: number; have: number; score: number } | null = null;
      for (const v of variants) {
        const score = v.colorNorm.includes(reqColorNorm) ? 2 : (reqColorNorm.includes(v.colorNorm) && v.colorNorm.length > 0 ? 1 : 0);
        if (score === 0) continue;
        const idx = v.sizes.findIndex((s) => normalize(s) === sizeNorm);
        if (idx === -1) continue;
        const have = v.avail[idx] ?? 0;
        if (!best || score > best.score || (score === best.score && have > best.have)) {
          best = { v, idx, have, score };
        }
      }
      if (best && best.have >= want) {
        best.v.avail[best.idx] = best.have - want;
        return { ...r, approved: true };
      }
      return { ...r, approved: false };
    });
    // Group by ShopName
    const map = new Map<string, (typeof decided)[number][]>();
    for (const it of decided) {
      const arr = map.get(it.ShopName) || [];
      arr.push(it);
      map.set(it.ShopName, arr);
    }
    setGrouped(Array.from(map.entries()).map(([shop, list]) => ({ shop, items: list })));
    setRan(true);
  }

  // Build per-shop summary after a run
  const summaryByShop = React.useMemo(() => {
    if (!ran || grouped.length === 0) return [] as Array<{
      shop: string;
      can: Array<{ article: string; color: string; size: string; qty: number }>;
      cannot: Array<{ article: string; color: string; size: string; qty: number }>;
    }>;
    const out: Array<{ shop: string; can: Array<{ article: string; color: string; size: string; qty: number }>; cannot: Array<{ article: string; color: string; size: string; qty: number }> }> = [];
    for (const g of grouped) {
      const canMap = new Map<string, number>();     // key: article|||color|||size
      const cannotMap = new Map<string, number>();  // key: article|||color|||size
      for (const it of g.items) {
        const key = `${it.Article}|||${it.Color}|||${it.Size}`;
        const addTo = it.approved ? canMap : cannotMap;
        addTo.set(key, (addTo.get(key) || 0) + (it.Qty || 0));
      }
      const can = Array.from(canMap.entries()).map(([k, qty]) => {
        const parts = k.split('|||');
        const article = parts[0] || '';
        const color = parts[1] || '';
        const size = parts[2] || '';
        return { article, color, size, qty };
      }).sort((a,b) =>
        (a.article || '').localeCompare(b.article || '') ||
        (a.color || '').localeCompare(b.color || '') ||
        (a.size || '').localeCompare(b.size || '')
      );
      const cannot = Array.from(cannotMap.entries()).map(([k, qty]) => {
        const parts = k.split('|||');
        const article = parts[0] || '';
        const color = parts[1] || '';
        const size = parts[2] || '';
        return { article, color, size, qty };
      }).sort((a,b) =>
        (a.article || '').localeCompare(b.article || '') ||
        (a.color || '').localeCompare(b.color || '') ||
        (a.size || '').localeCompare(b.size || '')
      );
      out.push({ shop: g.shop, can, cannot });
    }
    // sort shops alphabetically
    out.sort((a, b) => a.shop.localeCompare(b.shop));
    return out;
  }, [grouped, ran]);

  // Build copyable message for NOT deliverable only
  const cannotMessage = React.useMemo(() => {
    if (!ran || summaryByShop.length === 0) return '';
    const lines: string[] = [];
    lines.push('Vi kan desværre ikke levere:');
    for (const s of summaryByShop) {
      if (s.cannot.length === 0) continue;
      lines.push(s.shop);
      for (const r of s.cannot) {
        const nm = styleNameByNo.get(r.article) || '';
        const label = nm ? `${r.article} ${nm}` : r.article;
        lines.push(`${label} - ${r.color} - ${r.size}, ${r.qty} stk`);
      }
      lines.push(''); // blank line between shops
    }
    return lines.join('\n').trim();
  }, [summaryByShop, ran, styleNameByNo]);

  // Toggle per shop
  const [openShops, setOpenShops] = React.useState<Record<string, boolean>>({});
  const toggleShop = (name: string) => setOpenShops((m) => ({ ...m, [name]: !m[name] }));

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Sales</div>
        <h1 className="text-xl font-semibold">Nielsens — Availability Check</h1>
      </div>

      <div className="rounded-md border bg-white p-4 space-y-3">
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".xlsx,.xls"
            multiple
            onChange={(e) => onFilesSelected(e.currentTarget.files)}
          />
          <div className="text-xs text-gray-600">Upload up to 17 Excel files. Columns: ShopID, ShopName, EAN, Article(StyleNo), Style, Color, Size, Qty, Costprice, RRP</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={"text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800 " + ((rows.length === 0 || availability.size === 0) ? 'opacity-60 cursor-not-allowed' : '')}
            disabled={rows.length === 0 || availability.size === 0}
            onClick={runAgainstStock}
          >
            Run against stock
          </button>
          {ran && <div className="text-xs text-gray-600">Calculated approvals based on current stock snapshot.</div>}
        </div>
      </div>

      {ran && summaryByShop.length > 0 && (
        <div className="rounded-md border bg-white p-3">
          <div className="text-sm font-semibold mb-2">Summary</div>
          {/* Copyable message for NOT deliverable only */}
          {cannotMessage && (
            <div className="mb-3">
              <div className="text-xs font-medium mb-1">Message (Kan ikke levere)</div>
              <div className="flex items-start gap-2">
                <textarea readOnly value={cannotMessage} className="w-full h-28 border rounded p-2 text-xs font-mono" />
                <button
                  className="text-xs px-2 py-1 border rounded bg-white hover:bg-slate-50"
                  onClick={() => { navigator.clipboard.writeText(cannotMessage).catch(()=>{}); }}
                >Copy</button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {summaryByShop.map((s) => {
              const rows = [
                ...s.can.map((r) => ({ ...r, approved: true })),
                ...s.cannot.map((r) => ({ ...r, approved: false })),
              ].sort((a, b) =>
                a.article.localeCompare(b.article) ||
                a.color.localeCompare(b.color) ||
                a.size.localeCompare(b.size)
              );
              const sumYes = s.can.reduce((a, r) => a + (r.qty || 0), 0);
              const sumNo = s.cannot.reduce((a, r) => a + (r.qty || 0), 0);
              const open = openShops[s.shop] !== false; // default open
              return (
                <div key={s.shop} className="rounded border">
                  <div className="flex items-center justify-between px-2 py-1 bg-gray-50">
                    <div className="text-sm font-medium">{s.shop}</div>
                    <button
                      className="text-xs px-2 py-0.5 border rounded bg-white hover:bg-slate-50"
                      onClick={() => toggleShop(s.shop)}
                    >
                      {open ? 'Close' : 'Open'}
                    </button>
                  </div>
                  {open && (
                    <div className="overflow-auto">
                      <table className="min-w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="p-2 text-left border-b">Article</th>
                            <th className="p-2 text-left border-b">Color</th>
                            <th className="p-2 text-left border-b">Size</th>
                            <th className="p-2 text-right border-b">Qty</th>
                            <th className="p-2 text-left border-b">Approved</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 && <tr><td colSpan={5} className="p-2 text-gray-500">—</td></tr>}
                          {rows.map((r, i) => (
                            <tr key={i} className={r.approved ? '' : 'bg-red-50'}>
                              <td className="p-2 border-b">{r.article}{(() => { const nm = styleNameByNo.get(r.article) || ''; return nm ? ` · ${nm}` : ''; })()}</td>
                              <td className="p-2 border-b">{r.color}</td>
                              <td className="p-2 border-b">{r.size}</td>
                              <td className="p-2 border-b text-right">{r.qty}</td>
                              <td className="p-2 border-b">{r.approved ? 'Yes' : 'No'}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-50">
                            <td className="p-2 text-sm font-medium" colSpan={5}>Kan levere: {sumYes} — Kan ikke: {sumNo}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {grouped.length > 0 && (
        <div className="rounded-md border bg-white overflow-hidden">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left border-b">Shop</th>
                <th className="p-2 text-left border-b">Article</th>
                <th className="p-2 text-left border-b">Color</th>
                <th className="p-2 text-left border-b">Size</th>
                <th className="p-2 text-right border-b">Qty</th>
                <th className="p-2 text-left border-b">Approved</th>
                <th className="p-2 text-left border-b">File</th>
              </tr>
            </thead>
            <tbody>
              {grouped.flatMap((g) => (
                g.items.map((it, i) => (
                  <tr key={`${g.shop}-${i}`} className={it.approved ? 'bg-green-50' : ''}>
                    <td className="p-2 border-b">{g.shop}</td>
                    <td className="p-2 border-b">
                      {it.Article}{(() => { const nm = styleNameByNo.get(it.Article) || ''; return nm ? ` · ${nm}` : ''; })()}
                    </td>
                    <td className="p-2 border-b">{it.Color}</td>
                    <td className="p-2 border-b">{it.Size}</td>
                    <td className="p-2 border-b text-right">{it.Qty}</td>
                    <td className="p-2 border-b">{it.approved ? 'Yes' : 'No'}</td>
                    <td className="p-2 border-b text-gray-500">{it._sourceFile || '—'}</td>
                  </tr>
                ))
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}



