'use client';

import * as React from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

type ExcelRow = {
  ShopID: string | number | null;
  ShopName: string;
  EAN: string | number | null;
  Qty: number;
  Costprice?: number | null;
  RRP?: number | null;
  _sourceFile?: string;
  _originalRow?: any; // Store original row data for column mapping
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

type EanRow = {
  ean: string;
  style_no: string;
  color: string;
  size: string;
};

type ColumnMapping = {
  shopId?: string;
  shopName?: string;
  ean?: string;
  qty?: string;
  costprice?: string;
  rrp?: string;
};

function normalize(s: string | null | undefined): string {
  return String(s || '').trim().toLowerCase();
}

function normalizeEan(ean: string | number | null | undefined): string {
  return String(ean || '').trim().replace(/\s+/g, '');
}

function toNumber(val: any): number {
  const n = Number(String(val || '').replace(/[^0-9.,-]/g, '').replace('.', '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function NielsensSalesPage() {
  const supabase = createClientComponentClient();
  
  // Load EAN codes from database
  const { data: eanData } = useSWR<EanRow[]>('style_color_eans:all', async () => {
    const pageSize = 5000;
    const cap = 100000; // hard cap
    let from = 0;
    const rows: any[] = [];
    while (from < cap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('style_color_eans')
        .select('ean, style_no, color, size')
        .range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return rows as EanRow[];
  }, { refreshInterval: 0 });

  // Build EAN -> style_no/color/size map
  const eanMap = React.useMemo(() => {
    const map = new Map<string, EanRow>();
    if (!eanData) return map;
    for (const row of eanData) {
      const normalizedEan = normalizeEan(row.ean);
      if (normalizedEan) {
        map.set(normalizedEan, row);
      }
    }
    return map;
  }, [eanData]);

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
  const [columnMapping, setColumnMapping] = React.useState<ColumnMapping>({});
  const [showMapping, setShowMapping] = React.useState(false);
  const [availableColumns, setAvailableColumns] = React.useState<string[]>([]);
  const [uploadedFiles, setUploadedFiles] = React.useState<File[]>([]);

  // Load style names for display
  const styleNosInRows = React.useMemo(() => {
    if (!rows.length || !eanMap.size) return [];
    const styleNos = new Set<string>();
    for (const row of rows) {
      const ean = normalizeEan(row.EAN);
      const eanInfo = eanMap.get(ean);
      if (eanInfo) {
        styleNos.add(eanInfo.style_no);
      }
    }
    return Array.from(styleNos);
  }, [rows, eanMap]);

  const { data: styleNames } = useSWR(
    styleNosInRows.length > 0 ? ['nielsens:styleNames', styleNosInRows.join(',')] : null,
    async () => {
      if (styleNosInRows.length === 0) return [];
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name')
        .in('style_no', styleNosInRows);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ style_no: string; style_name: string | null }>;
    },
    { refreshInterval: 0 }
  );

  const styleNameByNo = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of (styleNames ?? [])) {
      m.set(r.style_no, r.style_name);
    }
    return m;
  }, [styleNames]);

  async function onFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    setUploadedFiles(fileArray);
    
    // Read first file to detect columns
    const firstFile = fileArray[0];
    if (!firstFile) return;
    const buf = await firstFile.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const firstSheetName = wb.SheetNames?.[0];
    if (!firstSheetName) return;
    
    const sheet = wb.Sheets[firstSheetName];
    if (!sheet) return;
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as any[];
    
    if (json.length > 0) {
      // Get all column names from first row
      const columns = Object.keys(json[0]);
      setAvailableColumns(columns);
      
      // Auto-detect common column names
      const autoMapping: ColumnMapping = {};
      for (const col of columns) {
        const colLower = col.toLowerCase();
        if (!autoMapping.shopId && (colLower.includes('shopid') || colLower.includes('shop id'))) {
          autoMapping.shopId = col;
        }
        if (!autoMapping.shopName && (colLower.includes('shopname') || colLower.includes('shop name') || (colLower.includes('shop') && !colLower.includes('id')))) {
          autoMapping.shopName = col;
        }
        if (!autoMapping.ean && (colLower.includes('ean') || colLower.includes('barcode') || colLower.includes('gtin'))) {
          autoMapping.ean = col;
        }
        if (!autoMapping.qty && (colLower.includes('qty') || colLower.includes('quantity') || colLower.includes('amount'))) {
          autoMapping.qty = col;
        }
        if (!autoMapping.costprice && (colLower.includes('cost') || colLower.includes('costprice'))) {
          autoMapping.costprice = col;
        }
        if (!autoMapping.rrp && (colLower.includes('rrp') || colLower.includes('retail') || colLower.includes('price'))) {
          autoMapping.rrp = col;
        }
      }
      setColumnMapping(autoMapping);
      setShowMapping(true);
    }
  }

  function parseWorkbook(fileName: string, wb: XLSX.WorkBook, mapping: ColumnMapping): ExcelRow[] {
    const out: ExcelRow[] = [];
    const firstSheetName = wb.SheetNames?.[0];
    if (!firstSheetName) return out;
    const sheet = wb.Sheets[firstSheetName];
    if (!sheet) return out;
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as any[];
    
    for (const r of json) {
      const shopId = mapping.shopId ? r[mapping.shopId] : null;
      const shopName = mapping.shopName ? String(r[mapping.shopName] || '').trim() : '';
      const ean = mapping.ean ? r[mapping.ean] : null;
      const qty = mapping.qty ? toNumber(r[mapping.qty]) : 0;
      const cost = mapping.costprice ? toNumber(r[mapping.costprice]) : null;
      const rrp = mapping.rrp ? toNumber(r[mapping.rrp]) : null;
      
      const row: ExcelRow = {
        ShopID: shopId,
        ShopName: shopName,
        EAN: ean,
        Qty: qty || 0,
        Costprice: Number.isFinite(cost) ? cost : null,
        RRP: Number.isFinite(rrp) ? rrp : null,
        _sourceFile: fileName,
        _originalRow: r
      };
      
      // Require EAN and ShopName
      if (row.EAN && row.ShopName) {
        out.push(row);
      }
    }
    return out;
  }

  async function applyMapping() {
    if (!columnMapping.ean || !columnMapping.shopName) {
      alert('Please map at least EAN and ShopName columns');
      return;
    }
    
    const all: ExcelRow[] = [];
    // Parse all uploaded files with the mapping
    for (const file of uploadedFiles) {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const parsed = parseWorkbook(file.name, wb, columnMapping);
      all.push(...parsed);
    }
    
    setRows(all);
    setShowMapping(false);
  }

  // Clear results when new files are uploaded
  React.useEffect(() => { setRan(false); setGrouped([]); }, [rows.length]);

  function runAgainstStock() {
    if (!eanMap.size || !availability.size) return;
    
    // Build EAN -> stock availability map
    const eanToStock = new Map<string, { size: string; available: number; style_no: string; color: string }>();
    
    for (const [ean, eanInfo] of eanMap.entries()) {
      const stockKey = `${normalize(eanInfo.style_no)}|${normalize(eanInfo.color)}`;
      const stockInfo = availability.get(stockKey);
      if (stockInfo) {
        const sizeIdx = stockInfo.sizes.findIndex(s => normalize(s) === normalize(eanInfo.size));
        if (sizeIdx !== -1) {
          const available = stockInfo.available[sizeIdx] ?? 0;
          eanToStock.set(ean, {
            size: eanInfo.size,
            available,
            style_no: eanInfo.style_no,
            color: eanInfo.color
          });
        }
      }
    }
    
    // Build working inventory snapshot so deductions persist across lines
    const inv = new Map<string, number>();
    for (const [ean, stock] of eanToStock.entries()) {
      inv.set(ean, stock.available);
    }
    
    // Evaluate rows sequentially with deductions
    const decided: Array<ExcelRow & { approved: boolean }> = rows.map((r) => {
      const ean = normalizeEan(r.EAN);
      const want = r.Qty || 0;
      
      if (!ean) {
        return { ...r, approved: false };
      }
      
      const have = inv.get(ean) ?? 0;
      if (have >= want) {
        inv.set(ean, have - want);
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
      can: Array<{ ean: string; style_no: string; color: string; size: string; qty: number }>;
      cannot: Array<{ ean: string; style_no: string; color: string; size: string; qty: number }>;
    }>;
    const out: Array<{ shop: string; can: Array<{ ean: string; style_no: string; color: string; size: string; qty: number }>; cannot: Array<{ ean: string; style_no: string; color: string; size: string; qty: number }> }> = [];
    for (const g of grouped) {
      const canMap = new Map<string, number>();     // key: ean
      const cannotMap = new Map<string, number>();  // key: ean
      for (const it of g.items) {
        const ean = normalizeEan(it.EAN);
        const addTo = it.approved ? canMap : cannotMap;
        addTo.set(ean, (addTo.get(ean) || 0) + (it.Qty || 0));
      }
      const can = Array.from(canMap.entries()).map(([ean, qty]) => {
        const eanInfo = eanMap.get(ean);
        return {
          ean,
          style_no: eanInfo?.style_no || '',
          color: eanInfo?.color || '',
          size: eanInfo?.size || '',
          qty
        };
      }).sort((a, b) => a.style_no.localeCompare(b.style_no) || a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
      const cannot = Array.from(cannotMap.entries()).map(([ean, qty]) => {
        const eanInfo = eanMap.get(ean);
        return {
          ean,
          style_no: eanInfo?.style_no || '',
          color: eanInfo?.color || '',
          size: eanInfo?.size || '',
          qty
        };
      }).sort((a, b) => a.style_no.localeCompare(b.style_no) || a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
      out.push({ shop: g.shop, can, cannot });
    }
    // sort shops alphabetically
    out.sort((a, b) => a.shop.localeCompare(b.shop));
    return out;
  }, [grouped, ran, eanMap]);

  // Build copyable message for NOT deliverable only
  const cannotMessage = React.useMemo(() => {
    if (!ran || summaryByShop.length === 0) return '';
    const lines: string[] = [];
    lines.push('Vi kan desværre ikke levere:');
    for (const s of summaryByShop) {
      if (s.cannot.length === 0) continue;
      lines.push(s.shop);
      for (const r of s.cannot) {
        const nm = styleNameByNo.get(r.style_no) || '';
        const label = nm ? `${r.style_no} ${nm}` : r.style_no;
        lines.push(`${label} - ${r.color} - ${r.size} (EAN: ${r.ean}), ${r.qty} stk`);
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
        <h1 className="text-xl font-semibold">Nielsens — Availability Check (EAN-based)</h1>
      </div>

      <div className="rounded-md border bg-white p-4 space-y-3">
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".xlsx,.xls"
            multiple
            onChange={(e) => onFilesSelected(e.currentTarget.files)}
          />
          <div className="text-xs text-gray-600">Upload Excel files. Map columns to: ShopID, ShopName, EAN, Qty, Costprice, RRP</div>
        </div>
        
        {showMapping && availableColumns.length > 0 && (
          <div className="border rounded p-3 bg-gray-50 space-y-2">
            <div className="text-sm font-semibold mb-2">Map Columns</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="block mb-1 font-medium">Shop ID</label>
                <select
                  value={columnMapping.shopId || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, shopId: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Shop Name *</label>
                <select
                  value={columnMapping.shopName || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, shopName: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                  required
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">EAN *</label>
                <select
                  value={columnMapping.ean || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, ean: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                  required
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Quantity</label>
                <select
                  value={columnMapping.qty || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, qty: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Cost Price</label>
                <select
                  value={columnMapping.costprice || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, costprice: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">RRP</label>
                <select
                  value={columnMapping.rrp || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, rrp: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={applyMapping}
                className="text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800"
                disabled={!columnMapping.ean || !columnMapping.shopName}
              >
                Apply Mapping
              </button>
              <button
                onClick={() => setShowMapping(false)}
                className="text-xs px-3 py-1.5 border rounded bg-white hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        
        <div className="flex items-center gap-2">
          <button
            className={"text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800 " + ((rows.length === 0 || eanMap.size === 0 || availability.size === 0) ? 'opacity-60 cursor-not-allowed' : '')}
            disabled={rows.length === 0 || eanMap.size === 0 || availability.size === 0}
            onClick={runAgainstStock}
          >
            Run against stock
          </button>
          {ran && <div className="text-xs text-gray-600">Calculated approvals based on EAN codes and current stock snapshot.</div>}
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
                a.style_no.localeCompare(b.style_no) ||
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
                            <th className="p-2 text-left border-b">Style</th>
                            <th className="p-2 text-left border-b">Color</th>
                            <th className="p-2 text-left border-b">Size</th>
                            <th className="p-2 text-left border-b">EAN</th>
                            <th className="p-2 text-right border-b">Qty</th>
                            <th className="p-2 text-left border-b">Approved</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 && <tr><td colSpan={6} className="p-2 text-gray-500">—</td></tr>}
                          {rows.map((r, i) => (
                            <tr key={i} className={r.approved ? '' : 'bg-red-50'}>
                              <td className="p-2 border-b">{r.style_no}{(() => { const nm = styleNameByNo.get(r.style_no) || ''; return nm ? ` · ${nm}` : ''; })()}</td>
                              <td className="p-2 border-b">{r.color}</td>
                              <td className="p-2 border-b">{r.size}</td>
                              <td className="p-2 border-b font-mono text-[10px]">{r.ean}</td>
                              <td className="p-2 border-b text-right">{r.qty}</td>
                              <td className="p-2 border-b">{r.approved ? 'Yes' : 'No'}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-50">
                            <td className="p-2 text-sm font-medium" colSpan={6}>Kan levere: {sumYes} — Kan ikke: {sumNo}</td>
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
                <th className="p-2 text-left border-b">EAN</th>
                <th className="p-2 text-left border-b">Style</th>
                <th className="p-2 text-left border-b">Color</th>
                <th className="p-2 text-left border-b">Size</th>
                <th className="p-2 text-right border-b">Qty</th>
                <th className="p-2 text-left border-b">Approved</th>
                <th className="p-2 text-left border-b">File</th>
              </tr>
            </thead>
            <tbody>
              {grouped.flatMap((g) => (
                g.items.map((it, i) => {
                  const ean = normalizeEan(it.EAN);
                  const eanInfo = eanMap.get(ean);
                  return (
                    <tr key={`${g.shop}-${i}`} className={it.approved ? 'bg-green-50' : ''}>
                      <td className="p-2 border-b">{g.shop}</td>
                      <td className="p-2 border-b font-mono text-[10px]">{ean}</td>
                      <td className="p-2 border-b">
                        {eanInfo?.style_no || '—'}{(() => { const nm = styleNameByNo.get(eanInfo?.style_no || '') || ''; return nm ? ` · ${nm}` : ''; })()}
                      </td>
                      <td className="p-2 border-b">{eanInfo?.color || '—'}</td>
                      <td className="p-2 border-b">{eanInfo?.size || '—'}</td>
                      <td className="p-2 border-b text-right">{it.Qty}</td>
                      <td className="p-2 border-b">{it.approved ? 'Yes' : 'No'}</td>
                      <td className="p-2 border-b text-gray-500">{it._sourceFile || '—'}</td>
                    </tr>
                  );
                })
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
