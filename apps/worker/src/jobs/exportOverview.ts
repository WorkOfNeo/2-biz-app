import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View } from '@react-pdf/renderer';
import JSZip from 'jszip';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  supabase: any;
};

export async function exportOverview(ctx: Ctx) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:export_overview_begin', job.payload || {});
    // Overview table (single PDF mimicking Overview page totals across all salespersons)
    if ((job.payload as any)?.mode === 'overview_react_pdf') {
      const getSeasonCompare = async (): Promise<{ s1: string | null; s2: string | null }> => {
        const body = { s1: (job.payload as any)?.s1 as string | undefined, s2: (job.payload as any)?.s2 as string | undefined };
        if (body.s1 && body.s2) return { s1: body.s1, s2: body.s2 };
        try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle(); return { s1: (data?.value as any)?.s1 ?? null, s2: (data?.value as any)?.s2 ?? null }; } catch { return { s1: null, s2: null }; }
      };
      const { s1, s2 } = await getSeasonCompare();
      if (!s1 || !s2) throw new Error('Missing season compare (s1/s2)');
      const { data: people } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
      const list = (people ?? []) as Array<{ id: string; name: string; currency?: string | null }>;
      const { data: customers } = await supabase.from('customers').select('customer_id, country, salesperson_id, nulled, excluded, permanently_closed');
      const custs = (customers ?? []) as Array<{ customer_id: string; country: string | null; salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>;
      let rates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); rates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      const spCurrencyById: Record<string, string> = Object.fromEntries(list.map((p) => [p.id, (p.currency || 'DKK').toUpperCase()]));
      const { data: stats } = await supabase.from('sales_stats').select('account_no, qty, price, season_id, salesperson_id').in('season_id', [s1, s2]).limit(200000);
      const { data: invoices } = await supabase.from('sales_invoices').select('account_no, qty, amount, currency, season_id').in('season_id', [s1, s2]).limit(200000);
      const customerById = new Map<string, { salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>();
      for (const c of custs) customerById.set(c.customer_id, c);
      const targetsBySp = new Map<string, Set<string>>();
      const validTargetsBySp = new Map<string, Set<string>>();
      for (const sp of list) {
        const all = new Set<string>(); const valid = new Set<string>();
        for (const c of custs) { if (c.salesperson_id === sp.id && c.customer_id) { all.add(c.customer_id); if (!(c.nulled || c.permanently_closed || c.excluded)) valid.add(c.customer_id); } }
        targetsBySp.set(sp.id, all); validTargetsBySp.set(sp.id, valid);
      }
      const agg = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; visitedValid: Set<string> }>();
      for (const sp of list) agg.set(sp.id, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, visitedValid: new Set<string>() });
      for (const r of (stats ?? []) as any[]) {
        const spId = r.salesperson_id ?? ''; const acc = r.account_no ?? ''; if (!spId || !acc) continue;
        const set = targetsBySp.get(spId); if (!set || !set.has(acc)) continue;
        const row = agg.get(spId)!; const rate = rates[spCurrencyById[spId] || 'DKK'] ?? 1; const priceDkk = Number(r.price || 0) * rate;
        if (r.season_id === s1) { row.s1Qty += Number(r.qty||0); row.s1Price += priceDkk; if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc); }
        else if (r.season_id === s2) { row.s2Qty += Number(r.qty||0); row.s2Price += priceDkk; }
      }
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? ''; if (!acc) continue; const c = customerById.get(acc); const spId = c?.salesperson_id ?? ''; if (!spId) continue;
        const set = targetsBySp.get(spId); if (!set || !set.has(acc)) continue;
        const row = agg.get(spId)!; const rate = rates[(String(inv.currency || 'DKK').toUpperCase())] ?? 1; const amountDkk = Number(inv.amount || 0) * rate; const qty = Number(inv.qty || 0) || 0;
        if (inv.season_id === s1) { row.s1Qty += qty; row.s1Price += amountDkk; }
        else if (inv.season_id === s2) { row.s2Qty += qty; row.s2Price += amountDkk; }
      }
      const styles = StyleSheet.create({ page: { padding: 16, fontSize: 9, color: '#0f172a' }, h1: { fontSize: 14, marginBottom: 6 }, header: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff' }, cell: { padding: 4, fontSize: 8 }, row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' }, left: { textAlign: 'left' }, right: { textAlign: 'right' } });
      const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) => React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : styles.right, extra || {}] }, txt);
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      const head = React.createElement(View, { style: styles.header },
        Cell('Salesman', '28%', 'left'), Cell('S1 Qty', '9%', 'right'), Cell('S1 Price (DKK)', '13%', 'right'), Cell('S2 Qty', '9%', 'right'), Cell('S2 Price (DKK)', '13%', 'right'), Cell('Visited', '8%', 'right'), Cell('Total', '8%', 'right'), Cell('Visited %', '12%', 'right')
      );
      const body = list.map((sp) => {
        const a = agg.get(sp.id)!; const totalCustomers = custs.filter(c => c.salesperson_id === sp.id).length; const nulled = custs.filter(c => c.salesperson_id === sp.id && (c.nulled || c.excluded || c.permanently_closed)).length; const effective = Math.max(0, totalCustomers - nulled);
        const visited = a.visitedValid.size; const visitedPct = effective > 0 ? (visited / effective) * 100 : 0;
        return React.createElement(View, { style: styles.row }, Cell(sp.name, '28%'), Cell(String(a.s1Qty), '9%', 'right'), Cell(fmt(a.s1Price), '13%', 'right'), Cell(String(a.s2Qty), '9%', 'right'), Cell(fmt(a.s2Price), '13%', 'right'), Cell(String(visited), '8%', 'right'), Cell(String(effective), '8%', 'right'), Cell(visitedPct.toFixed(2) + '%', '12%', 'right'));
      });
      const doc = React.createElement(Document, null, React.createElement(PdfPage, { size: 'A4', style: styles.page }, React.createElement(Text, { style: styles.h1 }, 'Overview'), head, ...body));
      const pdfBuf = await pdf(doc).toBuffer();
      const path = `overview/${job.id}/overview.pdf`;
      try { await supabase.storage.from('exports').upload(path, pdfBuf as any, { contentType: 'application/pdf', upsert: true }); } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'overview_pdf', title: 'Overview', path, public_url: publicUrl, job_id: job.id, meta: {} }); } catch {}
      await saveResult(job.id, 'export_overview_pdf', { file: { path, publicUrl } });
      await setJobSucceeded(job.id);
      return;
    }
    if ((job.payload as any)?.mode === 'general_react_pdf') {
      const s1 = (job.payload as any)?.s1 as string | undefined;
      const s2 = (job.payload as any)?.s2 as string | undefined;
      let season1 = s1 || '';
      let season2 = s2 || '';
      try {
        if (!season1 || !season2) {
          const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle();
          season1 = season1 || ((data?.value as any)?.s1 as string || '');
          season2 = season2 || ((data?.value as any)?.s2 as string || '');
        }
      } catch {}
      let s1Qty = 0, s1Price = 0, s2Qty = 0, s2Price = 0;
      try {
        const { data: rows } = await supabase.from('sales_stats').select('season_id, qty, price').in('season_id', [season1, season2]);
        for (const r of (rows ?? []) as any[]) {
          if (r.season_id === season1) { s1Qty += Number(r.qty || 0); s1Price += Number(r.price || 0); }
          else if (r.season_id === season2) { s2Qty += Number(r.qty || 0); s2Price += Number(r.price || 0); }
        }
      } catch {}
      const styles = StyleSheet.create({ page: { padding: 24 }, h1: { fontSize: 18, marginBottom: 8 }, p: { fontSize: 12, marginBottom: 4 } });
      const doc = React.createElement(
        Document,
        null,
        React.createElement(
          PdfPage,
          { size: 'A4', style: styles.page },
          React.createElement(Text, { style: styles.h1 }, 'General Export'),
          React.createElement(Text, { style: styles.p }, `Season 1 Qty: ${String(s1Qty)}`),
          React.createElement(Text, { style: styles.p }, `Season 1 Price: ${String(Math.round(s1Price))}`),
          React.createElement(Text, { style: styles.p }, `Season 2 Qty: ${String(s2Qty)}`),
          React.createElement(Text, { style: styles.p }, `Season 2 Price: ${String(Math.round(s2Price))}`),
          React.createElement(Text, { style: styles.p }, `Generated: ${new Date().toLocaleString()}`)
        )
      );
      const pdfBuf = await pdf(doc).toBuffer();
      const zip = new JSZip();
      zip.file('general.pdf', pdfBuf);
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const path = `general/${job.id}/general.zip`;
      try { await supabase.storage.from('exports').upload(path, zipBuf as any, { contentType: 'application/zip', upsert: true }); } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'general_pdf_zip', title: 'General', path, public_url: publicUrl, meta: {}, job_id: job.id }); } catch {}
      await saveResult(job.id, 'export_general_pdf_zip', { file: { path, publicUrl } });
      await setJobSucceeded(job.id);
      return;
    }
    if ((job.payload as any)?.mode === 'general_salesmen_react_pdf') {
      const getSeasonCompare = async (): Promise<{ s1: string | null; s2: string | null }> => {
        const body = { s1: (job.payload as any)?.s1 as string | undefined, s2: (job.payload as any)?.s2 as string | undefined };
        if (body.s1 && body.s2) return { s1: body.s1, s2: body.s2 };
        try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle(); return { s1: (data?.value as any)?.s1 ?? null, s2: (data?.value as any)?.s2 ?? null }; } catch { return { s1: null, s2: null }; }
      };
      const { s1, s2 } = await getSeasonCompare();
      if (!s1 || !s2) throw new Error('Missing season compare (s1/s2)');
      const { data: people } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
      const list = (people ?? []) as Array<{ id: string; name: string; currency?: string | null }>;
      let rates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); rates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      const seasonNames = async (id: string | null): Promise<string | null> => {
        if (!id) return null;
        try { const { data } = await supabase.from('seasons').select('name, year').eq('id', id).maybeSingle(); const n = (data as any)?.name as string | null; const y = (data as any)?.year as number | null; return n ? (y ? `${n} ${y}` : n) : null; } catch { return null; }
      };
      const s1Name = await seasonNames(s1);
      const s2Name = await seasonNames(s2);
      const total = list.length;
      const zip = new JSZip();
      const filesList: Array<{ name: string; path: string; publicUrl: string | null }> = [];
      const pagesAll: any[] = [];
      let idx = 0;
      for (const sp of list) {
        idx++;
        await log(job.id, 'info', 'STEP:export_general_progress', { index: idx, total, name: sp.name });
        const { data: customers } = await supabase.from('customers').select('customer_id, company, city, nulled, excluded, permanently_closed').eq('salesperson_id', sp.id);
        const items = (customers ?? []) as Array<{ customer_id: string; company: string | null; city: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>;
        let hiddenSet = new Set<string>(); let nulledSet = new Set<string>();
        try {
          const key = `season_overrides:${s1}`;
          const { data: ov } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
          const val = (ov?.value as any) || {};
          (Array.isArray(val.hidden) ? val.hidden : []).forEach((a: string) => hiddenSet.add(a));
          (Array.isArray(val.nulled) ? val.nulled : []).forEach((a: string) => nulledSet.add(a));
        } catch {}
        const accountNos = items.map((c) => c.customer_id).filter(Boolean);
        let rows: Array<{ account: string; company: string; city: string; nulled: boolean; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>= [];
        if (accountNos.length) {
          const statResp = await supabase.from('sales_stats').select('account_no, qty, price, season_id').in('season_id', [s1, s2]).in('account_no', accountNos).limit(200000);
          const statRows: Array<{ account_no: string | null; qty: number | null; price: number | null; season_id: string }> = ((statResp as any)?.data ?? []) as any[];
          // Also fetch invoices to align with General page totals
          const invResp = await supabase.from('sales_invoices').select('account_no, qty, amount, season_id').in('season_id', [s1, s2]).in('account_no', accountNos).limit(200000);
          const invRows: Array<{ account_no: string | null; qty: number | null; amount: number | null; season_id: string }> = ((invResp as any)?.data ?? []) as any[];
          const map = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>();
          for (const rowItem of statRows) {
            const key = String(rowItem.account_no || ''); if (!key) continue;
            const agg = map.get(key) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
            if (rowItem.season_id === s1) { agg.s1Qty += Number(rowItem.qty||0); agg.s1Price += Number(rowItem.price||0); }
            else if (rowItem.season_id === s2) { agg.s2Qty += Number(rowItem.qty||0); agg.s2Price += Number(rowItem.price||0); }
            map.set(key, agg);
          }
          for (const inv of invRows) {
            const key = String(inv.account_no || ''); if (!key) continue;
            const agg = map.get(key) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
            if (inv.season_id === s1) { agg.s1Qty += Number(inv.qty||0); agg.s1Price += Number(inv.amount||0); }
            else if (inv.season_id === s2) { agg.s2Qty += Number(inv.qty||0); agg.s2Price += Number(inv.amount||0); }
            map.set(key, agg);
          }
          for (const c of items) {
            const agg = map.get(c.customer_id);
            const isHidden = hiddenSet.has(c.customer_id) || Boolean(c.excluded);
            if (!agg || isHidden) continue;
            const isNulled = nulledSet.has(c.customer_id) || Boolean(c.nulled) || Boolean(c.permanently_closed);
            rows.push({ account: c.customer_id, company: c.company || '-', city: c.city || '-', nulled: isNulled, ...agg });
          }
          rows.sort((a,b)=> a.company.localeCompare(b.company));
        }
        const styles = StyleSheet.create({
          page: { padding: 16, fontSize: 8, color: '#0f172a' },
          h1: { fontSize: 14, marginBottom: 2, color: '#0f172a' },
          small: { fontSize: 8, color: '#64748b', marginBottom: 6, fontWeight: 700 },
          tableHeaderGlobal: { flexDirection: 'row', backgroundColor: '#eaeaea', color: '#000000', borderBottom: 0.5, borderColor: '#bfdbfe' },
          tableHeader: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff', borderBottom: 0.5, borderColor: '#bfdbfe' },
          headerCell: { padding: 4, fontSize: 9, fontWeight: 700 },
          row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
          rowAlt: { backgroundColor: '#f1f5f9' },
          mutedRow: { opacity: 0.5 },
          cell: { padding: 4, fontSize: 8 },
          left: { textAlign: 'left' },
          right: { textAlign: 'right' },
          strike: { textDecoration: 'line-through', color: '#64748b' },
          green: { color: '#16a34a' },
          red: { color: '#dc2626' }
        });
        const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) => React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : styles.right, extra || {}] }, txt);
        const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
        const groupHeader = React.createElement(View, { style: styles.tableHeaderGlobal },
          Cell('KUNDE', '45%', 'left', styles.headerCell),
          Cell(s1Name ?? 'S1', '20%', 'right', styles.headerCell),
          Cell(s2Name ?? 'S2', '20%', 'right', styles.headerCell),
          Cell('Forskel', '15%', 'right', styles.headerCell)
        );
        const header = React.createElement(View, { style: styles.tableHeader },
          Cell('Kunde', '30%', 'left', styles.headerCell),
          Cell('By', '15%', 'left', styles.headerCell),
          Cell('Stk', '8%', 'right', styles.headerCell),
          Cell('Oms', '12%', 'right', styles.headerCell),
          Cell('Stk', '8%', 'right', styles.headerCell),
          Cell('Oms', '12%', 'right', styles.headerCell),
          Cell('Stk', '7%', 'right', styles.headerCell),
          Cell('Oms', '8%', 'right', styles.headerCell)
        );
        const body = rows.map((r, i) => {
          const devQty = r.s1Qty - r.s2Qty; const devPrice = r.s1Price - r.s2Price;
          const devQtyStyle = devQty >= 0 ? styles.green : styles.red;
          const devPriceStyle = devPrice >= 0 ? styles.green : styles.red;
          const baseRow = i % 2 === 1 ? [styles.row, styles.rowAlt] : [styles.row];
          const rowStyle = r.nulled ? [...baseRow, styles.mutedRow] : baseRow;
          const nameStyle = r.nulled ? styles.strike : undefined;
          const s1QtyStyle = r.s1Qty === 0 ? undefined : (r.s1Qty > r.s2Qty ? styles.green : r.s1Qty < r.s2Qty ? styles.red : undefined);
          const s1PriceStyle = r.s1Price === 0 ? undefined : (r.s1Price > r.s2Price ? styles.green : r.s1Price < r.s2Price ? styles.red : undefined);
          return React.createElement(View, { style: rowStyle },
            Cell(r.company, '30%', 'left', nameStyle),
            Cell(r.city, '15%', 'left', nameStyle),
            Cell(String(r.s1Qty), '8%', 'right', s1QtyStyle),
            Cell(fmt(r.s1Price), '12%', 'right', s1PriceStyle),
            Cell(String(r.s2Qty), '8%', 'right'),
            Cell(fmt(r.s2Price), '12%', 'right'),
            Cell((devQty>0?'+':'')+String(devQty), '7%', 'right', r.nulled ? [devQtyStyle, styles.strike] : devQtyStyle),
            Cell((devPrice>0?'+':'')+fmt(devPrice), '8%', 'right', r.nulled ? [devPriceStyle, styles.strike] : devPriceStyle)
          );
        });
        const totals = rows.reduce((a, r) => ({ s1Qty: a.s1Qty + r.s1Qty, s2Qty: a.s2Qty + r.s2Qty, s1Price: a.s1Price + r.s1Price, s2Price: a.s2Price + r.s2Price }), { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 });
        const currency = (sp.currency || 'DKK').toUpperCase();
        const rate = rates[currency] ?? 1;
        const totalsDkk = { s1: totals.s1Price * rate, s2: totals.s2Price * rate };
        const totalsLocal = { s1: totals.s1Price, s2: totals.s2Price };
        const totalsView = React.createElement(View, { style: { marginTop: 6 } },
          React.createElement(Text, { style: { fontSize: 10, fontWeight: 700, marginBottom: 3 } }, 'TOTALS'),
          React.createElement(View, { style: styles.tableHeader },
            Cell('', '45%', 'left', (styles as any).headerCell),
            Cell(`${s1Name ?? 'S1'} (${currency})`, '22%', 'right', (styles as any).headerCell),
            Cell(`${s2Name ?? 'S2'} (${currency})`, '22%', 'right', (styles as any).headerCell),
            Cell('Diff', '11%', 'right', (styles as any).headerCell)
          ),
          React.createElement(View, { style: styles.row },
            Cell('Local', '45%', 'left'),
            Cell(fmt(totalsLocal.s1), '22%', 'right'),
            Cell(fmt(totalsLocal.s2), '22%', 'right'),
            Cell(((totalsLocal.s1 - totalsLocal.s2) > 0 ? '+' : '') + fmt(totalsLocal.s1 - totalsLocal.s2), '11%', 'right')
          ),
          React.createElement(View, { style: [styles.row, styles.rowAlt] },
            Cell('DKK', '45%', 'left'),
            Cell(fmt(totalsDkk.s1), '22%', 'right'),
            Cell(fmt(totalsDkk.s2), '22%', 'right'),
            Cell(((totalsDkk.s1 - totalsDkk.s2) > 0 ? '+' : '') + fmt(totalsDkk.s1 - totalsDkk.s2), '11%', 'right')
          )
        );
        const pageEl = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
          React.createElement(Text, { style: styles.h1 }, `${sp.name}`),
          React.createElement(Text, { style: styles.small }, `${s1Name ?? 'S1'} vs ${s2Name ?? 'S2'}`),
          groupHeader,
          header,
          ...body,
          totalsView
        );
        const doc = React.createElement(Document, null, pageEl);
        const buf = await pdf(doc).toBuffer();
        const safeName = (sp.name || 'salesperson').replace(/[^a-z0-9_-]+/gi, '_');
        zip.file(`${safeName}.pdf`, buf);
        try {
          const indivPath = `general/${job.id}/salesmen/${safeName}.pdf`;
          await supabase.storage.from('exports').upload(indivPath, buf as any, { contentType: 'application/pdf', upsert: true });
          let indivUrl: string | null = null;
          try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(indivPath); indivUrl = pub?.publicUrl ?? null; } catch {}
          filesList.push({ name: sp.name, path: indivPath, publicUrl: indivUrl });
        } catch {}
        pagesAll.push(pageEl);
      }
      const combined = React.createElement(Document, null, ...pagesAll);
      const combinedBuf = await pdf(combined).toBuffer();
      zip.file('all.pdf', combinedBuf);
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const path = `general/${job.id}/salesmen.zip`;
      try { await supabase.storage.from('exports').upload(path, zipBuf as any, { contentType: 'application/zip', upsert: true }); } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'general_salesmen_zip', title: 'General · Salesmen', path, public_url: publicUrl, job_id: job.id, meta: { files: filesList } }); } catch {}
      await saveResult(job.id, 'export_general_salesmen_zip', { file: { path, publicUrl } });
      await setJobSucceeded(job.id);
      return;
    }
    if ((job.payload as any)?.mode === 'countries_react_pdf') {
      const getSeasonCompare = async (): Promise<{ s1: string | null; s2: string | null }> => {
        const body = { s1: (job.payload as any)?.s1 as string | undefined, s2: (job.payload as any)?.s2 as string | undefined };
        if (body.s1 && body.s2) return { s1: body.s1, s2: body.s2 };
        try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle(); return { s1: (data?.value as any)?.s1 ?? null, s2: (data?.value as any)?.s2 ?? null }; } catch { return { s1: null, s2: null }; }
      };
      const { s1, s2 } = await getSeasonCompare();
      if (!s1 || !s2) throw new Error('Missing season compare (s1/s2)');
      const countries = ['Denmark', 'Norway', 'Sweden', 'Finland'];
      const { data: stats } = await supabase.from('sales_stats').select('season_id, qty, price, currency, account_no, customer_id, customers(country)').in('season_id', [s1, s2]).limit(200000);
      const { data: customers } = await supabase.from('customers').select('customer_id, country');
      const { data: invoices } = await supabase.from('sales_invoices').select('account_no, qty, amount, currency, season_id').in('season_id', [s1, s2]).limit(200000);
      let rates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); rates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      const customerCountryById = new Map<string, string | null>();
      for (const c of (customers ?? []) as any[]) customerCountryById.set(c.customer_id, c.country ?? null);
      const totals: Record<string, { s1Qty: number; s2Qty: number; s1Price: number; s2Price: number }> = {};
      for (const c of countries) totals[c] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
      for (const r of (stats ?? []) as any[]) {
        const ctry = String(r.customers?.country || '').trim();
        if (!countries.includes(ctry)) continue;
        let bucket = totals[ctry];
        if (!bucket) { bucket = totals[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 }; }
        const rate = rates[(String(r.currency || 'DKK').toUpperCase())] ?? 1;
        const priceDkk = Number(r.price || 0) * rate;
        if (r.season_id === s1) { bucket.s1Qty += Number(r.qty||0); bucket.s1Price += priceDkk; }
        else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2Price += priceDkk; }
      }
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? '';
        if (!acc) continue;
        const ctry = String(customerCountryById.get(acc) || '').trim();
        if (!countries.includes(ctry)) continue;
        let bucket = totals[ctry];
        if (!bucket) { bucket = totals[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 }; }
        const rate = rates[(String(inv.currency || 'DKK').toUpperCase())] ?? 1;
        const amountDkk = Number(inv.amount || 0) * rate;
        const qty = Number(inv.qty || 0) || 0;
        if (inv.season_id === s1) { bucket.s1Qty += qty; bucket.s1Price += amountDkk; }
        else if (inv.season_id === s2) { bucket.s2Qty += qty; bucket.s2Price += amountDkk; }
      }
      const styles = StyleSheet.create({ page: { padding: 16, fontSize: 12, color: '#0f172a' }, h1: { fontSize: 18, marginBottom: 10 }, row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 } });
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      const pages = countries.map((c) => {
        const row = totals[c] || { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 }; const qtyPct = row.s2Qty === 0 ? 0 : (row.s1Qty / row.s2Qty) * 100; const pricePct = row.s2Price === 0 ? 0 : (row.s1Price / row.s2Price) * 100;
        return React.createElement(PdfPage, { size: 'A4', style: styles.page }, React.createElement(Text, { style: styles.h1 }, `Countries · ${c}`), React.createElement(View, { style: styles.row }, React.createElement(Text, null, `S1 Qty: ${row.s1Qty}`), React.createElement(Text, null, `S2 Qty: ${row.s2Qty}`), React.createElement(Text, null, `Qty %: ${qtyPct.toFixed(2)}%`)), React.createElement(View, { style: styles.row }, React.createElement(Text, null, `S1 Price (DKK): ${fmt(row.s1Price)}`), React.createElement(Text, null, `S2 Price (DKK): ${fmt(row.s2Price)}`), React.createElement(Text, null, `Price %: ${pricePct.toFixed(2)}%`)));
      });
      const combined = React.createElement(Document, null, ...pages);
      const combinedBuf = await pdf(combined).toBuffer();
      const zip = new JSZip();
      zip.file('countries_all.pdf', combinedBuf);
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const path = `countries/${job.id}/countries.zip`;
      try { await supabase.storage.from('exports').upload(path, zipBuf as any, { contentType: 'application/zip', upsert: true }); } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'countries_zip', title: 'Countries', path, public_url: publicUrl, job_id: job.id, meta: {} }); } catch {}
      await saveResult(job.id, 'export_countries_zip', { file: { path, publicUrl } });
      await setJobSucceeded(job.id);
      return;
    }
    // Countries and Overview exports handled elsewhere in system; keep handler narrow
    await setJobFailedOrRequeue(job, 'Unsupported export mode');
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


