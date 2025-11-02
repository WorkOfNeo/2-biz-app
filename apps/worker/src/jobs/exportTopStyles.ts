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

export async function exportTopStyles(ctx: Ctx) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:top_styles_export_begin', job.payload || {});
    // Determine season
    let seasonId: string | null = (job.payload as any)?.season_id ?? null;
    if (!seasonId) {
      try { const { data } = await supabase.from('seasons').select('id').eq('is_current', true).maybeSingle(); seasonId = (data?.id as string | undefined) || null; } catch {}
    }
    if (!seasonId) throw new Error('No current season set');
    await log(job.id, 'info', 'STEP:top_styles_export_season', { season_id: seasonId });
    // Fetch top 10 and suppliers
    const { data: rows } = await supabase
      .from('top_styles')
      .select('id, style_no, style_name, image_url, type, quality, qty, dg')
      .eq('season_id', seasonId)
      .order('qty', { ascending: false })
      .limit(10);
    const list = (rows ?? []) as Array<{ id: string; style_no: string; style_name?: string | null; image_url?: string | null; type?: string | null; quality?: string | null; qty: number; dg?: string | null }>;
    await log(job.id, 'info', 'STEP:top_styles_export_rows', { count: list.length });
    // Season display name
    let seasonName = 'Season';
    try {
      const { data: srow } = await supabase.from('seasons').select('name, year').eq('id', seasonId).maybeSingle();
      const nm = (srow?.name as string | undefined) || 'Season';
      const yr = (srow?.year as number | undefined) || undefined;
      seasonName = yr ? `${nm} ${yr}` : nm;
    } catch {}
    let supplierByStyle = new Map<string, string | null>();
    if (list.length) {
      try {
        const { data: s } = await supabase.from('styles').select('style_no, supplier').in('style_no', list.map(r => r.style_no));
        for (const r of (s ?? []) as any[]) supplierByStyle.set(r.style_no as string, (r.supplier as string | null) ?? null);
      } catch {}
      await log(job.id, 'info', 'STEP:top_styles_export_suppliers_resolved', { mapped: supplierByStyle.size });
    }
    const styles = StyleSheet.create({
      page: { padding: 16, fontSize: 9, color: '#0f172a' },
      h1: { fontSize: 16, marginBottom: 2 },
      sub: { fontSize: 10, color: '#64748b', marginBottom: 6 },
      header: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff' },
      cell: { padding: 4, fontSize: 8 },
      row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
      left: { textAlign: 'left' },
      right: { textAlign: 'right' },
      img: { width: 28, height: 28, objectFit: 'cover' as any, borderRadius: 4 },
    });
    const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) => React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : styles.right, extra || {}] }, txt);
    const Head = React.createElement(View, { style: styles.header },
      Cell('#', '6%','left'), Cell('Image','10%','left'), Cell('Style No','16%','left'), Cell('Style Name','20%','left'), Cell('Supplier','16%','left'), Cell('DG','10%','left'), Cell('Type','10%','left'), Cell('Quality','7%','left'), Cell('Qty','5%','right')
    );
    const body = list.map((r, i) => React.createElement(View, { style: styles.row },
      Cell(String(i+1), '6%','left'),
      React.createElement(View, { style: [{ width: '10%' as any, padding: 4 }] }, r.image_url ? React.createElement(Image, { style: styles.img, src: r.image_url }) : React.createElement(Text, { style: styles.cell }, '')),
      Cell(r.style_no, '16%','left'),
      Cell(r.style_name || '—', '20%','left'),
      Cell(supplierByStyle.get(r.style_no) || '—', '16%','left'),
      Cell((r.dg || '') + '', '10%','left'),
      Cell(r.type || '—', '10%','left'),
      Cell(r.quality || '—', '7%','left'),
      Cell(new Intl.NumberFormat('da-DK').format(Math.round(Number(r.qty || 0))), '5%','right')
    ));
    const doc = React.createElement(
      Document,
      null,
      React.createElement(
        PdfPage,
        { size: 'A4', style: styles.page },
        React.createElement(Text, { style: styles.h1 }, 'Top 10 Styles'),
        React.createElement(Text, { style: styles.sub }, seasonName),
        Head,
        ...body
      )
    );
    await log(job.id, 'info', 'STEP:top_styles_export_pdf_building');
    const out = await pdf(doc).toBuffer();
    const buf = await ensureBuffer(out as any);
    const path = `top_styles/${job.id}/top_styles.pdf`;
    try {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const { error: upErr } = await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      await log(job.id, 'info', 'STEP:top_styles_export_uploaded', { path });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_upload_failed', { error: e?.message || String(e) });
      throw e;
    }
    let publicUrl: string | null = null;
    try {
      const { data: pub } = supabase.storage.from('exports').getPublicUrl(path);
      publicUrl = pub?.publicUrl ?? null;
      await log(job.id, 'info', 'STEP:top_styles_export_public_url', { publicUrl });
    } catch {}
    try {
      const { error: insErr } = await supabase.from('exports').insert({ kind: 'top_styles_pdf', title: 'Top 10 Styles', path, public_url: publicUrl, job_id: job.id, meta: { season_id: seasonId } });
      if (insErr) throw insErr;
      await log(job.id, 'info', 'STEP:top_styles_export_row_inserted', { path, publicUrl });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_row_failed', { error: e?.message || String(e) });
      throw e;
    }
    await saveResult(job.id, 'export_top_styles_pdf', { file: { path, publicUrl }, season_id: seasonId });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

async function ensureBuffer(data: any): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data as Buffer;
  if (data instanceof Uint8Array) return Buffer.from(data as Uint8Array);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data as ArrayBuffer));
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


