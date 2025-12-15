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
  Style?: string | null;
  Color?: string | null;
  Size?: string | null;
  _sourceFile?: string;
  _originalRow?: any; // Store original row data for column mapping
};

type MatchResult = {
  found: boolean;
  available: number;
  method: 'ean' | 'fallback' | 'none';
  details?: string;
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
  style?: string;
  color?: string;
  size?: string;
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

function fuzzyMatchColor(colorA: string | null | undefined, colorB: string | null | undefined): boolean {
  if (!colorA || !colorB) return false;
  
  // Normalize: lowercase, remove spaces and common separators
  const normA = String(colorA).toLowerCase().replace(/[\s\-_/]/g, '');
  const normB = String(colorB).toLowerCase().replace(/[\s\-_/]/g, '');
  
  // Direct equality
  if (normA === normB) return true;
  
  // Bidirectional substring matching (conservative)
  // e.g., "01" matches "color01" or "black" matches "blackmelange"
  if (normA.includes(normB) || normB.includes(normA)) return true;
  
  return false;
}

export default function NielsensSalesPage() {
  const supabase = createClientComponentClient();
  
  // Load EAN codes from database
  const { data: eanData } = useSWR<EanRow[]>('style_color_eans:all', async () => {
    const pageSize = 1000; // Supabase default max per request
    let page = 0;
    const rows: any[] = [];
    console.log('[Nielsens Debug] Loading EAN codes from database...');
    while (true) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await supabase
        .from('style_color_eans')
        .select('ean, style_no, color, size', { count: 'exact' })
        .range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      rows.push(...batch);
      
      if (page === 0 && count) {
        console.log(`[Nielsens Debug] Total rows in database: ${count}`);
      }
      console.log(`[Nielsens Debug] Loaded ${rows.length} EAN codes so far...`);
      
      if (batch.length === 0 || batch.length < pageSize) break; // No more rows
      page++;
    }
    console.log(`[Nielsens Debug] Finished loading ${rows.length} total EAN codes`);
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
    console.log('[Nielsens Debug] Built eanMap with', map.size, 'entries');
    // Make eanMap available globally for debugging
    if (typeof window !== 'undefined') {
      (window as any).debugEanMap = map;
      console.log('[Nielsens Debug] To check if an EAN exists, run in console: window.debugEanMap.get("YOUR_EAN")');
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
    console.log('[Nielsens Debug] Built availability map with', map.size, 'style/color combinations');
    // Make availability map available globally for debugging
    if (typeof window !== 'undefined') {
      (window as any).debugAvailability = map;
      (window as any).debugFindStyle = (stylePart: string) => {
        const keys = Array.from(map.keys()).filter(k => k.toLowerCase().includes(stylePart.toLowerCase()));
        console.log(`Found ${keys.length} keys matching "${stylePart}":`, keys);
        return keys;
      };
      console.log('[Nielsens Debug] Debug helpers available:');
      console.log('  - window.debugAvailability.get("styleno|color") - Check stock for exact key');
      console.log('  - window.debugFindStyle("rim") - Find all keys containing "rim"');
      console.log('  - window.debugEanMap.get("YOUR_EAN") - Check EAN mapping');
    }
    return map;
  }, [stock]);

  function ensureNums(arr: any[], len: number): number[] {
    return Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
  }

  // Fallback stock lookup using Style/Color/Size with fuzzy color matching
  function findStockByStyleColorSize(
    styleNo: string | null | undefined,
    color: string | null | undefined,
    size: string | null | undefined
  ): { available: number; matchedColor: string } | null {
    if (!styleNo || !color || !size) return null;
    
    const normalizedStyle = normalize(styleNo);
    const normalizedSize = normalize(size);
    
    // Search through availability map for matching style
    for (const [key, stockInfo] of availability.entries()) {
      const parts = key.split('|');
      const keyStyle = parts[0];
      const keyColor = parts[1];
      
      // Check if we have both parts
      if (!keyStyle || !keyColor) continue;
      
      // Check if style matches
      if (keyStyle !== normalizedStyle) continue;
      
      // Check if color matches using fuzzy matching
      if (!fuzzyMatchColor(color, keyColor)) continue;
      
      // Find the size in the stock info
      const sizeIdx = stockInfo.sizes.findIndex(s => normalize(s) === normalizedSize);
      if (sizeIdx !== -1) {
        const available = stockInfo.available[sizeIdx] ?? 0;
        return { available, matchedColor: keyColor };
      }
    }
    
    return null;
  }

  const [rows, setRows] = React.useState<ExcelRow[]>([]);
  const [grouped, setGrouped] = React.useState<Array<{ shop: string; items: (ExcelRow & { approved: boolean; matchMethod?: string })[] }>>([]);
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
        if (!autoMapping.style && (colLower.includes('style') || colLower === 'style no' || colLower === 'styleno')) {
          autoMapping.style = col;
        }
        if (!autoMapping.color && (colLower.includes('color') || colLower.includes('colour') || colLower === 'clr')) {
          autoMapping.color = col;
        }
        if (!autoMapping.size && (colLower.includes('size') || colLower === 'sz')) {
          autoMapping.size = col;
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
      const style = mapping.style ? String(r[mapping.style] || '').trim() : null;
      const color = mapping.color ? String(r[mapping.color] || '').trim() : null;
      const size = mapping.size ? String(r[mapping.size] || '').trim() : null;
      
      const row: ExcelRow = {
        ShopID: shopId,
        ShopName: shopName,
        EAN: ean,
        Qty: qty || 0,
        Costprice: Number.isFinite(cost) ? cost : null,
        RRP: Number.isFinite(rrp) ? rrp : null,
        Style: style,
        Color: color,
        Size: size,
        _sourceFile: fileName,
        _originalRow: r
      };
      
      // Require EAN and ShopName (or Style/Color/Size for fallback)
      if (row.ShopName && (row.EAN || (row.Style && row.Color && row.Size))) {
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
    
    console.log('[Nielsens Debug] Parsed', all.length, 'rows from Excel');
    console.log('[Nielsens Debug] First 3 rows:', all.slice(0, 3));
    
    setRows(all);
    setShowMapping(false);
  }

  // Clear results when new files are uploaded
  React.useEffect(() => { setRan(false); setGrouped([]); }, [rows.length]);

  function runAgainstStock() {
    if (!eanMap.size || !availability.size) return;
    
    console.log('[Nielsens Debug] Starting stock check for', rows.length, 'rows');
    console.log('[Nielsens Debug] Total EAN codes loaded:', eanMap.size);
    console.log('[Nielsens Debug] Total availability keys:', availability.size);
    
    // Show some sample availability keys for debugging
    const sampleKeys = Array.from(availability.keys()).slice(0, 10);
    console.log('[Nielsens Debug] Sample availability keys:', sampleKeys);
    
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
    
    console.log('[Nielsens Debug] Built eanToStock map with', eanToStock.size, 'entries');
    
    // Build working inventory snapshot so deductions persist across lines
    const eanInv = new Map<string, number>();
    for (const [ean, stock] of eanToStock.entries()) {
      eanInv.set(ean, stock.available);
    }
    
    // Build fallback inventory tracker (style|color|size -> available)
    const fallbackInv = new Map<string, number>();
    for (const [key, stockInfo] of availability.entries()) {
      for (let i = 0; i < stockInfo.sizes.length; i++) {
        const size = stockInfo.sizes[i];
        const available = stockInfo.available[i] ?? 0;
        const fallbackKey = `${key}|${normalize(size)}`;
        fallbackInv.set(fallbackKey, available);
      }
    }
    
    // Track statistics
    let eanMatches = 0;
    let fallbackMatches = 0;
    let bothAgree = 0;
    let disagree = 0;
    
    // Evaluate rows sequentially with deductions
    const decided: Array<ExcelRow & { approved: boolean; matchMethod?: string }> = rows.map((r, idx) => {
      const ean = normalizeEan(r.EAN);
      const want = r.Qty || 0;
      
      console.log(`[Nielsens Debug] Row ${idx + 1}: EAN=${ean}, Style=${r.Style}, Color=${r.Color}, Size=${r.Size}, Qty=${want}`);
      
      // Try EAN method
      let eanAvailable = 0;
      let eanFound = false;
      if (ean) {
        const eanInfo = eanMap.get(ean);
        if (eanInfo) {
          console.log(`  → EAN ${ean} maps to: Style="${eanInfo.style_no}", Color="${eanInfo.color}", Size="${eanInfo.size}"`);
          const stockKey = `${normalize(eanInfo.style_no)}|${normalize(eanInfo.color)}`;
          console.log(`  → Looking up stock key: "${stockKey}"`);
          const stockInfo = availability.get(stockKey);
          if (stockInfo) {
            console.log(`  → Stock info found! Sizes available:`, stockInfo.sizes);
            console.log(`  → Stock availability values:`, stockInfo.available);
            const normalizedSize = normalize(eanInfo.size);
            console.log(`  → Looking for size "${eanInfo.size}" (normalized: "${normalizedSize}")`);
            const sizeIdx = stockInfo.sizes.findIndex(s => normalize(s) === normalizedSize);
            console.log(`  → Size index: ${sizeIdx}`);
            if (sizeIdx !== -1) {
              eanAvailable = eanInv.get(ean) ?? 0;
              eanFound = true;
              console.log(`  → EAN lookup: ✓ Found (available: ${eanAvailable})`);
            } else {
              console.log(`  → EAN lookup: ✗ Size not found in stock sizes`);
            }
          } else {
            console.log(`  → EAN lookup: ✗ Stock key not found in availability map`);
            // Show what keys ARE available for this style
            const matchingKeys = Array.from(availability.keys()).filter(k => k.startsWith(normalize(eanInfo.style_no) + '|'));
            if (matchingKeys.length > 0) {
              console.log(`  → Available keys for style "${eanInfo.style_no}":`, matchingKeys);
            } else {
              console.log(`  → No availability keys found for style "${eanInfo.style_no}"`);
            }
          }
        } else {
          console.log(`  → EAN lookup: ✗ EAN ${ean} not found in eanMap (database has ${eanMap.size} EAN codes total)`);
        }
        eanAvailable = eanInv.get(ean) ?? 0;
        eanFound = eanToStock.has(ean);
      } else {
        console.log(`  → EAN lookup: ✗ No EAN provided`);
      }
      
      // Try fallback method
      let fallbackAvailable = 0;
      let fallbackFound = false;
      let matchedColor = '';
      if (r.Style && r.Color && r.Size) {
        const fallbackResult = findStockByStyleColorSize(r.Style, r.Color, r.Size);
        if (fallbackResult) {
          fallbackFound = true;
          matchedColor = fallbackResult.matchedColor;
          // Get from fallback inventory
          const normalizedStyle = normalize(r.Style);
          const normalizedSize = normalize(r.Size);
          const fallbackKey = `${normalizedStyle}|${matchedColor}|${normalizedSize}`;
          fallbackAvailable = fallbackInv.get(fallbackKey) ?? 0;
          console.log(`  → Fallback lookup: ✓ Found (available: ${fallbackAvailable}, matched color '${r.Color}' to '${matchedColor}')`);
        } else {
          console.log(`  → Fallback lookup: ✗ Not found`);
        }
      } else {
        console.log(`  → Fallback lookup: ✗ Missing Style/Color/Size data`);
      }
      
      // Decision logic: use both methods
      let approved = false;
      let matchMethod = 'none';
      
      if (eanFound && fallbackFound) {
        // Both methods found stock
        const eanCanFulfill = eanAvailable >= want;
        const fallbackCanFulfill = fallbackAvailable >= want;
        
        if (eanCanFulfill === fallbackCanFulfill) {
          bothAgree++;
          approved = eanCanFulfill;
          matchMethod = approved ? 'both-agree-yes' : 'both-agree-no';
          console.log(`  → ✓ Methods agree: ${approved ? 'approved' : 'not approved'}`);
        } else {
          disagree++;
          // Use EAN as primary
          approved = eanCanFulfill;
          matchMethod = 'disagree';
          console.log(`  → ⚠️ Methods disagree! EAN=${eanCanFulfill}, Fallback=${fallbackCanFulfill}, using EAN result`);
        }
        
        if (approved) {
          eanMatches++;
          // Deduct from both inventories
          eanInv.set(ean, eanAvailable - want);
          const normalizedStyle = normalize(r.Style!);
          const normalizedSize = normalize(r.Size!);
          const fallbackKey = `${normalizedStyle}|${matchedColor}|${normalizedSize}`;
          fallbackInv.set(fallbackKey, fallbackAvailable - want);
        }
      } else if (eanFound) {
        // Only EAN found
        approved = eanAvailable >= want;
        matchMethod = 'ean-only';
        if (approved) {
          eanMatches++;
          eanInv.set(ean, eanAvailable - want);
          console.log(`  → ✓ EAN match approved`);
        } else {
          console.log(`  → ✗ EAN found but insufficient stock`);
        }
      } else if (fallbackFound) {
        // Only fallback found
        approved = fallbackAvailable >= want;
        matchMethod = 'fallback-only';
        if (approved) {
          fallbackMatches++;
          const normalizedStyle = normalize(r.Style!);
          const normalizedSize = normalize(r.Size!);
          const fallbackKey = `${normalizedStyle}|${matchedColor}|${normalizedSize}`;
          fallbackInv.set(fallbackKey, fallbackAvailable - want);
          console.log(`  → ⚠️ Fallback saved this match!`);
        } else {
          console.log(`  → ✗ Fallback found but insufficient stock`);
        }
      } else {
        // Neither found
        console.log(`  → ✗ Not approved (no match found)`);
      }
      
      return { ...r, approved, matchMethod };
    });
    
    console.log('[Nielsens Debug] Summary:');
    console.log(`  - Total rows: ${rows.length}`);
    console.log(`  - EAN matches: ${eanMatches}`);
    console.log(`  - Fallback matches: ${fallbackMatches}`);
    console.log(`  - Both agree: ${bothAgree}`);
    console.log(`  - Disagree: ${disagree}`);
    
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

  // Load all customers for dropdown overrides
  const { data: allCustomers } = useSWR('customers:all', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, customer_id, company, spy_id')
      .order('company', { ascending: true });
    if (error) throw error;
    return data as Array<{ id: string; customer_id: string; company: string; spy_id: string | null }>;
  }, { refreshInterval: 0 });

  // SpySystem stock order state
  const [spyOrderRuns, setSpyOrderRuns] = React.useState<Array<{
    shopName: string;
    customer_id: string | null;
    spy_customer_id_override: string | null;
    matchedCustomer: { customer_id: string; company: string; spy_id: string | null } | null;
    items: Array<{ style_no: string; color: string; sizes: string[]; qtyBySize: Record<string, number> }>;
    totalQty: number;
  }>>([]);
  const [spyOrderSeasonId, setSpyOrderSeasonId] = React.useState<number>(0);
  const [spyOrderPrepared, setSpyOrderPrepared] = React.useState(false);
  const [spyOrderEnqueueing, setSpyOrderEnqueueing] = React.useState(false);
  const [spyOrderJobIds, setSpyOrderJobIds] = React.useState<string[]>([]);

  function prepareSpyStockOrders() {
    if (!allCustomers || !ran || grouped.length === 0) return;

    // Build customer lookup
    const customerByCustomerId = new Map<string, typeof allCustomers[0]>();
    for (const c of allCustomers) {
      customerByCustomerId.set(c.customer_id, c);
    }

    // Group approved items by shop
    const runs: typeof spyOrderRuns = [];

    for (const g of grouped) {
      // Only include approved items
      const approvedItems = g.items.filter(it => it.approved);
      if (approvedItems.length === 0) continue;

      // Try to extract customer_id from ShopName or use ShopID
      let customer_id: string | null = null;
      
      // First, check if any item has ShopID that matches a customer_id
      for (const it of approvedItems) {
        if (it.ShopID && typeof it.ShopID === 'string') {
          if (customerByCustomerId.has(it.ShopID)) {
            customer_id = it.ShopID;
            break;
          }
        }
      }

      // Try to find by company name (fuzzy match)
      if (!customer_id) {
        const shopNameLower = g.shop.toLowerCase().trim();
        for (const c of allCustomers) {
          const companyLower = c.company.toLowerCase().trim();
          if (companyLower === shopNameLower || companyLower.includes(shopNameLower) || shopNameLower.includes(companyLower)) {
            customer_id = c.customer_id;
            break;
          }
        }
      }

      const matchedCustomer = customer_id ? customerByCustomerId.get(customer_id) || null : null;

      // Group by style_no + color
      const itemMap = new Map<string, typeof runs[0]['items'][0]>();
      
      for (const it of approvedItems) {
        const ean = normalizeEan(it.EAN);
        const eanInfo = eanMap.get(ean);
        const styleNo = eanInfo?.style_no || it.Style || '';
        const color = eanInfo?.color || it.Color || '';
        const size = eanInfo?.size || it.Size || '';
        const qty = it.Qty || 0;

        if (!styleNo || !color || !size) continue;

        const key = `${styleNo}|${color}`;
        let item = itemMap.get(key);
        
        if (!item) {
          // Get size order from availability
          let sizes: string[] = [size];
          const stockKey = `${normalize(styleNo)}|${normalize(color)}`;
          const stockInfo = availability.get(stockKey);
          if (stockInfo) {
            sizes = stockInfo.sizes;
          }
          
          item = {
            style_no: styleNo,
            color: color,
            sizes: sizes,
            qtyBySize: {}
          };
          itemMap.set(key, item);
        }

        // Add quantity
        item.qtyBySize[size] = (item.qtyBySize[size] || 0) + qty;
      }

      const items = Array.from(itemMap.values());
      const totalQty = items.reduce((sum, item) => {
        return sum + Object.values(item.qtyBySize).reduce((s, q) => s + q, 0);
      }, 0);

      runs.push({
        shopName: g.shop,
        customer_id: customer_id,
        spy_customer_id_override: null,
        matchedCustomer: matchedCustomer || null,
        items: items,
        totalQty: totalQty
      });
    }

    setSpyOrderRuns(runs);
    setSpyOrderPrepared(true);
    setSpyOrderJobIds([]);
  }

  async function sendSpyStockOrders() {
    if (spyOrderRuns.length === 0) return;

    setSpyOrderEnqueueing(true);
    setSpyOrderJobIds([]);

    try {
      const payload = {
        season_id: spyOrderSeasonId,
        runs: spyOrderRuns.map(run => ({
          customer_id: run.customer_id || '',
          spy_customer_id_override: run.spy_customer_id_override || undefined,
          items: run.items
        }))
      };

      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      const res = await fetch('/api/spy/stock-order/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || 'Failed to enqueue jobs');
      }

      const result = await res.json();
      setSpyOrderJobIds(result.jobIds || []);
      alert(`Successfully enqueued ${result.count} job(s)!`);
    } catch (error: any) {
      console.error('Failed to send spy stock orders:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setSpyOrderEnqueueing(false);
    }
  }

  // Detect size set from sizes array
  function detectSizeSet(sizes: string[]): string {
    const sizeStr = sizes.map(s => s.toUpperCase()).sort().join(',');
    
    // Define known size sets
    const sizeSetPatterns: Record<string, string[]> = {
      'XS-XL': ['XS', 'S', 'M', 'L', 'XL'],
      'S-XXL': ['S', 'M', 'L', 'XL', 'XXL'],
      '34-46': ['34', '36', '38', '40', '42', '44', '46'],
      '44-56': ['44', '46', '48', '50', '52', '54', '56'],
      '32-42': ['32', '34', '36', '38', '40', '42'],
    };
    
    for (const [name, pattern] of Object.entries(sizeSetPatterns)) {
      const patternStr = pattern.sort().join(',');
      if (sizeStr === patternStr || sizes.every(s => pattern.includes(s.toUpperCase()))) {
        return name;
      }
    }
    
    return 'Other';
  }

  // Build matrix view grouped by size set
  const matrixBySizeSet = React.useMemo(() => {
    if (!ran || grouped.length === 0) return [];
    
    const allItems = grouped.flatMap(g => g.items);
    
    // First, group by style to determine size set
    const byStyle = new Map<string, typeof allItems>();
    for (const item of allItems) {
      const ean = normalizeEan(item.EAN);
      const eanInfo = eanMap.get(ean);
      const styleNo = eanInfo?.style_no || item.Style || '';
      if (!styleNo) continue;
      
      const arr = byStyle.get(styleNo) || [];
      arr.push(item);
      byStyle.set(styleNo, arr);
    }
    
    // Build style info with size sets
    const styleInfos: Array<{
      styleNo: string;
      styleName: string;
      sizeSet: string;
      sizes: string[];
      items: typeof allItems;
    }> = [];
    
    for (const [styleNo, items] of byStyle.entries()) {
      const sizes = new Set<string>();
      for (const item of items) {
        const ean = normalizeEan(item.EAN);
        const eanInfo = eanMap.get(ean);
        const size = eanInfo?.size || item.Size || '';
        if (size) sizes.add(size);
      }
      const sizeArray = Array.from(sizes);
      const sizeSet = detectSizeSet(sizeArray);
      
      styleInfos.push({
        styleNo,
        styleName: styleNameByNo.get(styleNo) || '',
        sizeSet,
        sizes: sizeArray.sort(),
        items,
      });
    }
    
    // Group by size set
    const bySizeSet = new Map<string, typeof styleInfos>();
    for (const styleInfo of styleInfos) {
      const arr = bySizeSet.get(styleInfo.sizeSet) || [];
      arr.push(styleInfo);
      bySizeSet.set(styleInfo.sizeSet, arr);
    }
    
    // Build output structure
    return Array.from(bySizeSet.entries()).map(([sizeSet, styles]) => {
      // Get all unique sizes across all styles in this size set
      const allSizes = new Set<string>();
      for (const style of styles) {
        for (const size of style.sizes) {
          allSizes.add(size);
        }
      }
      const sizeArray = Array.from(allSizes).sort();
      
      // Build rows: one per style/color combination
      const rows: Array<{
        styleNo: string;
        styleName: string;
        color: string;
        cells: Record<string, { qty: number; approved: boolean }>;
        totalQty: number;
        approvedQty: number;
      }> = [];
      
      for (const style of styles) {
        // Get all colors for this style
        const colors = new Set<string>();
        for (const item of style.items) {
          const ean = normalizeEan(item.EAN);
          const eanInfo = eanMap.get(ean);
          const color = eanInfo?.color || item.Color || '';
          if (color) colors.add(color);
        }
        
        for (const color of Array.from(colors).sort()) {
          // Build cells for this style/color
          const cells: Record<string, { qty: number; approved: boolean }> = {};
          for (const size of sizeArray) {
            cells[size] = { qty: 0, approved: false };
          }
          
          let totalQty = 0;
          let approvedQty = 0;
          
          for (const item of style.items) {
            const ean = normalizeEan(item.EAN);
            const eanInfo = eanMap.get(ean);
            const itemColor = eanInfo?.color || item.Color || '';
            const itemSize = eanInfo?.size || item.Size || '';
            
            if (itemColor === color && itemSize && cells[itemSize]) {
              cells[itemSize].qty += item.Qty || 0;
              if (item.approved) {
                cells[itemSize].approved = true;
              }
              totalQty += item.Qty || 0;
              if (item.approved) {
                approvedQty += item.Qty || 0;
              }
            }
          }
          
          rows.push({
            styleNo: style.styleNo,
            styleName: style.styleName,
            color,
            cells,
            totalQty,
            approvedQty,
          });
        }
      }
      
      // Sort rows by style then color
      rows.sort((a, b) => a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color));
      
      const totalQty = rows.reduce((sum, r) => sum + r.totalQty, 0);
      const approvedQty = rows.reduce((sum, r) => sum + r.approvedQty, 0);
      
      return {
        sizeSet,
        sizes: sizeArray,
        rows,
        totalQty,
        approvedQty,
      };
    }).sort((a, b) => {
      // Sort by known size sets first, then alphabetically
      const order = ['S-XXL', 'XS-XL', '34-46', '44-56', '32-42', 'Other'];
      const aIdx = order.indexOf(a.sizeSet);
      const bIdx = order.indexOf(b.sizeSet);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.sizeSet.localeCompare(b.sizeSet);
    });
  }, [grouped, ran, eanMap, styleNameByNo]);

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
          <div className="text-xs text-gray-600">Upload Excel files. Map columns to: ShopID, ShopName, EAN, Qty, Costprice, RRP, Style, Color, Size (for fallback matching)</div>
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
              <div>
                <label className="block mb-1 font-medium">Style</label>
                <select
                  value={columnMapping.style || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, style: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Color</label>
                <select
                  value={columnMapping.color || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, color: e.target.value || undefined })}
                  className="w-full border rounded px-2 py-1"
                >
                  <option value="">—</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Size</label>
                <select
                  value={columnMapping.size || ''}
                  onChange={(e) => setColumnMapping({ ...columnMapping, size: e.target.value || undefined })}
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
                            <th className="p-2 text-left border-b">Method</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 && <tr><td colSpan={7} className="p-2 text-gray-500">—</td></tr>}
                          {rows.map((r, i) => {
                            const item = grouped.flatMap(g => g.items).find(it => {
                              const ean = normalizeEan(it.EAN);
                              return ean === r.ean && it.ShopName === s.shop;
                            });
                            return (
                              <tr key={i} className={r.approved ? '' : 'bg-red-50'}>
                                <td className="p-2 border-b">{r.style_no}{(() => { const nm = styleNameByNo.get(r.style_no) || ''; return nm ? ` · ${nm}` : ''; })()}</td>
                                <td className="p-2 border-b">{r.color}</td>
                                <td className="p-2 border-b">{r.size}</td>
                                <td className="p-2 border-b font-mono text-[10px]">{r.ean}</td>
                                <td className="p-2 border-b text-right">{r.qty}</td>
                                <td className="p-2 border-b">{r.approved ? 'Yes' : 'No'}</td>
                                <td className="p-2 border-b">
                                  {item?.matchMethod === 'ean-only' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">EAN</span>}
                                  {item?.matchMethod === 'fallback-only' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Fallback</span>}
                                  {item?.matchMethod === 'both-agree-yes' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800">Both ✓</span>}
                                  {item?.matchMethod === 'both-agree-no' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-800">Both ✗</span>}
                                  {item?.matchMethod === 'disagree' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800">Disagree</span>}
                                  {item?.matchMethod === 'none' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-50">
                            <td className="p-2 text-sm font-medium" colSpan={7}>Kan levere: {sumYes} — Kan ikke: {sumNo}</td>
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

      {ran && grouped.length > 0 && (
        <div className="rounded-md border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">SpySystem Stock Orders</div>
              <div className="text-xs text-gray-600 mt-1">Prepare and send approved orders to SpySystem</div>
            </div>
            <div className="flex gap-2">
              {!spyOrderPrepared && (
                <button
                  onClick={prepareSpyStockOrders}
                  disabled={!allCustomers}
                  className="text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Prepare Orders
                </button>
              )}
              {spyOrderPrepared && (
                <button
                  onClick={() => {
                    setSpyOrderPrepared(false);
                    setSpyOrderRuns([]);
                    setSpyOrderJobIds([]);
                  }}
                  className="text-xs px-3 py-1.5 border rounded bg-white hover:bg-slate-50"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          {spyOrderPrepared && spyOrderRuns.length > 0 && (
            <div className="space-y-3">
              {/* Season ID selector */}
              <div className="border-t pt-3">
                <label className="text-xs font-medium mb-1 block">SpySystem Season ID (0 = "-- Select --")</label>
                <input
                  type="number"
                  value={spyOrderSeasonId}
                  onChange={(e) => setSpyOrderSeasonId(Number(e.target.value))}
                  className="text-xs border rounded px-2 py-1 w-32"
                  placeholder="0"
                />
              </div>

              {/* Runs preview */}
              <div className="text-xs font-medium">
                {spyOrderRuns.length} customer(s) • {spyOrderRuns.reduce((s, r) => s + r.items.length, 0)} style/color(s) • {spyOrderRuns.reduce((s, r) => s + r.totalQty, 0)} pcs total
              </div>

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {spyOrderRuns.map((run, idx) => (
                  <div key={idx} className="border rounded p-2 bg-gray-50">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="text-xs font-semibold">{run.shopName}</div>
                        {run.matchedCustomer ? (
                          <div className="text-[11px] text-green-700 mt-0.5">
                            ✓ Matched: {run.matchedCustomer.company} (ID: {run.matchedCustomer.customer_id}, Spy ID: {run.matchedCustomer.spy_id || 'N/A'})
                          </div>
                        ) : (
                          <div className="text-[11px] text-red-700 mt-0.5">
                            ✗ No match found {run.customer_id ? `for customer_id: ${run.customer_id}` : ''}
                          </div>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-600">
                        {run.items.length} item(s) • {run.totalQty} pcs
                      </div>
                    </div>

                    {/* Customer override dropdown */}
                    <div className="mt-2">
                      <label className="text-[11px] font-medium mb-1 block">Override with different customer:</label>
                      <select
                        value={run.spy_customer_id_override || ''}
                        onChange={(e) => {
                          const newRuns = [...spyOrderRuns];
                          const targetRun = newRuns[idx];
                          if (!targetRun) return;
                          targetRun.spy_customer_id_override = e.target.value || null;
                          setSpyOrderRuns(newRuns);
                        }}
                        className="text-[11px] border rounded px-2 py-1 w-full max-w-md"
                      >
                        <option value="">-- Use matched customer --</option>
                        {allCustomers?.map(c => (
                          <option key={c.id} value={c.spy_id || ''}>
                            {c.company} (ID: {c.customer_id}, Spy: {c.spy_id || 'N/A'})
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Items preview */}
                    <details className="mt-2">
                      <summary className="text-[11px] font-medium cursor-pointer">Show {run.items.length} item(s)</summary>
                      <div className="mt-1 space-y-1 pl-3">
                        {run.items.map((item, itemIdx) => (
                          <div key={itemIdx} className="text-[10px] text-gray-700">
                            {item.style_no} · {item.color} · {Object.entries(item.qtyBySize).filter(([, q]) => q > 0).map(([size, qty]) => `${size}:${qty}`).join(', ')}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                ))}
              </div>

              {/* Send button */}
              <div className="border-t pt-3 flex items-center gap-3">
                <button
                  onClick={sendSpyStockOrders}
                  disabled={spyOrderEnqueueing || spyOrderRuns.some(r => !r.matchedCustomer && !r.spy_customer_id_override)}
                  className="text-xs px-4 py-2 border rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed font-medium"
                >
                  {spyOrderEnqueueing ? 'Sending...' : `Send ${spyOrderRuns.length} Order(s) to Worker`}
                </button>
                {spyOrderRuns.some(r => !r.matchedCustomer && !r.spy_customer_id_override) && (
                  <div className="text-[11px] text-red-600">
                    ⚠ Some customers are not matched. Please select overrides or remove them.
                  </div>
                )}
              </div>

              {/* Job IDs */}
              {spyOrderJobIds.length > 0 && (
                <div className="border-t pt-3">
                  <div className="text-xs font-medium mb-1">Enqueued Job IDs:</div>
                  <div className="text-[11px] font-mono text-gray-700 space-y-0.5">
                    {spyOrderJobIds.map(id => (
                      <div key={id}>
                        <a href={`/settings/jobs?id=${id}`} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                          {id}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {matrixBySizeSet.length > 0 && (
        <div className="space-y-4">
          <div className="text-sm font-semibold">Style Matrix View (Grouped by Size Set)</div>
          {matrixBySizeSet.map((sizeSetGroup) => (
            <div key={sizeSetGroup.sizeSet} className="rounded-md border bg-white overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b">
                <div className="text-sm font-semibold">
                  Size Set: {sizeSetGroup.sizeSet}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Total: {sizeSetGroup.totalQty} pcs — Approved: {sizeSetGroup.approvedQty} pcs — Not available: {sizeSetGroup.totalQty - sizeSetGroup.approvedQty} pcs
                </div>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left border-b sticky left-0 bg-gray-50 z-10 min-w-[200px]">Style</th>
                      <th className="p-2 text-left border-b sticky left-[200px] bg-gray-50 z-10 min-w-[100px]">Color</th>
                      {sizeSetGroup.sizes.map(size => (
                        <th key={size} className="p-2 text-center border-b min-w-[60px]">{size}</th>
                      ))}
                      <th className="p-2 text-center border-b min-w-[80px]">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sizeSetGroup.rows.map((row, idx) => (
                      <tr key={`${row.styleNo}-${row.color}`}>
                        <td className="p-2 border-b sticky left-0 bg-white z-10">
                          <div className="font-medium">{row.styleNo}</div>
                          {row.styleName && <div className="text-[10px] text-slate-600">{row.styleName}</div>}
                        </td>
                        <td className="p-2 border-b font-medium sticky left-[200px] bg-white z-10">{row.color}</td>
                        {sizeSetGroup.sizes.map(size => {
                          const cell = row.cells[size];
                          if (!cell || cell.qty === 0) {
                            return <td key={size} className="p-2 border-b text-center text-gray-300">—</td>;
                          }
                          const bgClass = cell.approved ? 'bg-green-50' : 'bg-red-50';
                          return (
                            <td key={size} className={`p-2 border-b text-center font-medium ${bgClass}`}>
                              {cell.qty}
                            </td>
                          );
                        })}
                        <td className="p-2 border-b text-center font-semibold">
                          <div>{row.totalQty}</div>
                          <div className="text-[10px] text-slate-600">({row.approvedQty}/{row.totalQty})</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
