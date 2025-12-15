import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View, Svg, Circle, Path, Image } from '@react-pdf/renderer';
import JSZip from 'jszip';
// Use ArrayBuffer slices from Node Buffers for uploads and normalize React-PDF outputs

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
  const comment = (job.payload as any)?.comment as string | undefined;
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
      
      // Get season labels
      const getSeason = async (id: string | null): Promise<{ name: string; year: number | null } | null> => {
        if (!id) return null;
        try {
          const { data } = await supabase.from('seasons').select('name, year').eq('id', id).maybeSingle();
          return { name: (data as any)?.name || '', year: (data as any)?.year ?? null };
        } catch { return null; }
      };
      const s1Info = await getSeason(s1);
      const s2Info = await getSeason(s2);
      const s1Label = s1Info ? `${s1Info.name}${s1Info.year ? ' ' + s1Info.year : ''}` : 'Season 1';
      const s2Label = s2Info ? `${s2Info.name}${s2Info.year ? ' ' + s2Info.year : ''}` : 'Season 2';
      
      const { data: people } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
      const list = (people ?? []) as Array<{ id: string; name: string; currency?: string | null }>;
      const { data: customers } = await supabase.from('customers').select('customer_id, country, salesperson_id, nulled, excluded, permanently_closed');
      const custs = (customers ?? []) as Array<{ customer_id: string; country: string | null; salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>;
      
      // Get currency rates (global + season-specific)
      let baseRates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); baseRates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      let ratesS1: Record<string, number> = {};
      let ratesS2: Record<string, number> = {};
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s1}`).maybeSingle(); ratesS1 = ((data?.value as any) || {}) as Record<string, number>; } catch {}
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s2}`).maybeSingle(); ratesS2 = ((data?.value as any) || {}) as Record<string, number>; } catch {}
      
      const spCurrencyById: Record<string, string> = Object.fromEntries(list.map((p) => [p.id, (p.currency || 'DKK').toUpperCase()]));
      
      // Get seasonal overrides for S1
      let seasonalHidden = new Set<string>(); let seasonalNulled = new Set<string>();
      try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', `season_overrides:${s1}`).maybeSingle();
        const val = (data?.value as any) || {};
        (Array.isArray(val.hidden) ? val.hidden : []).forEach((a: string) => seasonalHidden.add(a));
        (Array.isArray(val.nulled) ? val.nulled : []).forEach((a: string) => seasonalNulled.add(a));
      } catch {}
      
      const { data: stats } = await supabase.from('sales_stats').select('account_no, qty, price, season_id, salesperson_id').in('season_id', [s1, s2]).limit(200000);
      const { data: invoices } = await supabase.from('sales_invoices').select('account_no, qty, amount, currency, season_id').in('season_id', [s1, s2]).limit(200000);
      
      const customerById = new Map<string, { salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>();
      for (const c of custs) customerById.set(c.customer_id, c);
      
      // Helper functions matching frontend logic
      function isHidden(account: string): boolean {
        return seasonalHidden.has(account) || Boolean(customerById.get(account)?.excluded);
      }
      function isNulled(account: string): boolean {
        return seasonalNulled.has(account) || Boolean(customerById.get(account)?.nulled) || Boolean(customerById.get(account)?.permanently_closed);
      }
      
      const targetsBySp = new Map<string, Set<string>>();
      const validTargetsBySp = new Map<string, Set<string>>();
      for (const sp of list) {
        const all = new Set<string>(); const valid = new Set<string>();
        for (const c of custs) {
          if (c.salesperson_id === sp.id && c.customer_id) {
            all.add(c.customer_id);
            if (!isHidden(c.customer_id) && !isNulled(c.customer_id)) {
              valid.add(c.customer_id);
            }
          }
        }
        targetsBySp.set(sp.id, all); validTargetsBySp.set(sp.id, valid);
      }
      
      const agg = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; visitedValid: Set<string> }>();
      for (const sp of list) agg.set(sp.id, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, visitedValid: new Set<string>() });
      
      for (const r of (stats ?? []) as any[]) {
        const spId = r.salesperson_id ?? ''; const acc = r.account_no ?? ''; if (!spId || !acc) continue;
        const set = targetsBySp.get(spId); if (!set || !set.has(acc)) continue;
        if (isHidden(acc)) continue;
        const row = agg.get(spId)!;
        const currency = spCurrencyById[spId] || 'DKK';
        const rateS1 = { ...baseRates, ...ratesS1 }[currency] ?? 1;
        const rateS2 = { ...baseRates, ...ratesS2 }[currency] ?? 1;
        const price = Number(r.price || 0);
        const isNullS1 = isNulled(acc);
        if (r.season_id === s1) {
          if (!isNullS1) {
            row.s1Qty += Number(r.qty||0);
            row.s1Price += price * rateS1;
          }
          if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc);
        } else if (r.season_id === s2) {
          row.s2Qty += Number(r.qty||0);
          row.s2Price += price * rateS2;
        }
      }
      
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? ''; if (!acc) continue;
        if (isHidden(acc)) continue;
        const c = customerById.get(acc); const spId = c?.salesperson_id ?? ''; if (!spId) continue;
        const set = targetsBySp.get(spId); if (!set || !set.has(acc)) continue;
        const row = agg.get(spId)!;
        const currency = spCurrencyById[spId] ?? 'DKK';
        const rateS1 = { ...baseRates, ...ratesS1 }[currency] ?? 1;
        const rateS2 = { ...baseRates, ...ratesS2 }[currency] ?? 1;
        const amount = Number(inv.amount || 0);
        const qty = Number(inv.qty || 0) || 0;
        const isNullS1 = isNulled(acc);
        if (inv.season_id === s1) {
          if (!isNullS1) {
            row.s1Qty += qty;
            row.s1Price += amount * rateS1;
          }
        } else if (inv.season_id === s2) {
          row.s2Qty += qty;
          row.s2Price += amount * rateS2;
        }
      }
      
      // Calculate totals and index for visited customers
      let totalS1Qty = 0, totalS1Price = 0, totalS2Qty = 0, totalS2Price = 0;
      const allowedAccounts = new Set<string>();
      for (const c of custs) {
        if (c.customer_id && !isHidden(c.customer_id)) {
          allowedAccounts.add(c.customer_id);
        }
      }
      
      for (const r of (stats ?? []) as any[]) {
        const acc = r.account_no ?? '';
        if (!acc || !allowedAccounts.has(acc)) continue;
        const currency = r.salesperson_id ? (spCurrencyById[r.salesperson_id] ?? 'DKK') : 'DKK';
        const rateS1 = { ...baseRates, ...ratesS1 }[currency] ?? 1;
        const rateS2 = { ...baseRates, ...ratesS2 }[currency] ?? 1;
        const qty = Number(r.qty || 0);
        const price = Number(r.price || 0);
        const isNullS1 = isNulled(acc);
        if (r.season_id === s1) {
          if (!isNullS1) {
            totalS1Qty += qty;
            totalS1Price += price * rateS1;
          }
        } else if (r.season_id === s2) {
          totalS2Qty += qty;
          totalS2Price += price * rateS2;
        }
      }
      
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? '';
        if (!acc || !allowedAccounts.has(acc)) continue;
        const c = customerById.get(acc);
        const spId = c?.salesperson_id ?? null;
        const currency = spId ? (spCurrencyById[spId] ?? 'DKK') : 'DKK';
        const rateS1 = { ...baseRates, ...ratesS1 }[currency] ?? 1;
        const rateS2 = { ...baseRates, ...ratesS2 }[currency] ?? 1;
        const qty = Number(inv.qty || 0) || 0;
        const amount = Number(inv.amount || 0);
        const isNullS1 = isNulled(acc);
        if (inv.season_id === s1) {
          if (!isNullS1) {
            totalS1Qty += qty;
            totalS1Price += amount * rateS1;
          }
        } else if (inv.season_id === s2) {
          totalS2Qty += qty;
          totalS2Price += amount * rateS2;
        }
      }
      
      // Calculate index (visited customers only)
      type Bucket = { accountId: string; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; isNulled: boolean };
      const buckets = new Map<string, Bucket>();
      for (const acc of allowedAccounts) {
        buckets.set(acc, { accountId: acc, s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, isNulled: isNulled(acc) });
      }
      
      for (const r of (stats ?? []) as any[]) {
        const acc = r.account_no ?? '';
        const bucket = buckets.get(acc);
        if (!bucket) continue;
        const currency = r.salesperson_id ? (spCurrencyById[r.salesperson_id] ?? 'DKK') : 'DKK';
        const qty = Number(r.qty || 0);
        const price = Number(r.price || 0);
        if (r.season_id === s1) {
          if (!bucket.isNulled) {
            bucket.s1Qty += qty;
            bucket.s1Price += price * ({ ...baseRates, ...ratesS1 }[currency] ?? 1);
          }
        } else if (r.season_id === s2) {
          bucket.s2Qty += qty;
          bucket.s2Price += price * ({ ...baseRates, ...ratesS2 }[currency] ?? 1);
        }
      }
      
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? '';
        const bucket = buckets.get(acc);
        if (!bucket) continue;
        const meta = customerById.get(acc);
        const spId = meta?.salesperson_id ?? null;
        const currency = spId ? (spCurrencyById[spId] ?? 'DKK') : 'DKK';
        const qty = Number(inv.qty || 0) || 0;
        const amount = Number(inv.amount || 0);
        if (inv.season_id === s1) {
          if (!bucket.isNulled) {
            bucket.s1Qty += qty;
            bucket.s1Price += amount * ({ ...baseRates, ...ratesS1 }[currency] ?? 1);
          }
        } else if (inv.season_id === s2) {
          bucket.s2Qty += qty;
          bucket.s2Price += amount * ({ ...baseRates, ...ratesS2 }[currency] ?? 1);
        }
      }
      
      // Index calculation: Include both VISITED and NULLED customers
      const visited = Array.from(buckets.values()).filter((v) => (v.s1Qty > 0 || v.s1Price > 0) || v.isNulled);
      const visitedS1Qty = visited.reduce((a, v) => a + v.s1Qty, 0);
      const visitedS1Price = visited.reduce((a, v) => a + v.s1Price, 0);
      const visitedS2Qty = visited.reduce((a, v) => a + v.s2Qty, 0);
      const visitedS2Price = visited.reduce((a, v) => a + v.s2Price, 0);
      const indexQty = visitedS2Qty === 0 ? 100 : (visitedS1Qty / visitedS2Qty) * 100;
      const indexPrice = visitedS2Price === 0 ? 100 : (visitedS1Price / visitedS2Price) * 100;
      
      const styles = StyleSheet.create({
        page: { padding: 12, fontSize: 7, color: '#0f172a' },
        h1: { fontSize: 12, marginBottom: 6, fontWeight: 700 },
        h2: { fontSize: 10, marginTop: 10, marginBottom: 4, fontWeight: 700 },
        header: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff', borderBottom: 0.5, borderColor: '#bfdbfe' },
        headerGrouped: { flexDirection: 'row', backgroundColor: '#93c5fd', color: '#1e3a8a', borderBottom: 0.5, borderColor: '#bfdbfe' },
        headerCell: { padding: 3, fontSize: 7, fontWeight: 700 },
        cell: { padding: 3, fontSize: 7 },
        row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
        rowAlt: { backgroundColor: '#f1f5f9' },
        left: { textAlign: 'left' },
        right: { textAlign: 'right' },
        center: { textAlign: 'center' },
        green: { color: '#16a34a' },
        red: { color: '#dc2626' },
        cardSection: { flexDirection: 'row', gap: 8, marginTop: 8 },
        card: { flex: 1, padding: 6, borderWidth: 0.5, borderColor: '#e2e8f0', borderRadius: 3, backgroundColor: '#ffffff' },
        cardLabel: { fontSize: 6, color: '#64748b', marginBottom: 2 },
        cardValue: { fontSize: 10, fontWeight: 700 }
      });
      
      const Cell = (txt: string, w: string | number, align: 'left' | 'right' | 'center' = 'left', extra?: any) => 
        React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : align === 'right' ? styles.right : styles.center, extra || {}] }, txt);
      const HCell = (txt: string, w: string | number, align: 'left' | 'right' | 'center' = 'left') => 
        React.createElement(Text, { style: [{ width: w }, styles.headerCell, align === 'left' ? styles.left : align === 'right' ? styles.right : styles.center] }, txt);
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      
      // Main table header (2 rows)
      const headerRow1 = React.createElement(View, { style: styles.headerGrouped },
        HCell('', '14%', 'left'),
        HCell('', '5%', 'center'),
        HCell('', '7%', 'center'),
        HCell('', '7%', 'center'),
        HCell('', '7%', 'center'),
        HCell('', '7%', 'center'),
        HCell(s1Label, '18%', 'center'),
        HCell(s2Label, '18%', 'center'),
        HCell('Mangler', '17%', 'center')
      );
      
      const headerRow2 = React.createElement(View, { style: styles.header },
        HCell('Sælger/Agent', '14%', 'left'),
        HCell('Nullet', '5%', 'center'),
        HCell('Besøgt', '7%', 'center'),
        HCell('Total', '7%', 'center'),
        HCell('Ikke besøgt', '7%', 'center'),
        HCell('Fremskridt', '7%', 'center'),
        HCell('Stk', '9%', 'right'),
        HCell('Oms', '9%', 'right'),
        HCell('Stk', '9%', 'right'),
        HCell('Oms', '9%', 'right'),
        HCell('Stk', '9%', 'right'),
        HCell('Oms', '8%', 'right')
      );
      
      const body = list.map((sp, idx) => {
        const a = agg.get(sp.id)!;
        const totalCustomers = custs.filter(c => c.salesperson_id === sp.id).length;
        const nulledCount = custs.filter(c => c.salesperson_id === sp.id && c.customer_id && isNulled(c.customer_id)).length;
        const validTotal = validTargetsBySp.get(sp.id)?.size ?? Math.max(0, totalCustomers - nulledCount);
        const visited = a.visitedValid.size;
        const notVisited = Math.max(0, validTotal - visited);
        const visitedPct = validTotal > 0 ? (visited / validTotal) * 100 : 0;
        
        const diffQty = a.s1Qty - a.s2Qty;
        const diffPrice = a.s1Price - a.s2Price;
        // Calculate the actual difference percentage (positive if above, negative if below)
        const diffQtyPct = a.s2Qty === 0 ? 0 : ((a.s1Qty - a.s2Qty) / a.s2Qty) * 100;
        const diffPricePct = a.s2Price === 0 ? 0 : ((a.s1Price - a.s2Price) / a.s2Price) * 100;
        
        const qtyColor = diffQtyPct > 0 ? styles.green : diffQtyPct < 0 ? styles.red : undefined;
        const priceColor = diffPricePct > 0 ? styles.green : diffPricePct < 0 ? styles.red : undefined;
        
        return React.createElement(View, { style: idx % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row },
          Cell(sp.name, '14%', 'left'),
          Cell(String(nulledCount), '5%', 'center'),
          Cell(String(visited), '7%', 'center'),
          Cell(String(validTotal), '7%', 'center'),
          Cell(String(notVisited), '7%', 'center'),
          Cell(visitedPct.toFixed(0) + '%', '7%', 'center'),
          Cell(String(a.s1Qty), '9%', 'right'),
          Cell(fmt(a.s1Price), '9%', 'right'),
          Cell(String(a.s2Qty), '9%', 'right'),
          Cell(fmt(a.s2Price), '9%', 'right'),
          Cell((diffQtyPct >= 0 ? '+' : '') + diffQtyPct.toFixed(2) + '%', '9%', 'right', qtyColor),
          Cell((diffPricePct >= 0 ? '+' : '') + diffPricePct.toFixed(2) + '%', '8%', 'right', priceColor)
        );
      });
      
      // Second table: TOTALS
      const diffQtyPct = totalS2Qty === 0 ? 0 : ((totalS1Qty - totalS2Qty) / totalS2Qty) * 100;
      const diffPricePct = totalS2Price === 0 ? 0 : ((totalS1Price - totalS2Price) / totalS2Price) * 100;
      const achievedQtyPct = totalS2Qty === 0 ? 0 : (totalS1Qty / totalS2Qty) * 100;
      const achievedPricePct = totalS2Price === 0 ? 0 : (totalS1Price / totalS2Price) * 100;
      
      const qtyCls = diffQtyPct > 0 ? styles.green : diffQtyPct < 0 ? styles.red : undefined;
      const priceCls = diffPricePct > 0 ? styles.green : diffPricePct < 0 ? styles.red : undefined;
      
      const totalsHeaderRow1 = React.createElement(View, { style: styles.headerGrouped },
        HCell('', '20%', 'left'),
        HCell(s1Label, '24%', 'center'),
        HCell(s2Label, '24%', 'center'),
        HCell('Andel ift. sidste år', '32%', 'center')
      );
      
      const totalsHeaderRow2 = React.createElement(View, { style: styles.header },
        HCell('', '20%', 'left'),
        HCell('Stk', '12%', 'right'),
        HCell('Oms (DKK)', '12%', 'right'),
        HCell('Stk', '12%', 'right'),
        HCell('Oms (DKK)', '12%', 'right'),
        HCell('Stk %', '16%', 'right'),
        HCell('Oms %', '16%', 'right')
      );
      
      const totalRow = React.createElement(View, { style: styles.row },
        Cell('TOTAL', '20%', 'left', { fontWeight: 700 }),
        Cell(fmt(totalS1Qty), '12%', 'right'),
        Cell(fmt(totalS1Price), '12%', 'right'),
        Cell(fmt(totalS2Qty), '12%', 'right'),
        Cell(fmt(totalS2Price), '12%', 'right'),
        Cell((diffQtyPct >= 0 ? '+' : '') + diffQtyPct.toFixed(2) + '%', '16%', 'right', qtyCls),
        Cell((diffPricePct >= 0 ? '+' : '') + diffPricePct.toFixed(2) + '%', '16%', 'right', priceCls)
      );
      
      const andelRow = React.createElement(View, { style: [styles.row, styles.rowAlt] },
        Cell('Andel ift sidste år', '20%', 'left', { fontWeight: 700 }),
        Cell('—', '12%', 'right'),
        Cell('—', '12%', 'right'),
        Cell('—', '12%', 'right'),
        Cell('—', '12%', 'right'),
        Cell(achievedQtyPct.toFixed(2) + '%', '16%', 'right'),
        Cell(achievedPricePct.toFixed(2) + '%', '16%', 'right')
      );
      
      // Index cards
      const cardSection = React.createElement(View, { style: styles.cardSection },
        React.createElement(View, { style: styles.card },
          React.createElement(Text, { style: styles.cardLabel }, 'Index stk'),
          React.createElement(Text, { style: styles.cardValue }, indexQty.toFixed(1)),
          React.createElement(Text, { style: { ...styles.cardLabel, marginTop: 2 } }, `${fmt(visitedS1Qty)} vs ${fmt(visitedS2Qty)}`),
          React.createElement(Text, { style: { fontSize: 5, color: '#94a3b8' } }, 'Ud fra besøgte + nullede kunder')
        ),
        React.createElement(View, { style: styles.card },
          React.createElement(Text, { style: styles.cardLabel }, 'Index oms'),
          React.createElement(Text, { style: styles.cardValue }, indexPrice.toFixed(1)),
          React.createElement(Text, { style: { ...styles.cardLabel, marginTop: 2 } }, `${fmt(visitedS1Price)} vs ${fmt(visitedS2Price)}`),
          React.createElement(Text, { style: { fontSize: 5, color: '#94a3b8' } }, 'Ud fra besøgte + nullede kunder')
        )
      );
      
      const doc = React.createElement(
        Document,
        null,
        React.createElement(
          PdfPage,
          { size: 'A4', orientation: 'landscape', style: styles.page },
          React.createElement(Text, { style: styles.h1 }, 'Overview'),
          headerRow1,
          headerRow2,
          ...body,
          React.createElement(Text, { style: styles.h2 }, 'Totals'),
          totalsHeaderRow1,
          totalsHeaderRow2,
          totalRow,
          andelRow,
          cardSection
        )
      );
      
      const pdfOut = await pdf(doc).toBuffer();
      const pdfBuf = await ensureBuffer(pdfOut);
      const path = `overview/${job.id}/overview.pdf`;
      try {
        const ab = pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength);
        await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      const comment = (job.payload as any)?.comment as string | undefined;
      try { await supabase.from('exports').insert({ kind: 'overview_pdf', title: 'Overview', path, public_url: publicUrl, job_id: job.id, meta: {}, comment: comment || null }); } catch {}
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
          { size: 'A4', orientation: 'landscape', style: styles.page },
          React.createElement(Text, { style: styles.h1 }, 'General Export'),
          React.createElement(Text, { style: styles.p }, `Season 1 Qty: ${String(s1Qty)}`),
          React.createElement(Text, { style: styles.p }, `Season 1 Price: ${String(Math.round(s1Price))}`),
          React.createElement(Text, { style: styles.p }, `Season 2 Qty: ${String(s2Qty)}`),
          React.createElement(Text, { style: styles.p }, `Season 2 Price: ${String(Math.round(s2Price))}`),
          React.createElement(Text, { style: styles.p }, `Generated: ${new Date().toLocaleString()}`)
        )
      );
      const pdfOut2 = await pdf(doc).toBuffer();
      const pdfBuf = await ensureBuffer(pdfOut2);
      const zip = new JSZip();
      zip.file('general.pdf', pdfBuf);
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const path = `General/${job.id}/general.zip`;
      try {
        const ab = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
        await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { contentType: 'application/zip', upsert: true });
      } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'general_pdf_zip', title: 'General', path, public_url: publicUrl, meta: {}, job_id: job.id, comment: comment || null }); } catch {}
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
      // Global currency rates (fallback)
      let rates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); rates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      // Season-specific currency rates (same as frontend)
      let ratesS1: Record<string, number> = {};
      try { const { data: rateRowS1 } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s1}`).maybeSingle(); ratesS1 = ((rateRowS1?.value as any) || {}) as Record<string, number>; } catch {}
      let ratesS2: Record<string, number> = {};
      try { const { data: rateRowS2 } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s2}`).maybeSingle(); ratesS2 = ((rateRowS2?.value as any) || {}) as Record<string, number>; } catch {}
      const getSeason = async (id: string | null): Promise<{ name: string; year: number | null; code: string } | null> => {
        if (!id) return null;
        try {
          const { data } = await supabase.from('seasons').select('name, year').eq('id', id).maybeSingle();
          const n = (data as any)?.name as string | null;
          const y = (data as any)?.year as number | null;
          const code = (() => {
            const words = String(n || '').trim().split(/\s+/).filter(Boolean);
            const letters = words.map(w => w[0]?.toUpperCase() || '').join('');
            const yy = typeof y === 'number' ? String(y).slice(-2) : '';
            return `${letters}${yy}`;
          })();
          return { name: n || '', year: y ?? null, code };
        } catch { return null; }
      };
      const s1Info = await getSeason(s1);
      const s2Info = await getSeason(s2);
      const s1Name = s1Info ? `${s1Info.name}${s1Info.year ? ' ' + s1Info.year : ''}` : 'S1';
      const s2Name = s2Info ? `${s2Info.name}${s2Info.year ? ' ' + s2Info.year : ''}` : 'S2';
      const total = list.length;
      const zip = new JSZip();
      const filesList: Array<{ name: string; path: string; publicUrl: string | null; salesperson_id: string }> = [];
      const pagesAll: any[] = [];
      let idx = 0;
      let uploadedSingles = 0;
      for (const sp of list) {
        idx++;
        await log(job.id, 'info', 'STEP:export_general_progress', { index: idx, total, name: sp.name });
        const { data: customers } = await supabase
          .from('customers')
          .select('customer_id, company, city, group_name, salesperson_id, nulled, excluded, permanently_closed')
          .eq('salesperson_id', sp.id);
        const items = (customers ?? []) as Array<{
          customer_id: string;
          company: string | null;
          city: string | null;
          group_name?: string | null;
          salesperson_id: string | null;
          nulled?: boolean | null;
          excluded?: boolean | null;
          permanently_closed?: boolean | null;
        }>;
        let hiddenSet = new Set<string>(); let nulledSet = new Set<string>();
        try {
          const key = `season_overrides:${s1}`;
          const { data: ov } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
          const val = (ov?.value as any) || {};
          (Array.isArray(val.hidden) ? val.hidden : []).forEach((a: string) => hiddenSet.add(a));
          (Array.isArray(val.nulled) ? val.nulled : []).forEach((a: string) => nulledSet.add(a));
        } catch {}
        // Fetch comments for these customers
        const accountNos = items.map((c) => c.customer_id).filter(Boolean);
        const commentsMap: Record<string, string> = {};
        if (accountNos.length > 0) {
          try {
            const { data: comments } = await supabase
              .from('customer_comments')
              .select('customer_id, comment, is_permanent, season_id')
              .in('customer_id', accountNos)
              .or(`season_id.eq.${s1},is_permanent.eq.true`);
            // Prioritize season-specific comments over permanent ones
            const commentsData = (comments ?? []) as Array<{ customer_id: string; comment: string; is_permanent: boolean; season_id: string | null }>;
            for (const c of commentsData) {
              if (!commentsMap[c.customer_id] || (c.season_id === s1 && c.season_id)) {
                commentsMap[c.customer_id] = c.comment || '';
              }
            }
          } catch {}
        }
        let rows: Array<{ account: string; company: string; city: string; comment: string; nulled: boolean; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>= [];
        if (accountNos.length) {
          // Don't filter stats by salesperson_id - use customer's salesperson_id from customers table instead
          // This ensures we get all stats for these customers, then use customer's salesperson_id to determine grouping
          const statResp = await supabase.from('sales_stats').select('account_no, qty, price, season_id').in('season_id', [s1, s2]).in('account_no', accountNos).limit(200000);
          const statRows: Array<{ account_no: string | null; qty: number | null; price: number | null; season_id: string }> = ((statResp as any)?.data ?? []) as any[];
          // Also fetch invoices to align with General page totals (filtered by customer IDs, same as frontend)
          const invResp = await supabase.from('sales_invoices').select('account_no, qty, amount, season_id').in('season_id', [s1, s2]).in('account_no', accountNos).limit(200000);
          const invRows: Array<{ account_no: string | null; qty: number | null; amount: number | null; season_id: string }> = ((invResp as any)?.data ?? []) as any[];
          const map = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>();
          // Aggregate stats WITHOUT currency conversion (same as frontend - prices stored in local currency)
          // Logic: 1) Check sales-data row against customer (match by account_no)
          //        2) Always use customer's salesperson_id from customers table (source of truth for grouping)
          for (const rowItem of statRows) {
            const key = String(rowItem.account_no || ''); if (!key) continue;
            // Step 1: Check sales-data row against customer (match by account_no)
            const customer = items.find(c => c.customer_id === key);
            // Step 2: Use customer's salesperson_id from customers table to determine grouping
            if (!customer || customer.salesperson_id !== sp.id) continue; // Skip if customer doesn't belong to this salesperson
            const agg = map.get(key) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
            const qty = Number(rowItem.qty||0);
            const price = Number(rowItem.price||0);
            if (rowItem.season_id === s1) {
              // Store prices as-is (no conversion during aggregation, same as frontend)
              agg.s1Qty += qty;
              agg.s1Price += price;
            } else if (rowItem.season_id === s2) {
              // Store prices as-is (no conversion during aggregation, same as frontend)
              agg.s2Qty += qty;
              agg.s2Price += price;
            }
            map.set(key, agg);
          }
          // Aggregate invoices WITHOUT currency conversion (same as frontend - prices stored in local currency)
          // Logic: 1) Check sales-data row against customer (match by account_no)
          //        2) Always use customer's salesperson_id from customers table (source of truth for grouping)
          for (const inv of invRows) {
            const key = String(inv.account_no || ''); if (!key) continue;
            // Step 1: Check sales-data row against customer (match by account_no)
            const customer = items.find(c => c.customer_id === key);
            // Step 2: Use customer's salesperson_id from customers table to determine grouping
            if (!customer || customer.salesperson_id !== sp.id) continue; // Skip if customer doesn't belong to this salesperson
            const agg = map.get(key) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
            const qty = Number(inv.qty||0);
            const amount = Number(inv.amount||0);
            if (inv.season_id === s1) {
              // Store prices as-is (no conversion during aggregation, same as frontend)
              agg.s1Qty += qty;
              agg.s1Price += amount;
            } else if (inv.season_id === s2) {
              // Store prices as-is (no conversion during aggregation, same as frontend)
              agg.s2Qty += qty;
              agg.s2Price += amount;
            }
            map.set(key, agg);
          }
          for (const c of items) {
            const isHidden = hiddenSet.has(c.customer_id) || Boolean(c.excluded);
            if (isHidden) continue;
            const agg = map.get(c.customer_id) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
            const isNulled = nulledSet.has(c.customer_id) || Boolean(c.nulled) || Boolean(c.permanently_closed);
            rows.push({ account: c.customer_id, company: c.company || '-', city: c.city || '-', comment: commentsMap[c.customer_id] || '', nulled: isNulled, ...agg });
          }
          rows.sort((a,b)=> a.company.localeCompare(b.company));
        }
        
        const styles = StyleSheet.create({
          page: { padding: 16, fontSize: 8, color: '#0f172a' },
          h1: { fontSize: 14, marginBottom: 2, color: '#0f172a' },
          small: { fontSize: 8, color: '#64748b', marginBottom: 6, fontWeight: 700 },
          kpiSection: { marginTop: 8, marginBottom: 10 },
          kpiRow: { flexDirection: 'row', marginBottom: 6, gap: 6 },
          kpiCard: { flex: 1, padding: 6, borderWidth: 0.5, borderColor: '#e2e8f0', borderRadius: 4, backgroundColor: '#ffffff' },
          kpiLabel: { fontSize: 7, color: '#64748b', marginBottom: 2 },
          kpiValue: { fontSize: 11, fontWeight: 700, color: '#0f172a' },
          tableHeaderGlobal: { flexDirection: 'row', backgroundColor: '#eaeaea', color: '#000000', borderBottom: 0.5, borderColor: '#bfdbfe' },
          tableHeader: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff', borderBottom: 0.5, borderColor: '#bfdbfe' },
          headerCell: { padding: 4, fontSize: 9, fontWeight: 700 },
          row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
          rowAlt: { backgroundColor: '#f1f5f9' },
          subtotalRow: { backgroundColor: '#e5e7eb' },
          subtotalStrong: { fontWeight: 700 },
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
        
        // Calculate KPI statistics for this salesperson
        const totalCustomers = items.length;
        const customersVisitedOnly = rows.filter(r => (r.s1Qty > 0 || r.s1Price > 0) && !r.nulled);
        const customersVisited = customersVisitedOnly.length;
        const customersToVisit = rows.filter(r => {
          const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
          return !hasS1Activity && !r.nulled;
        }).length;
        const nulledCount = rows.filter(r => r.nulled).length;
        
        // Index calculation: Include both VISITED and NULLED customers
        const visitedRows = rows.filter(r => (r.s1Qty > 0 || r.s1Price > 0) || r.nulled);
        
        // Aggregate visited + nulled customers S1/S2 totals for index calculation
        const visitedS1Qty = visitedRows.reduce((a, r) => a + r.s1Qty, 0);
        const visitedS2Qty = visitedRows.reduce((a, r) => a + r.s2Qty, 0);
        const visitedS1Price = visitedRows.reduce((a, r) => a + r.s1Price, 0);
        const visitedS2Price = visitedRows.reduce((a, r) => a + r.s2Price, 0);
        
        // Index ratios (visited S1 vs S2)
        const qtyIndexRatio = visitedS2Qty === 0 ? 1 : visitedS1Qty / visitedS2Qty;
        const priceIndexRatio = visitedS2Price === 0 ? 1 : visitedS1Price / visitedS2Price;
        const indexQty = qtyIndexRatio * 100;
        const indexPrice = priceIndexRatio * 100;
        
        // Prognosis: apply current index to unvisited customers' S2 totals, add visited S1 totals
        const unvisitedRows = rows.filter(r => {
          const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
          return !hasS1Activity && !r.nulled;
        });
        const unvisitedS2Qty = unvisitedRows.reduce((a, r) => a + r.s2Qty, 0);
        const unvisitedS2Price = unvisitedRows.reduce((a, r) => a + r.s2Price, 0);
        
        const prognosedQty = visitedS1Qty + (unvisitedS2Qty * qtyIndexRatio);
        const prognosedPrice = visitedS1Price + (unvisitedS2Price * priceIndexRatio);
        
        // KPI Cards - First row: Index & Prognose statistics
        const kpiCard = (label: string, value: string) => React.createElement(View, { style: styles.kpiCard },
          React.createElement(Text, { style: styles.kpiLabel }, label),
          React.createElement(Text, { style: styles.kpiValue }, value)
        );
        
        const kpiSection = React.createElement(View, { style: styles.kpiSection },
          // First row: Index QTY, Index PRICE, Prognose QTY, Prognose PRICE
          React.createElement(View, { style: styles.kpiRow },
            kpiCard('Index stk', indexQty.toFixed(1)),
            kpiCard('Index oms', indexPrice.toFixed(1)),
            kpiCard('Prognose stk', fmt(prognosedQty)),
            kpiCard('Prognose oms', fmt(prognosedPrice))
          ),
          // Second row: Customer statistics
          React.createElement(View, { style: styles.kpiRow },
            kpiCard('Antal kunder', String(totalCustomers)),
            kpiCard('Kunder besøgt', String(customersVisited)),
            kpiCard('Manglende kunder', String(customersToVisit)),
            kpiCard('Nullet kunder', String(nulledCount))
          )
        );
        
        const groupHeader = React.createElement(View, { style: styles.tableHeaderGlobal },
          Cell('KUNDE', '45%', 'left', styles.headerCell),
          Cell(s1Name ?? 'S1', '20%', 'right', styles.headerCell),
          Cell(s2Name ?? 'S2', '20%', 'right', styles.headerCell),
          Cell('Forskel', '15%', 'right', styles.headerCell)
        );
        const header = React.createElement(View, { style: styles.tableHeader },
          Cell('Kunde', '25%', 'left', styles.headerCell),
          Cell('By', '12%', 'left', styles.headerCell),
          Cell('Kommentar', '10%', 'left', styles.headerCell),
          Cell('Stk', '7%', 'right', styles.headerCell),
          Cell('Oms', '10%', 'right', styles.headerCell),
          Cell('Stk', '7%', 'right', styles.headerCell),
          Cell('Oms', '10%', 'right', styles.headerCell),
          Cell('Stk', '6%', 'right', styles.headerCell),
          Cell('Oms', '7%', 'right', styles.headerCell)
        );
        // Respect group_name: sort by group then company, and add a subtotal row at the end of each group
        const sorted = [...rows].sort((a,b) => {
          const ga = String((items.find(it=>it.customer_id===a.account)?.group_name || '')).toLowerCase();
          const gb = String((items.find(it=>it.customer_id===b.account)?.group_name || '')).toLowerCase();
          if (ga !== gb) return ga < gb ? -1 : 1;
          return a.company.localeCompare(b.company);
        });
        type RowExt = typeof rows[number] & { isGroupTotal?: boolean; groupName?: string | null };
        const withSubtotals: RowExt[] = [];
        let curGroup: string | null = null;
        let accTotals = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
        const groupOf = (acc: string): string | null => {
          const it = items.find(it => it.customer_id === acc);
          return (it?.group_name ?? null) as any;
        };
        function flushSubtotal() {
          if (!curGroup) return;
          withSubtotals.push({
            account: `__group_total:${curGroup}`,
            company: `Group total — ${curGroup}`,
            city: '',
            comment: '',
            nulled: false,
            s1Qty: accTotals.s1Qty,
            s1Price: accTotals.s1Price,
            s2Qty: accTotals.s2Qty,
            s2Price: accTotals.s2Price,
            isGroupTotal: true,
            groupName: curGroup
          } as any);
        }
        for (const r of sorted) {
          const g = groupOf(r.account);
          if (g && curGroup && g !== curGroup) { flushSubtotal(); accTotals = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 }; }
          if (g && !curGroup) { accTotals = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 }; }
          if (g) curGroup = g;
          withSubtotals.push({ ...r, groupName: g } as any);
          if (g) {
            accTotals.s1Qty += r.s1Qty; accTotals.s1Price += r.s1Price; accTotals.s2Qty += r.s2Qty; accTotals.s2Price += r.s2Price;
          }
        }
        if (curGroup) flushSubtotal();
        const body = withSubtotals.map((r, i) => {
          const devQty = r.s1Qty - r.s2Qty; const devPrice = r.s1Price - r.s2Price;
          const devQtyStyle = devQty >= 0 ? styles.green : styles.red;
          const devPriceStyle = devPrice >= 0 ? styles.green : styles.red;
          const baseRow = r.isGroupTotal ? [styles.row, styles.subtotalRow] : (i % 2 === 1 ? [styles.row, styles.rowAlt] : [styles.row]);
          const rowStyle = r.nulled ? [...baseRow, styles.mutedRow] : baseRow;
          const nameStyle = r.isGroupTotal ? styles.subtotalStrong : (r.nulled ? styles.strike : undefined);
          const s1QtyStyle = r.s1Qty === 0 ? undefined : (r.s1Qty > r.s2Qty ? styles.green : r.s1Qty < r.s2Qty ? styles.red : undefined);
          const s1PriceStyle = r.s1Price === 0 ? undefined : (r.s1Price > r.s2Price ? styles.green : r.s1Price < r.s2Price ? styles.red : undefined);
            const commentText = (r as any).comment || '';
            const commentDisplay = commentText.length > 30 ? commentText.substring(0, 27) + '...' : commentText;
            return React.createElement(View, { style: rowStyle },
              Cell(r.company, '25%', 'left', nameStyle),
              Cell(r.city, '12%', 'left', nameStyle),
              Cell(commentDisplay, '10%', 'left', { fontSize: 7, fontStyle: 'italic' }),
              Cell(String(r.s1Qty), '7%', 'right', s1QtyStyle),
              Cell(fmt(r.s1Price), '10%', 'right', s1PriceStyle),
              Cell(String(r.s2Qty), '7%', 'right'),
              Cell(fmt(r.s2Price), '10%', 'right'),
              Cell((devQty>0?'+':'')+String(devQty), '6%', 'right', r.nulled ? [devQtyStyle, styles.strike] : devQtyStyle),
              Cell((devPrice>0?'+':'')+fmt(devPrice), '7%', 'right', r.nulled ? [devPriceStyle, styles.strike] : devPriceStyle)
            );
        });
        // Calculate totals - exclude nulled customers from S1 totals (same as frontend)
        const nulledSeasonal = new Set(nulledSet);
        const totals = rows.reduce((a, r) => {
          const isNullS1 = r.nulled;
          a.s1Qty += isNullS1 ? 0 : r.s1Qty;
          a.s2Qty += r.s2Qty;
          a.s1Price += isNullS1 ? 0 : r.s1Price;
          a.s2Price += r.s2Price;
          return a;
        }, { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 });
        // Get salesperson currency and season-specific rates (same as frontend)
        const currency = (sp.currency || 'DKK').toUpperCase();
        const baseRates = { DKK: 1, ...rates } as Record<string, number>;
        const rateS1 = { ...baseRates, ...ratesS1 }[currency] ?? 1;
        const rateS2 = { ...baseRates, ...ratesS2 }[currency] ?? 1;
        const totalsDkk = { s1: totals.s1Price * rateS1, s2: totals.s2Price * rateS2 };
        const totalsLocal = { s1: totals.s1Price, s2: totals.s2Price };
        const totalsQty = { s1: totals.s1Qty, s2: totals.s2Qty };
        const totalsView = React.createElement(View, { style: { marginTop: 6 } },
          React.createElement(Text, { style: { fontSize: 10, fontWeight: 700, marginBottom: 3 } }, 'TOTALS'),
          React.createElement(View, { style: styles.tableHeader },
            Cell('', '47%', 'left', (styles as any).headerCell),
            Cell(`${s1Name ?? 'S1'} (${currency})`, '20%', 'right', (styles as any).headerCell),
            Cell(`${s2Name ?? 'S2'} (${currency})`, '20%', 'right', (styles as any).headerCell),
            Cell('Diff', '13%', 'right', (styles as any).headerCell)
          ),
          React.createElement(View, { style: styles.row },
            Cell('Qty', '47%', 'left'),
            Cell(String(totalsQty.s1), '20%', 'right'),
            Cell(String(totalsQty.s2), '20%', 'right'),
            Cell(((totalsQty.s1 - totalsQty.s2) > 0 ? '+' : '') + String(totalsQty.s1 - totalsQty.s2), '13%', 'right')
          ),
          React.createElement(View, { style: styles.row },
            Cell('Local', '47%', 'left'),
            Cell(fmt(totalsLocal.s1), '20%', 'right'),
            Cell(fmt(totalsLocal.s2), '20%', 'right'),
            Cell(((totalsLocal.s1 - totalsLocal.s2) > 0 ? '+' : '') + fmt(totalsLocal.s1 - totalsLocal.s2), '13%', 'right')
          ),
          React.createElement(View, { style: [styles.row, styles.rowAlt] },
            Cell('DKK', '47%', 'left'),
            Cell(fmt(totalsDkk.s1), '20%', 'right'),
            Cell(fmt(totalsDkk.s2), '20%', 'right'),
            Cell(((totalsDkk.s1 - totalsDkk.s2) > 0 ? '+' : '') + fmt(totalsDkk.s1 - totalsDkk.s2), '13%', 'right')
          )
        );
        const pageEl = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
          React.createElement(Text, { style: styles.h1 }, `${sp.name}`),
          React.createElement(Text, { style: styles.small }, `${s1Name ?? 'S1'} vs ${s2Name ?? 'S2'}`),
          kpiSection,
          groupHeader,
          header,
          ...body,
          totalsView
        );
        const doc = React.createElement(Document, null, pageEl);
        const out = await pdf(doc).toBuffer();
        const buf = await ensureBuffer(out);
        const safeName = (sp.name || 'salesperson').replace(/[^a-z0-9_-]+/gi, '_');
        // Only store individual PDFs in storage; skip bundling zip server-side
        const indivPath = `General/${job.id}/salesmen/${safeName}.pdf`;
        // retry upload up to 3 times for single PDF
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            const { error: upErr } = await supabase.storage.from('exports').upload(indivPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
            if (upErr) throw upErr;
            let indivUrl: string | null = null;
            try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(indivPath); indivUrl = pub?.publicUrl ?? null; } catch {}
            filesList.push({ name: sp.name, path: indivPath, publicUrl: indivUrl, salesperson_id: sp.id });
            uploadedSingles++;
            break;
          } catch (e: any) {
            if (attempt === 3) { await log(job.id, 'error', 'STEP:export_single_upload_failed', { name: sp.name, path: indivPath, error: e?.message || String(e) }); }
          }
        }
        pagesAll.push(pageEl);
      }
      // Build a single combined PDF with all salespersons (one page per salesperson)
      let combinedPath: string | null = null;
      let combinedPublicUrl: string | null = null;
      try {
        const combinedDoc = React.createElement(Document, null, ...pagesAll);
        const combinedOut = await pdf(combinedDoc).toBuffer();
        const combinedBuf = await ensureBuffer(combinedOut);
        combinedPath = `General/${job.id}/salesmen/all.pdf`;
        const ab = combinedBuf.buffer.slice(combinedBuf.byteOffset, combinedBuf.byteOffset + combinedBuf.byteLength);
        await supabase.storage.from('exports').upload(combinedPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
        try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(combinedPath); combinedPublicUrl = pub?.publicUrl ?? null; } catch {}
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:export_general_combined_failed', { error: e?.message || String(e) });
      }
      // Insert a record pointing to the folder (no zip). Include meta.files and meta.all for combined
      const folderPath = `General/${job.id}/salesmen/`;
      try {
        await supabase.from('exports').insert({
          kind: 'general_salesmen_pdfs',
          title: 'General · Salesmen',
          path: folderPath,
          public_url: null,
          job_id: job.id,
          meta: { files: filesList, all: { path: combinedPath, publicUrl: combinedPublicUrl } },
          comment: comment || null
        });
      } catch {}
      await log(job.id, 'info', 'STEP:export_general_singles_uploaded', { uploaded: uploadedSingles, total: list.length });
      await saveResult(job.id, 'export_general_salesmen_pdfs', { singles: uploadedSingles, folder: folderPath });
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
      // Season info for codes
      const getSeason = async (id: string | null): Promise<{ name: string; year: number | null; code: string } | null> => {
        if (!id) return null;
        try {
          const { data } = await supabase.from('seasons').select('name, year').eq('id', id).maybeSingle();
          const n = (data as any)?.name as string | null;
          const y = (data as any)?.year as number | null;
          const code = (() => {
            const words = String(n || '').trim().split(/\s+/).filter(Boolean);
            const letters = words.map(w => w[0]?.toUpperCase() || '').join('');
            const yy = typeof y === 'number' ? String(y).slice(-2) : '';
            return `${letters}${yy}`;
          })();
          return { name: n || '', year: y ?? null, code };
        } catch { return null; }
      };
      const s1Info = await getSeason(s1);
      const s2Info = await getSeason(s2);
      // Data loads
      const { data: stats } = await supabase.from('sales_stats').select('season_id, qty, price, currency, account_no, customer_id, customers(country)').in('season_id', [s1, s2]).limit(200000);
      const { data: customers } = await supabase.from('customers').select('customer_id, country, salesperson_id, nulled, excluded, permanently_closed');
      const { data: people } = await supabase.from('salespersons').select('id, name');
      const { data: invoices } = await supabase.from('sales_invoices').select('account_no, qty, amount, currency, season_id').in('season_id', [s1, s2]).limit(200000);
      // Global and season-specific currency rates
      let globalRates: Record<string, number> = { DKK: 1 };
      try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); globalRates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
      let ratesS1: Record<string, number> = {};
      let ratesS2: Record<string, number> = {};
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s1}`).maybeSingle(); ratesS1 = ((data?.value as any) || {}) as Record<string, number>; } catch {}
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', `currency_rates:${s2}`).maybeSingle(); ratesS2 = ((data?.value as any) || {}) as Record<string, number>; } catch {}
      // Seasonal overrides (use S1 for filtering)
      let seasonalHidden = new Set<string>(); let seasonalNulled = new Set<string>();
      try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', `season_overrides:${s1}`).maybeSingle();
        const val = (data?.value as any) || {};
        (Array.isArray(val.hidden) ? val.hidden : []).forEach((a: string) => seasonalHidden.add(a));
        (Array.isArray(val.nulled) ? val.nulled : []).forEach((a: string) => seasonalNulled.add(a));
      } catch {}
      // Maps
      const customerCountryById = new Map<string, string | null>();
      const customerSpById = new Map<string, string | null>();
      const closedSet = new Set<string>(); const excludedSet = new Set<string>(); const nulledSet = new Set<string>();
      for (const c of (customers ?? []) as any[]) {
        customerCountryById.set(c.customer_id, c.country ?? null);
        customerSpById.set(c.customer_id, c.salesperson_id ?? null);
        if (c.permanently_closed) closedSet.add(c.customer_id);
        if (c.excluded) excludedSet.add(c.customer_id);
        if (c.nulled) nulledSet.add(c.customer_id);
      }
      const spNameById = new Map<string, string>();
      for (const p of (people ?? []) as any[]) spNameById.set(p.id as string, p.name as string);
      // Aggregation
      const totals: Record<string, { s1Qty: number; s2Qty: number; s1Price: number; s2Price: number }> = {};
      const perSp: Record<string, Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>> = {};
      for (const c of countries) totals[c] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
      // Stats rows (already have country via join; fall back to customers map)
      for (const r of (stats ?? []) as any[]) {
        const acc = String(r.account_no || '');
        let ctry = String(r.customers?.country ?? customerCountryById.get(acc) ?? '').trim();
        // Skip non-standard countries
        const standardCountries = ['Denmark', 'Norway', 'Sweden', 'Finland'];
        if (!standardCountries.includes(ctry)) continue;
        // Filters
        if (acc) {
          // Exclude hidden/excluded entirely
          if (seasonalHidden.has(acc)) continue;
          if (excludedSet.has(acc)) continue;
        }
        let bucket = totals[ctry];
        if (!bucket) { bucket = totals[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 }; }
        const cur = (String(r.currency || 'DKK').toUpperCase());
        const rate1 = ({ ...globalRates, ...ratesS1 } as Record<string, number>)[cur] ?? 1;
        const rate2 = ({ ...globalRates, ...ratesS2 } as Record<string, number>)[cur] ?? 1;
        const price = Number(r.price || 0);
        const isNullS1 = acc ? (seasonalNulled.has(acc) || closedSet.has(acc) || nulledSet.has(acc)) : false;
        if (r.season_id === s1) { if (!isNullS1) { bucket.s1Qty += Number(r.qty||0); bucket.s1Price += price * rate1; } }
        else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2Price += price * rate2; }
        const spId = (customerSpById.get(acc) ?? null) as string | null;
        if (spId) {
          const m = (perSp[ctry] ||= new Map());
          const row = m.get(spId) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
          if (r.season_id === s1) { if (!isNullS1) { row.s1Qty += Number(r.qty||0); row.s1Price += price * rate1; } }
          else if (r.season_id === s2) { row.s2Qty += Number(r.qty||0); row.s2Price += price * rate2; }
          m.set(spId, row);
        }
      }
      // Invoices mapped via customer country
      for (const inv of (invoices ?? []) as any[]) {
        const acc = inv.account_no ?? '';
        if (!acc) continue;
        if (seasonalHidden.has(acc)) continue;
        if (excludedSet.has(acc)) continue;
        let ctry = String(customerCountryById.get(acc) || '').trim();
        // Skip non-standard countries
        const standardCountries = ['Denmark', 'Norway', 'Sweden', 'Finland'];
        if (!standardCountries.includes(ctry)) continue;
        let bucket = totals[ctry];
        if (!bucket) { bucket = totals[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 }; }
        const cur = (String(inv.currency || 'DKK').toUpperCase());
        const rate1 = ({ ...globalRates, ...ratesS1 } as Record<string, number>)[cur] ?? 1;
        const rate2 = ({ ...globalRates, ...ratesS2 } as Record<string, number>)[cur] ?? 1;
        const amount = Number(inv.amount || 0);
        const qty = Number(inv.qty || 0) || 0;
        const isNullS1 = seasonalNulled.has(acc) || closedSet.has(acc) || nulledSet.has(acc);
        if (inv.season_id === s1) { if (!isNullS1) { bucket.s1Qty += qty; bucket.s1Price += amount * rate1; } }
        else if (inv.season_id === s2) { bucket.s2Qty += qty; bucket.s2Price += amount * rate2; }
        const spId = (customerSpById.get(acc) ?? null) as string | null;
        if (spId) {
          const m = (perSp[ctry] ||= new Map());
          const row = m.get(spId) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
          if (inv.season_id === s1) { if (!isNullS1) { row.s1Qty += qty; row.s1Price += amount * rate1; } }
          else if (inv.season_id === s2) { row.s2Qty += qty; row.s2Price += amount * rate2; }
          m.set(spId, row);
        }
      }
      // Styling (20% smaller overall vs previous)
      const SCALE = 0.64;
      const s = (n: number) => Math.max(0.5, n * SCALE);
      const styles = StyleSheet.create({
        page: { padding: s(16), fontSize: s(12), color: '#0f172a' },
        h1: { fontSize: s(14), marginBottom: s(10), textAlign: 'center' as any },
        docHeader: { fontSize: s(10), color: '#6b7280', textAlign: 'center' as any, marginBottom: s(8) },
        row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: s(8) },
        section: { flexDirection: 'row', gap: s(10) },
        box: { width: '50%' as any, padding: s(8), alignItems: 'center' as any },
        boxTitle: { fontSize: s(12), marginBottom: s(2) },
        boxSub: { fontSize: s(10), color: '#64748b', marginBottom: s(4) },
        boxNums: { fontSize: s(8), fontWeight: 700 as any, marginBottom: s(6) }
      });
      const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      function Donut({ pct, label }: { pct: number; label: string }) {
        // Filled pie: gray base, filled sector
        // If pct >= 100, show full green circle; otherwise show partial blue fill
        const isAbove100 = pct >= 100;
        const visualPct = clamp(pct, 0, 100);
        const sizeScale = 0.36;
        // Geometry with padding to avoid clipping
        const r = s(90 * sizeScale);
        const pad = s(8);
        const dim = r * 2 + pad * 2;
        const cx = r + pad;
        const cy = r + pad;
        
        const displayPct = Math.round(pct);
        const green = '#22c55e'; // green-500
        const darkGreen = '#15803d'; // green-700
        const blue = '#3b82f6'; // blue-500
        const gray = '#d1d5db'; // gray-300
        
        if (isAbove100) {
          // Full green circle for 100%+
          return React.createElement(View, { style: { alignItems: 'center' } },
            React.createElement(Svg, { width: dim, height: dim },
              React.createElement(Circle, { cx, cy, r, fill: green })
            ),
            React.createElement(Text, { style: { fontSize: s(10), marginTop: s(2), color: darkGreen } }, `${label} · ${displayPct}%`)
          );
        }
        
        // Partial fill for < 100%
        const endAngle = (-90 + (visualPct / 100) * 360) * (Math.PI / 180);
        const largeArc = visualPct > 50 ? 1 : 0;
        const x = cx + r * Math.cos(endAngle);
        const y = cy + r * Math.sin(endAngle);
        // Sector path from top, arc to angle, and back to center
        const sectorPath = `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`;
        return React.createElement(View, { style: { alignItems: 'center' } },
          React.createElement(Svg, { width: dim, height: dim },
            React.createElement(Circle, { cx, cy, r, fill: gray }),
            visualPct > 0 ? React.createElement(Path, { d: sectorPath, fill: blue }) : null
          ),
          React.createElement(Text, { style: { fontSize: s(10), marginTop: s(2) } }, `${label} · ${displayPct}%`)
        );
      }
      // Prices are aggregated to DKK already; display only DKK
      const s1Name = s1Info ? `${s1Info.name}${s1Info.year ? ' ' + s1Info.year : ''}` : null;
      const s2Name = s2Info ? `${s2Info.name}${s2Info.year ? ' ' + s2Info.year : ''}` : null;
      const s1Code = s1Info?.code || 'S1';
      const s2Code = s2Info?.code || 'S2';
      // Build one horizontal section per country (all in single document/page flow)
      const sections = countries.map((cName) => {
        const row = totals[cName] || { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
        const qtyPct = row.s2Qty === 0 ? 0 : (row.s1Qty / row.s2Qty) * 100;
        const pricePct = row.s2Price === 0 ? 0 : (row.s1Price / row.s2Price) * 100;
        const spRows = Array.from((perSp[cName] || new Map()).entries()).map(([id, v]) => ({ id, name: spNameById.get(id) || '—', ...v }))
          .sort((a,b) => (b.s1Price + b.s2Price) - (a.s1Price + a.s2Price));
        const T = (txt: string, w: string, align: 'left' | 'right' = 'left', bold = false) =>
          React.createElement(Text, { style: [{ width: w, textAlign: align }, bold ? { fontWeight: 700 as any } : {}] }, txt);
        // Single-level header for salesperson table (season codes shown only once at top of document)
        const spHeaderBottom = React.createElement(View, { style: styles.row },
          T('','34%','left',false),
          T('Stk','11%','right',true),
          T('Oms','22%','right',true),
          T('Stk','11%','right',true),
          T('Oms','22%','right',true)
        );
        const spTable = React.createElement(View, { style: { marginTop: s(6) } },
          spHeaderBottom,
          ...spRows.map(r => React.createElement(View, { style: styles.row },
            T(r.name,'34%','left'),
            T(String(r.s1Qty),'11%','right'),
            T(fmt(r.s1Price),'22%','right'),
            T(String(r.s2Qty),'11%','right'),
            T(fmt(r.s2Price),'22%','right')
          ))
        );
        // Country block with bottom separator
        return React.createElement(View, { style: { flexDirection: 'column', gap: s(6), marginBottom: s(10), paddingBottom: s(8), borderBottomWidth: s(1), borderBottomColor: '#e5e7eb' } },
          React.createElement(Text, { style: styles.h1 }, `${cName}`),
          React.createElement(View, { style: { flexDirection: 'row', gap: s(16) } },
            React.createElement(View, { style: { width: '24%' as any, alignItems: 'center' as any } },
              React.createElement(Text, { style: styles.boxTitle }, 'Antal stk'),
              React.createElement(Text, { style: styles.boxNums }, `${row.s1Qty} vs ${row.s2Qty}`),
              React.createElement(Donut as any, { pct: qtyPct, label: 'Stk' })
            ),
            React.createElement(View, { style: { width: '24%' as any, alignItems: 'center' as any } },
              React.createElement(Text, { style: styles.boxTitle }, 'Omsætning (DKK)'),
              React.createElement(Text, { style: styles.boxNums }, `${fmt(row.s1Price)} DKK vs ${fmt(row.s2Price)} DKK`),
              React.createElement(Donut as any, { pct: pricePct, label: 'Omsætning' })
            ),
            React.createElement(View, { style: { width: '52%' as any } },
              spTable
            )
          )
        );
      });
      // Single page document; react-pdf will flow to additional pages if needed, but we don't create a page per country manually
      const combined = React.createElement(Document, null,
        React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
          React.createElement(View, { style: { flexDirection: 'column', gap: s(6) } },
            React.createElement(Text, { style: styles.docHeader }, `${s1Code} vs ${s2Code}`),
            ...sections
          )
        )
      );
      const combinedOut = await pdf(combined).toBuffer();
      const combinedBuf = await ensureBuffer(combinedOut);
      // Upload a single combined PDF instead of a zip
      const path = `countries/${job.id}/countries.pdf`;
      try {
        const ab = combinedBuf.buffer.slice(combinedBuf.byteOffset, combinedBuf.byteOffset + combinedBuf.byteLength);
        await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      } catch {}
      let publicUrl: string | null = null;
      try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
      try { await supabase.from('exports').insert({ kind: 'countries_pdf', title: 'Countries', path, public_url: publicUrl, job_id: job.id, meta: {}, comment: comment || null }); } catch {}
      await saveResult(job.id, 'export_countries_pdf', { file: { path, publicUrl } });
      await setJobSucceeded(job.id);
      return;
    }
    // Countries and Overview exports handled elsewhere in system; keep handler narrow
    await setJobFailedOrRequeue(job, 'Unsupported export mode');
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


