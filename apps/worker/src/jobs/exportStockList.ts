import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View, Image } from '@react-pdf/renderer';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  supabase: any;
};

export async function exportStockList(ctx: Ctx) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:export_stock_list_begin', {});
    // Load lists from DB
    const { data: lists } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    const listRows = (lists ?? []) as Array<{ id: string; name: string }>;
    if (listRows.length === 0) {
      await setJobFailedOrRequeue(job, 'No stock lists found');
      return;
    }
    let generated = 0;
    for (const list of listRows) {
      const listId = list.id;
      const listName = list.name || 'List';
      // Load styles for this list
      const { data: styleItems } = await supabase.from('stock_list_styles').select('style_id').eq('list_id', listId);
      const styleIds = ((styleItems ?? []) as Array<{ style_id: string }>).map((r) => r.style_id).filter(Boolean);
      await log(job.id, 'info', 'STEP:export_stock_list_list', { listName, count: styleIds.length });
      if (styleIds.length === 0) {
        await log(job.id, 'info', 'STEP:export_stock_list_skip_empty', { listName });
        continue;
      }
      // Fetch style meta (include supplier for grouping)
      const { data: styleRows } = await supabase.from('styles').select('id, style_no, style_name, image_url, supplier').in('id', styleIds);
      const metaByNo = new Map<string, { id: string | null; name: string | null; image: string | null; supplier: string | null }>();
      const finalStyleNos: string[] = [];
      for (const r of (styleRows ?? []) as any[]) {
        metaByNo.set(r.style_no, { id: (r.id as string) || null, name: r.style_name ?? null, image: r.image_url ?? null, supplier: r.supplier ?? null });
        if (r.style_no) finalStyleNos.push(r.style_no as string);
      }
      // Map colors per style_id -> colorLower -> style_color_id
      const styleColorIdMap = new Map<string, Map<string, string>>();
      if (styleIds.length) {
        const { data: cols } = await supabase.from('style_colors').select('id, style_id, color').in('style_id', styleIds);
        for (const c of (cols ?? []) as any[]) {
          const sid = String(c.style_id || '');
          const key = String(c.color || '').trim().toLowerCase();
          if (!styleColorIdMap.has(sid)) styleColorIdMap.set(sid, new Map());
          styleColorIdMap.get(sid)!.set(key, c.id as string);
        }
      }
      // Load per-list color rules; support blacklist (include=false) and legacy whitelist (include=true)
      const includeMap = new Map<string, boolean>(); // style_color_id -> include flag
      const byStyleFlags = new Map<string, { hasIncludeTrue: boolean; hasIncludeFalse: boolean }>();
      const { data: ruleRows } = await supabase.from('stock_list_colors').select('style_id, style_color_id, include').eq('list_id', listId);
      for (const r of (ruleRows ?? []) as any[]) {
        const sid = String(r.style_id || '');
        includeMap.set(r.style_color_id as string, r.include === true);
        const prev = byStyleFlags.get(sid) || { hasIncludeTrue: false, hasIncludeFalse: false };
        if (r.include === true) prev.hasIncludeTrue = true; else prev.hasIncludeFalse = true;
        byStyleFlags.set(sid, prev);
      }
      // Fetch stock rows
      const { data: stockRows } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, scraped_at')
        .in('style_no', finalStyleNos)
        .order('scraped_at', { ascending: false })
        .limit(100000);
      type Row = { style_no: string; color: string; sizes: string[]; section: string; row_label: string | null; values: any; scraped_at: string };
      const ensureNums = (arr: any): number[] => {
        try { return Array.isArray(arr) ? (arr as any[]).map((x) => Number(x||0) || 0) : Array.from(JSON.parse(String(arr||'[]'))).map((x:any)=>Number(x||0)||0); } catch { return []; }
      };
      // Group by style -> color, pick latest rows per (section,row_label), then compute size arrays and totals
      const byStyle = new Map<string, Map<string, Row[]>>();
      for (const rr of (stockRows ?? []) as any[]) {
        const s = String(rr.style_no || ''); const c = String(rr.color || '');
        if (!byStyle.has(s)) byStyle.set(s, new Map());
        const byColor = byStyle.get(s)!;
        if (!byColor.has(c)) byColor.set(c, []);
        byColor.get(c)!.push(rr as Row);
      }
      const out: Array<{ style_no: string; color: string; sizes: string[]; stockArr: number[]; soldArr: number[]; purchaseArr: number[]; availableArr: number[]; stock: number; sold: number; purchase: number; available: number }> = [];
      for (const [style_no, byColor] of byStyle.entries()) {
        const metaEntry = metaByNo.get(style_no) || { id: null, name: null, image: null };
        const sid = metaEntry.id || null;
        for (const [color, rows] of byColor.entries()) {
          // Respect per-list color include/hide rules
          if (sid) {
            const cmap = styleColorIdMap.get(sid) || new Map<string, string>();
            const scId = cmap.get(String(color || '').trim().toLowerCase()) || null;
            const flags = byStyleFlags.get(sid) || { hasIncludeTrue: false, hasIncludeFalse: false };
            if (flags.hasIncludeFalse) {
              // Blacklist: hide colors that have include=false rows
              if (!scId) continue;
              const allow = includeMap.get(scId) !== false; // explicit false hides
              if (!allow) continue;
            } else if (flags.hasIncludeTrue) {
              // Legacy whitelist: show only include=true
              if (!scId) continue;
              const allow = includeMap.get(scId) === true;
              if (!allow) continue;
            }
          }
          const latestMap = new Map<string, Row>();
          let uniqueIdCounter = 0;
          
          // Group rows by (section, row_label) and keep latest, OR keep all if row_label is null
          for (const r of rows) {
            const normalizedLabel = String(r.row_label ?? '').trim();
            
            if (normalizedLabel) {
              // Has a PO number: deduplicate by keeping only latest scraped_at for this PO
              const key = `${r.section}|${normalizedLabel}`;
              const prev = latestMap.get(key);
              if (!prev || new Date(r.scraped_at).getTime() > new Date(prev.scraped_at).getTime()) {
                latestMap.set(key, r);
              }
            } else {
              // No PO number (NULL/empty): treat each row as a unique unnamed PO
              // Use a unique counter to ensure each gets summed
              latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
            }
          }
          const latestRows = Array.from(latestMap.values());
          const stockRow = latestRows.find(r => r.section === 'Stock');
          const soldRows = latestRows.filter(r => r.section === 'Sold');
          const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
          const sizes = (stockRow?.sizes && Array.isArray(stockRow.sizes)) ? (stockRow.sizes as string[]) : (Array.isArray((latestRows[0] as any)?.sizes) ? ((latestRows[0] as any)?.sizes as string[]) : []);
          const num = sizes.length || 0;
          const zero = Array.from({ length: num }, () => 0);
          const stockArr = stockRow ? ((): number[] => {
            const arr = ensureNums(stockRow.values);
            return Array.from({ length: num }, (_, i) => Number(arr[i] ?? 0) || 0);
          })() : zero.slice();
          const soldArr = ((): number[] => {
            const base = zero.slice();
            for (const r of soldRows) {
              const vals = ensureNums(r.values);
              for (let i = 0; i < num; i++) base[i] = (Number(base[i] ?? 0) + (Number(vals[i] ?? 0) || 0));
            }
            return base;
          })();
          const purchaseArr = ((): number[] => {
            const base = zero.slice();
            for (const r of purchaseRows) {
              const vals = ensureNums(r.values);
              for (let i = 0; i < num; i++) base[i] = (Number(base[i] ?? 0) + (Number(vals[i] ?? 0) || 0));
            }
            return base;
          })();
          const availableArr = stockArr.map((v, i) => v - (soldArr[i] ?? 0) + (purchaseArr[i] ?? 0));
          const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
          const stock = sum(stockArr);
          const sold = sum(soldArr);
          const purchase = sum(purchaseArr);
          const available = sum(availableArr);
          out.push({ style_no, color, sizes, stockArr, soldArr, purchaseArr, availableArr, stock, sold, purchase, available });
        }
      }
      // Establish a stable number of size columns across all styles in the list (min 8)
      let maxSizeCount = 0;
      for (const r of out) maxSizeCount = Math.max(maxSizeCount, r.sizes.length);
      maxSizeCount = Math.max(8, maxSizeCount);
      // Build PDF document:
      // - Per style "block" with image/meta on the left
      // - On the right: one compact "table" per color with its own header and spacing between tables
      // - Each color table shows Section rows (Stock, Sold, Purchase, Available) with per-size columns and a Total
      // Apply 80% scale across sizes/paddings/fonts
      const SCALE = 0.8;
      const s = (n: number) => Math.max(0.5, n * SCALE);
      const styles = StyleSheet.create({
        page: { padding: s(16), fontSize: s(9), color: '#0f172a' },
        // Center title and add extra spacing before first style block
        h1: { fontSize: s(14), marginBottom: s(20), textAlign: 'center' as any },
        block: { marginBottom: s(10), borderBottom: 0.5, borderColor: '#e5e7eb', paddingBottom: s(6) },
        row: { flexDirection: 'row', gap: s(8) },
        left: { width: s(84) },
        leftPanel: { width: s(120) },
        // Ensure images never get cut off
        img: { width: s(80), height: s(80), objectFit: 'contain' as any },
        meta: { fontSize: s(9), marginBottom: s(4) },
        colorTable: { marginBottom: s(22) },
        tableHeader: { flexDirection: 'row', backgroundColor: '#f7f7f7', color: '#000', borderBottom: 0.5, borderColor: '#cbd5e1' },
        tableRow: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
        th: { padding: s(3), fontSize: s(8), fontWeight: 700 as any },
        cell: { padding: s(3), fontSize: s(8) },
        leftCell: { textAlign: 'left' as any },
        rightCell: { textAlign: 'right' as any },
        bold: { fontWeight: 700 as any },
        green: { color: '#16a34a' },
        red: { color: '#dc2626' }
      });
      const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) =>
        React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.leftCell : styles.rightCell, extra || {}] }, txt);
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      // Group by style
      const grouped = new Map<string, Array<(typeof out)[number]>>();
      for (const r of out) {
        if (!grouped.has(r.style_no)) grouped.set(r.style_no, []);
        grouped.get(r.style_no)!.push(r);
      }
      // Sort by supplier first, then A-Z by style_no within each supplier
      const orderedStyles = Array.from(grouped.keys()).sort((a, b) => {
        const supplierA = (metaByNo.get(a)?.supplier || '').toLowerCase();
        const supplierB = (metaByNo.get(b)?.supplier || '').toLowerCase();
        // First by supplier
        const bySupplier = supplierA.localeCompare(supplierB);
        if (bySupplier !== 0) return bySupplier;
        // Then by style_no within supplier
        return a.localeCompare(b);
      });
      const blocks = orderedStyles.map((style_no) => {
        const meta = metaByNo.get(style_no) || { name: null, image: null, supplier: null };
        const colors = (grouped.get(style_no) || []).sort((a, b) => a.color.localeCompare(b.color));
        const header = React.createElement(View, { style: styles.row },
          React.createElement(View, { style: styles.left },
            meta.image ? React.createElement(Image, { style: styles.img, src: meta.image }) : React.createElement(View, { style: [styles.img, { backgroundColor: '#f8fafc', border: 0.5, borderColor: '#e2e8f0' }] })
          ),
          React.createElement(View, { style: { flex: 1 } },
            React.createElement(Text, { style: styles.meta }, style_no),
            React.createElement(Text, { style: [styles.meta, { fontSize: 11, fontWeight: 700 as any }] }, meta.name || '—'),
          )
        );
        // Column widths (percentages) - keep sizes compact
        const imageW = '10%';
        const colorW = '18%';
        const sectionW = '14%';
        const sizeW = `${Math.max(4, Math.floor((100 - 18 - 14 - 10) / maxSizeCount))}%`; // leave ~10% for Total
        const totalW = '10%';

        // For each color, render its own header + rows as an isolated "table" with bottom spacing
        const colorTables: any[] = [];
        for (const c of colors) {
          const sizes = c.sizes || [];
          const pad = (arr: number[]) => Array.from({ length: maxSizeCount }, (_, i) => Number(arr?.[i] ?? 0) || 0);
          const stockArr = pad(c.stockArr);
          const soldArr = pad(c.soldArr);
          const purchaseArr = pad(c.purchaseArr);
          const availArr = pad(c.availableArr);
          const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
          // Build color-specific table header (uses this color's size labels, padded with blanks)
          const colorHeadSizes: any[] = [];
          for (let i = 0; i < maxSizeCount; i++) colorHeadSizes.push(Cell(sizes[i] || '', sizeW, 'right', styles.th));
          const tableHead = React.createElement(View, { style: styles.tableHeader },
            Cell('Color', colorW, 'left', styles.th),
            Cell('', sectionW, 'left', styles.th),
            ...colorHeadSizes,
            Cell('Total', totalW, 'right', styles.th)
          );
          const rows: any[] = [];
          // Stock row
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-stock` },
            Cell(c.color, colorW, 'left', styles.bold),
            Cell('På lager', sectionW, 'left', styles.bold),
            ...Array.from({ length: maxSizeCount }, (_, i) => {
              const within = i < sizes.length;
              const v = stockArr[i] || 0;
              return Cell(within ? String(v) : '', sizeW, 'right', styles.bold);
            }),
            Cell(fmt(sum(stockArr)), totalW, 'right', styles.bold)
          ));
          // Sold (sum)
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-sold` },
            Cell('', colorW, 'left'),
            Cell('Solgt', sectionW, 'left'),
            ...Array.from({ length: maxSizeCount }, (_, i) => {
              const within = i < sizes.length;
              const v = soldArr[i] || 0;
              return Cell(within ? (v > 0 ? `-${v}` : String(v)) : '', sizeW, 'right', v > 0 ? styles.red : undefined);
            }),
            Cell(c.sold ? `-${fmt(Math.abs(c.sold))}` : '', totalW, 'right', c.sold ? styles.red : undefined)
          ));
          // Purchase (sum)
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-purchase` },
            Cell('', colorW, 'left'),
            Cell('Indkøb', sectionW, 'left'),
            ...Array.from({ length: maxSizeCount }, (_, i) => {
              const within = i < sizes.length;
              const v = purchaseArr[i] || 0;
              return Cell(within ? String(v) : '', sizeW, 'right', v > 0 ? styles.green : undefined);
            }),
            Cell(c.purchase ? fmt(c.purchase) : '', totalW, 'right', c.purchase ? styles.green : undefined)
          ));
          // Available
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-available` },
            Cell('', colorW, 'left'),
            Cell('Disponibel', sectionW, 'left', styles.bold),
            ...Array.from({ length: maxSizeCount }, (_, i) => {
              const within = i < sizes.length;
              const v = availArr[i] || 0;
              const style = v < 0 ? styles.red : v > 0 ? styles.green : undefined;
              return Cell(within ? String(v) : '', sizeW, 'right', [styles.bold, style].filter(Boolean));
            }),
            Cell(c.available ? fmt(c.available) : '', totalW, 'right', [styles.bold, (c.available < 0 ? styles.red : (c.available > 0 ? styles.green : undefined))].filter(Boolean))
          ));
          // Push one color table (header + 4 rows) with spacing
          colorTables.push(React.createElement(View, { style: styles.colorTable, key: `${style_no}-${c.color}` }, tableHead, ...rows));
        }
        // A style "block" now contains the left image/meta column and a vertical stack of color tables on the right
        const leftColumn = React.createElement(View, { style: styles.leftPanel },
          // image
          meta.image ? React.createElement(Image, { style: styles.img, src: meta.image }) : React.createElement(View, { style: [styles.img, { backgroundColor: '#f8fafc', border: 0.5, borderColor: '#e2e8f0' }] }),
          // meta (style no, name, supplier)
          React.createElement(Text, { style: styles.meta }, style_no),
          React.createElement(Text, { style: [styles.meta, { fontSize: 11, fontWeight: 700 as any }] }, meta.name || '—'),
        );
        const rightColumn = React.createElement(View, { style: { flex: 1 } }, ...colorTables);
        // Keep a whole style block together on one page to avoid image/table splitting
        return React.createElement(View, { style: [styles.block, styles.row], key: style_no, wrap: false as any }, leftColumn, rightColumn);
      });
      // Compute list-level totals for footer summary
      const totalsAll = ((): { stock: number; sold: number; purchase: number; available: number } => {
        let s = 0, so = 0, p = 0, a = 0;
        for (const r of out) { s += r.stock; so += r.sold; p += r.purchase; a += r.available; }
        return { stock: s, sold: so, purchase: p, available: a };
      })();
      const footer = React.createElement(View, { style: { marginTop: 16 } as any },
        React.createElement(Text, null, `På lager: ${fmt(totalsAll.stock)}`),
        React.createElement(Text, null, `Solgt: ${fmt(Math.abs(totalsAll.sold))}`),
        React.createElement(Text, null, `Indkøbt: ${fmt(totalsAll.purchase)}`),
        React.createElement(Text, null, `Disponibel: ${fmt(totalsAll.available)}`)
      );
      const doc = React.createElement(Document, null, React.createElement(PdfPage, { size: 'A4', orientation: 'portrait', style: styles.page }, React.createElement(Text, { style: styles.h1 }, `Stock List · ${listName}`), ...blocks, footer));
      let outPdf = await pdf(doc).toBuffer();
      let buf = await ensureBuffer(outPdf);
      // Safety: if renderer produced an empty buffer, emit a tiny placeholder so we don't upload 0 bytes
      if (!buf || buf.length === 0) {
        await log(job.id, 'error', 'STEP:export_stock_list_empty_pdf', { listName });
        const placeholder = React.createElement(Document, null,
          React.createElement(PdfPage, { size: 'A4', style: { padding: 24 } as any },
            React.createElement(Text, null, `Stock List · ${listName}`),
            React.createElement(Text, null, 'No data available')
          )
        );
        outPdf = await pdf(placeholder).toBuffer();
        buf = await ensureBuffer(outPdf);
      }
      const safeName = listName.replace(/[^a-z0-9_-]+/gi, '_');
      const path = `stock_list/${job.id}/${safeName}.pdf`;
      try {
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'stock_list_pdf', title: `Stock List · ${listName}`, path, public_url: publicUrl, job_id: job.id, meta: { list: listName } }); } catch {}
      generated++;
    }
    await saveResult(job.id, 'export_stock_list_done', { generated });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

async function ensureBuffer(data: any): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data as Buffer;
  if (data instanceof Uint8Array) return Buffer.from(data as Uint8Array);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data as ArrayBuffer));
  // Web ReadableStream
  if (data && typeof (data as any).getReader === 'function') {
    const reader = (data as any).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((u) => Buffer.from(u)));
  }
  // Node stream
  if (data && typeof (data as any).on === 'function') {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      (data as any).on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      (data as any).on('end', () => resolve());
      (data as any).on('error', (err: any) => reject(err));
    });
    return Buffer.concat(chunks);
  }
  if (typeof data === 'string') return Buffer.from(data as string);
  return Buffer.from([]);
}


