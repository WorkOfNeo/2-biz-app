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
    // Fetch ALL top styles (we'll filter exclusions then take top 15)
    const { data: rows } = await supabase
      .from('top_styles')
      .select('id, style_no, style_name, image_url, color, type, quality, qty, dg')
      .eq('season_id', seasonId)
      .order('qty', { ascending: false });
    let list = (rows ?? []) as Array<{ id: string; style_no: string; style_name?: string | null; image_url?: string | null; color?: string | null; type?: string | null; quality?: string | null; qty: number; dg?: string | null }>;
    // Apply exclusions from settings BEFORE taking top 15
    try {
      const exKey = `top_styles_excluded:${seasonId}`;
      const { data: exSeason } = await supabase.from('app_settings').select('value').eq('key', exKey).maybeSingle();
      const { data: exGlobal } = await supabase.from('app_settings').select('value').eq('key', 'top_styles_excluded_global').maybeSingle();
      const seasonList = (((exSeason?.value as any)?.styleNos as string[] | undefined) ?? []).map(String);
      const globalList = (((exGlobal?.value as any)?.styleNos as string[] | undefined) ?? []).map(String);
      const exSet = new Set<string>([...seasonList, ...globalList]);
      if (exSet.size > 0) {
        list = list.filter((r) => !exSet.has(String(r.style_no)));
      }
    } catch {}
    // NOW take top 15 after exclusions (matching the page behavior)
    list = list.slice(0, 15);
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
    // Build Salesmen version (Place, Image, Style Name, Color, Sold)
    const HeadSalesmen = React.createElement(View, { style: styles.header },
      Cell('Place', '8%','left'), Cell('Image','12%','left'), Cell('Style Name','35%','left'), Cell('Color','25%','left'), Cell('Sold','20%','right')
    );
    const bodySalesmen = list.map((r, i) => React.createElement(View, { style: styles.row },
      Cell(String(i+1), '8%','left'),
      React.createElement(View, { style: [{ width: '12%' as any, padding: 4 }] }, r.image_url ? React.createElement(Image, { style: styles.img, src: r.image_url }) : React.createElement(Text, { style: styles.cell }, '')),
      Cell(r.style_name || '—', '35%','left'),
      Cell(r.color || '—', '25%','left'),
      Cell(new Intl.NumberFormat('da-DK').format(Math.round(Number(r.qty || 0))), '20%','right')
    ));
    const docSalesmen = React.createElement(
      Document,
      null,
      React.createElement(
        PdfPage,
        { size: 'A4', style: styles.page },
        React.createElement(Text, { style: styles.h1 }, 'Top 15 Styles — Salesmen'),
        React.createElement(Text, { style: styles.sub }, seasonName),
        HeadSalesmen,
        ...bodySalesmen
      )
    );
    await log(job.id, 'info', 'STEP:top_styles_export_build_salesmen');
    const outSalesmen = await pdf(docSalesmen).toBuffer();
    const bufSalesmen = await ensureBuffer(outSalesmen as any);
    const pathSalesmen = `top_styles/${job.id}/top_15_salesmen.pdf`;
    try {
      const ab = bufSalesmen.buffer.slice(bufSalesmen.byteOffset, bufSalesmen.byteOffset + bufSalesmen.byteLength);
      const { error: upErr } = await supabase.storage.from('exports').upload(pathSalesmen, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_upload_failed_salesmen', { error: e?.message || String(e) });
      throw e;
    }
    let publicUrlSalesmen: string | null = null;
    try {
      const { data: pub } = supabase.storage.from('exports').getPublicUrl(pathSalesmen);
      publicUrlSalesmen = pub?.publicUrl ?? null;
    } catch {}
    try {
      const { error: insErr } = await supabase.from('exports').insert({ kind: 'top_styles_pdf_salesmen', title: 'Top 15 Styles — Salesmen', path: pathSalesmen, public_url: publicUrlSalesmen, job_id: job.id, meta: { season_id: seasonId } });
      if (insErr) throw insErr;
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_row_failed_salesmen', { error: e?.message || String(e) });
      throw e;
    }
    // Build Overall version (Place, Image, Style Name, Color, Sold, DG, Supplier)
    const HeadOverall = React.createElement(View, { style: styles.header },
      Cell('Place', '6%','left'), Cell('Image','10%','left'), Cell('Style Name','28%','left'), Cell('Color','22%','left'), Cell('Sold','12%','right'), Cell('DG','10%','left'), Cell('Supplier','12%','left')
    );
    const bodyOverall = list.map((r, i) => React.createElement(View, { style: styles.row },
      Cell(String(i+1), '6%','left'),
      React.createElement(View, { style: [{ width: '10%' as any, padding: 4 }] }, r.image_url ? React.createElement(Image, { style: styles.img, src: r.image_url }) : React.createElement(Text, { style: styles.cell }, '')),
      Cell(r.style_name || '—', '28%','left'),
      Cell(r.color || '—', '22%','left'),
      Cell(new Intl.NumberFormat('da-DK').format(Math.round(Number(r.qty || 0))), '12%','right'),
      Cell((r.dg || '') + '', '10%','left'),
      Cell(supplierByStyle.get(r.style_no) || '—', '12%','left')
    ));
    const docOverall = React.createElement(
      Document,
      null,
      React.createElement(
        PdfPage,
        { size: 'A4', style: styles.page },
        React.createElement(Text, { style: styles.h1 }, 'Top 15 Styles — Overall'),
        React.createElement(Text, { style: styles.sub }, seasonName),
        HeadOverall,
        ...bodyOverall
      )
    );
    await log(job.id, 'info', 'STEP:top_styles_export_build_overall');
    const outOverall = await pdf(docOverall).toBuffer();
    const bufOverall = await ensureBuffer(outOverall as any);
    const pathOverall = `top_styles/${job.id}/top_15_overall.pdf`;
    try {
      const ab = bufOverall.buffer.slice(bufOverall.byteOffset, bufOverall.byteOffset + bufOverall.byteLength);
      const { error: upErr } = await supabase.storage.from('exports').upload(pathOverall, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_upload_failed_overall', { error: e?.message || String(e) });
      throw e;
    }
    let publicUrlOverall: string | null = null;
    try {
      const { data: pub } = supabase.storage.from('exports').getPublicUrl(pathOverall);
      publicUrlOverall = pub?.publicUrl ?? null;
    } catch {}
    try {
      const { error: insErr } = await supabase.from('exports').insert({ kind: 'top_styles_pdf_overall', title: 'Top 15 Styles — Overall', path: pathOverall, public_url: publicUrlOverall, job_id: job.id, meta: { season_id: seasonId } });
      if (insErr) throw insErr;
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:top_styles_export_row_failed_overall', { error: e?.message || String(e) });
      throw e;
    }
    await saveResult(job.id, 'export_top_styles_pdf', { files: [{ path: pathSalesmen, publicUrl: publicUrlSalesmen }, { path: pathOverall, publicUrl: publicUrlOverall }], season_id: seasonId });
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


