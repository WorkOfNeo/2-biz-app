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

function toNumber(val: any): number {
  const n = Number(String(val || '').replace(/[^0-9.,-]/g, '').replace('.', '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function NielsensSalesPage() {
  const supabase = createClientComponentClient();
  // Load stock snapshots
  const { data: stock } = useSWR<StockRow[]>('style_stock:latest', async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);
    // Ensure arrays are typed properly
    return (data ?? []).map((r: any) => ({
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
    // Evaluate rows sequentially with deductions
    const decided: Array<ExcelRow & { approved: boolean }> = rows.map((r) => {
      const key = `${normalize(r.Article)}|${normalize(r.Color)}`;
      const g = inv.get(key);
      if (!g) return { ...r, approved: false };
      const idx = g.sizes.findIndex((s) => normalize(s) === normalize(r.Size));
      if (idx === -1) return { ...r, approved: false };
      const want = r.Qty || 0;
      const have = g.avail[idx] ?? 0;
      if (have >= want) {
        g.avail[idx] = have - want; // deduct
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
                    <td className="p-2 border-b">{it.Article}</td>
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



