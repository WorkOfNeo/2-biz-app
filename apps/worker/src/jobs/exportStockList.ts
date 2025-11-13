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
    // Load lists from app_settings
    const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'style_lists').maybeSingle();
    const lists: Record<string, string[]> = (((setting?.value || {}) as any).lists || {}) as Record<string, string[]>;
    const listEntries = Object.entries(lists).filter(([_, arr]) => Array.isArray(arr) && arr.length > 0);
    if (listEntries.length === 0) {
      await setJobFailedOrRequeue(job, 'No style lists found');
      return;
    }
    let generated = 0;
    for (const [listName, styleNos] of listEntries) {
      await log(job.id, 'info', 'STEP:export_stock_list_list', { listName, count: styleNos.length });
      // Fetch style meta
      const { data: styleRows } = await supabase.from('styles').select('style_no, style_name, image_url, supplier').in('style_no', styleNos);
      const metaByNo = new Map<string, { name: string | null; image: string | null; supplier: string | null }>();
      for (const r of (styleRows ?? []) as any[]) metaByNo.set(r.style_no, { name: r.style_name ?? null, image: r.image_url ?? null, supplier: r.supplier ?? null });
      // Fetch stock rows
      const { data: stockRows } = await supabase
        .from('style_stock')
        .select('style_no, color, section, row_label, values, scraped_at')
        .in('style_no', styleNos)
        .order('scraped_at', { ascending: false })
        .limit(100000);
      type Row = { style_no: string; color: string; section: string; row_label: string | null; values: any; scraped_at: string };
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
        for (const [color, rows] of byColor.entries()) {
          const latestMap = new Map<string, Row>();
          for (const r of rows) {
            const key = `${r.section}|${r.row_label ?? ''}`;
            const prev = latestMap.get(key);
            if (!prev || new Date(r.scraped_at).getTime() > new Date(prev.scraped_at).getTime()) latestMap.set(key, r);
          }
          const latestRows = Array.from(latestMap.values());
          const stockRow = latestRows.find(r => r.section === 'Stock');
          const soldRows = latestRows.filter(r => r.section === 'Sold');
          const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
          const sizes = (stockRow?.values ? (rows.find(r => r.section === 'Stock') as any)?.sizes : null)
            || (latestRows[0] as any)?.sizes || [];
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
              for (let i = 0; i < num; i++) base[i] += Number(vals[i] ?? 0) || 0;
            }
            return base;
          })();
          const purchaseArr = ((): number[] => {
            const base = zero.slice();
            for (const r of purchaseRows) {
              const vals = ensureNums(r.values);
              for (let i = 0; i < num; i++) base[i] += Number(vals[i] ?? 0) || 0;
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
      // Build PDF document: per style, image left, color/sections table right (sizes grid)
      const styles = StyleSheet.create({
        page: { padding: 16, fontSize: 9, color: '#0f172a' },
        h1: { fontSize: 14, marginBottom: 6 },
        block: { marginBottom: 10, borderBottom: 0.5, borderColor: '#e5e7eb', paddingBottom: 6 },
        row: { flexDirection: 'row', gap: 8 },
        left: { width: 84 },
        img: { width: 80, height: 80, objectFit: 'cover' as any },
        meta: { fontSize: 9, marginBottom: 4 },
        tableHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', color: '#000', borderBottom: 0.5, borderColor: '#cbd5e1' },
        tableRow: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
        th: { padding: 4, fontSize: 9, fontWeight: 700 as any },
        cell: { padding: 4, fontSize: 9 },
        leftCell: { textAlign: 'left' as any },
        rightCell: { textAlign: 'right' as any },
        green: { color: '#16a34a' },
        red: { color: '#dc2626' }
      });
      const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) =>
        React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.leftCell : styles.rightCell, extra || {}] }, txt);
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      // Order styles as provided by the list
      const stylesOrder = new Map<string, number>(); styleNos.forEach((no, idx) => stylesOrder.set(no, idx));
      const grouped = new Map<string, Array<(typeof out)[number]>>();
      for (const r of out) {
        if (!grouped.has(r.style_no)) grouped.set(r.style_no, []);
        grouped.get(r.style_no)!.push(r);
      }
      const orderedStyles = Array.from(grouped.keys()).sort((a, b) => (stylesOrder.get(a)! - stylesOrder.get(b)!));
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
            meta.supplier ? React.createElement(Text, { style: styles.meta }, meta.supplier) : null,
          )
        );
        // Dynamic widths for size columns area
        const colorW = '22%';
        const sectionW = '14%';
        const sizeW = `${Math.max(6, Math.floor((100 - 22 - 14 - 10) / maxSizeCount))}%`; // leave ~10% for Total
        const totalW = '10%';
        const headSizes: any[] = [];
        for (let i = 0; i < maxSizeCount; i++) headSizes.push(Cell(colors[0]?.sizes?.[i] || '', sizeW, 'right', styles.th));
        const tableHead = React.createElement(View, { style: styles.tableHeader },
          Cell('Color', colorW, 'left', styles.th),
          Cell('Section', sectionW, 'left', styles.th),
          ...headSizes,
          Cell('Total', totalW, 'right', styles.th)
        );
        const rows: any[] = [];
        for (const c of colors) {
          const sizes = c.sizes || [];
          const pad = (arr: number[]) => Array.from({ length: maxSizeCount }, (_, i) => Number(arr?.[i] ?? 0) || 0);
          const stockArr = pad(c.stockArr);
          const soldArr = pad(c.soldArr);
          const purchaseArr = pad(c.purchaseArr);
          const availArr = pad(c.availableArr);
          const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
          // Stock row
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-stock` },
            Cell(c.color, colorW, 'left'),
            Cell('Stock', sectionW, 'left'),
            ...stockArr.map((v, i) => Cell(String(v || ''), sizeW, 'right')),
            Cell(fmt(sum(stockArr)), totalW, 'right')
          ));
          // Sold (sum)
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-sold` },
            Cell('', colorW, 'left'),
            Cell('Sold (sum)', sectionW, 'left'),
            ...soldArr.map((v) => Cell(v ? `-${v}` : '', sizeW, 'right', v ? styles.red : undefined)),
            Cell(c.sold ? `-${fmt(Math.abs(c.sold))}` : '', totalW, 'right', c.sold ? styles.red : undefined)
          ));
          // Purchase (sum)
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-purchase` },
            Cell('', colorW, 'left'),
            Cell('Purchase (sum)', sectionW, 'left'),
            ...purchaseArr.map((v) => Cell(v ? String(v) : '', sizeW, 'right', v ? styles.green : undefined)),
            Cell(c.purchase ? fmt(c.purchase) : '', totalW, 'right', c.purchase ? styles.green : undefined)
          ));
          // Available
          rows.push(React.createElement(View, { style: styles.tableRow, key: `${style_no}-${c.color}-available` },
            Cell('', colorW, 'left'),
            Cell('Available', sectionW, 'left'),
            ...availArr.map((v) => {
              const style = v < 0 ? styles.red : v > 0 ? styles.green : undefined;
              return Cell(v ? String(v) : '', sizeW, 'right', style);
            }),
            Cell(c.available ? fmt(c.available) : '', totalW, 'right', c.available < 0 ? styles.red : c.available > 0 ? styles.green : undefined)
          ));
        }
        return React.createElement(View, { style: styles.block, key: style_no }, header, tableHead, ...rows);
      });
      const doc = React.createElement(Document, null, React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page }, React.createElement(Text, { style: styles.h1 }, `Stock List · ${listName}`), ...blocks));
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


