import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
};

function abs(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return ('https://2-biz.spysystem.dk' + (url.startsWith('/') ? url : '/' + url));
}

function parseIntEu(raw: string | null | undefined): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Remove thousands separators (.) and spaces; replace comma decimal with dot then parse
  const norm = s.replace(/\./g, '').replace(/\s+/g, '').replace(/,([0-9]{1,2})$/, '.$1');
  const m = norm.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Math.round(Number(m[0]));
}

export async function scrapePurchaseOrders(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:po_begin');
    const url = 'https://2-biz.spysystem.dk/app/purchase/running?oReportSearch=%7B%7D';
    await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
    await log(job.id, 'info', 'STEP:po_nav_ok', { url });

    // Wait for table rows to be present inside the outlet
    await page.waitForSelector('.app-outlet table tbody tr, .app-outlet tbody tr, tbody tr', { timeout: 60_000 });

    const rows = await page.$$eval('tbody tr', (trs) => {
      const out: any[] = [];
      function tx(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
      for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
        if (!tds.length) continue;
        // Status dot
        const dot = tds[0]?.querySelector('._statusDot_19j2q_1, [class*="_statusDot_"]') as HTMLElement | null;
        const cls = (dot?.className || '') as string;
        let status: 'Running' | 'Shipped' | null = null;
        if (/(_orange_|orange)/i.test(cls)) status = 'Running';
        else if (/(_green_|green)/i.test(cls)) status = 'Shipped';

        // PO No + link
        const a = tds[2]?.querySelector('a') as HTMLAnchorElement | null;
        const po_no = (a?.textContent || '').trim();
        const po_link = a?.getAttribute('href') || '';

        // Supplier
        const supplier = tx(tds[3]?.querySelector('span, div')) || null;

        // Styles and Ordered
        const stylesTxt = tx(tds[6]?.querySelector('span')) || tx(tds[6]);
        const orderedTxt = tx(tds[7]?.querySelector('span')) || tx(tds[7]);
        const shippedTxt = tx(tds[8]?.querySelector('span')) || tx(tds[8]);

        // ETD / ETA
        const etd = tx(tds[14]);
        const eta = tx(tds[15]);

        // Purchaser
        const purchaser = tx(tds[18]);

        // Action links
        const actionTd = tds[20] as HTMLElement | undefined;
        let pdf_link: string | null = null;
        let excel_link: string | null = null;
        if (actionTd) {
          for (const a of Array.from(actionTd.querySelectorAll('a')) as HTMLAnchorElement[]) {
            const href = a.getAttribute('href') || '';
            if (!href) continue;
            if (!pdf_link && /pdf/i.test(href)) pdf_link = href;
            if (!excel_link && /excel|xls|xlsx/i.test(href)) excel_link = href;
          }
        }

        if (po_no) {
          out.push({
            status, po_no, supplier,
            styles: stylesTxt, ordered: orderedTxt, shipped: shippedTxt,
            etd, eta, purchaser,
            po_link, pdf_link, excel_link
          });
        }
      }
      return out;
    });

    await log(job.id, 'info', 'STEP:po_rows', { count: rows.length });

    const upserts = rows.map((r: any) => ({
      po_no: r.po_no,
      status: r.status || 'Running',
      supplier: r.supplier || null,
      styles: parseIntEu(r.styles) ?? null,
      ordered: parseIntEu(r.ordered) ?? null,
      shipped: parseIntEu(r.shipped) ?? null,
      etd: r.etd || null,
      eta: r.eta || null,
      purchaser: r.purchaser || null,
      po_link: abs(r.po_link),
      pdf_link: abs(r.pdf_link),
      excel_link: abs(r.excel_link),
      meta: null,
      scraped_at: new Date().toISOString()
    }));

    if (upserts.length) {
      const { error } = await supabase
        .from('purchase_orders')
        .upsert(upserts as any, { onConflict: 'po_no' as any });
      if (error) throw error;
    }

    // Mark POs not in the scraped list as 'Delivered' (if they were Running/Shipped before)
    const scrapedPoNos = upserts.map((u: any) => u.po_no);
    if (scrapedPoNos.length > 0) {
      // Find POs in DB that are Running or Shipped but NOT in the scraped list
      const { data: existingPos } = await supabase
        .from('purchase_orders')
        .select('po_no')
        .in('status', ['Running', 'Shipped'])
        .limit(1000);
      
      const existingPoNos = ((existingPos ?? []) as any[]).map((r) => r.po_no as string);
      const missingPoNos = existingPoNos.filter((poNo) => !scrapedPoNos.includes(poNo));
      
      if (missingPoNos.length > 0) {
        const { error: updateError } = await supabase
          .from('purchase_orders')
          .update({ status: 'Delivered' })
          .in('po_no', missingPoNos as any);
        
        if (updateError) {
          await log(job.id, 'error', 'STEP:po_mark_delivered_error', { error: updateError.message });
        } else {
          await log(job.id, 'info', 'STEP:po_marked_delivered', { count: missingPoNos.length, po_nos: missingPoNos.slice(0, 10) });
        }
      }
    }

    await saveResult(job.id, 'purchase_orders_saved', { count: upserts.length });
    await log(job.id, 'info', 'STEP:po_saved', { count: upserts.length });

    // Automatically enqueue check_purchase_orders to fetch ETD/ETA details
    try {
      const { error: enqueueError } = await supabase
        .from('jobs')
        .insert({
          type: 'check_purchase_orders',
          payload: { requestedBy: 'auto_after_scrape', triggeredBy: job.id },
          status: 'queued',
          max_attempts: 3
        });
      if (enqueueError) {
        await log(job.id, 'error', 'STEP:po_auto_enqueue_check_error', { error: enqueueError.message });
      } else {
        await log(job.id, 'info', 'STEP:po_auto_enqueued_check', { message: 'check_purchase_orders enqueued automatically' });
      }
    } catch (enqErr: any) {
      await log(job.id, 'error', 'STEP:po_auto_enqueue_check_error', { error: enqErr?.message || String(enqErr) });
    }

    await setJobSucceeded(job.id);
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:po_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


