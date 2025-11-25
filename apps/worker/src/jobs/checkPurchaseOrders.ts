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

export async function checkPurchaseOrders(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:check_po_begin');
    // Determine which POs to check: payload.po_nos? else all Running with link
    let poNos: string[] = [];
    try {
      const payloadNos = Array.isArray((job.payload as any)?.po_nos) ? ((job.payload as any)?.po_nos as string[]) : [];
      poNos = payloadNos.filter((s) => typeof s === 'string' && s.trim().length > 0);
    } catch {}
    let targets: Array<{ po_no: string; po_link: string | null }> = [];
    if (poNos.length > 0) {
      const { data } = await supabase.from('purchase_orders').select('po_no, po_link').in('po_no', poNos).limit(500);
      targets = ((data ?? []) as any[]).map((r) => ({ po_no: r.po_no as string, po_link: r.po_link as string | null }));
    } else {
      const { data } = await supabase.from('purchase_orders').select('po_no, po_link').eq('status', 'Running').not('po_link', 'is', null).order('updated_at', { ascending: false }).limit(200);
      targets = ((data ?? []) as any[]).map((r) => ({ po_no: r.po_no as string, po_link: r.po_link as string | null }));
    }
    await log(job.id, 'info', 'STEP:check_po_targets', { count: targets.length });
    // Clear previous state for these POs so we always start fresh
    try {
      const poList = targets.map((t) => t.po_no);
      if (poList.length > 0) {
        await supabase.from('purchase_order_items').delete().in('po_no', poList as any);
        await supabase.from('purchase_orders').update({ category: null }).in('po_no', poList as any);
        await log(job.id, 'info', 'STEP:check_po_cleared', { po_nos: poList.length });
      }
    } catch {}
    let processed = 0;
    for (const t of targets) {
      await ensureNotCancelled(job.id);
      if (!t.po_link) continue;
      const url = abs(t.po_link)!;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      } catch {
        await log(job.id, 'error', 'STEP:check_po_nav_fail', { po_no: t.po_no, url });
        continue;
      }
      // Read internal comment for NOOS CALL OFF marker
      let category: string | null = null;
      try {
        // Wait for the textarea to be present (if exists)
        await page.waitForSelector('textarea[name="POrder[strInternalComment]"]', { timeout: 30_000 }).catch(() => null);
        const val = await page.$eval('textarea[name="POrder[strInternalComment]"]', (el) => {
          const t = el as HTMLTextAreaElement;
          return (t.value || t.textContent || '') as string;
        }).catch(() => '');
        if (/#NOOS_CALL_OFF_ORDER/i.test(val || '')) category = 'NOOS CALL OFF';
      } catch {}
      if (category) {
        try { await supabase.from('purchase_orders').update({ category }).eq('po_no', t.po_no); } catch {}
      }
      // Parse items table
      try {
        await page.waitForSelector('#table1 tbody tr, .pagesMiddle table.standardList tbody tr, .pagesMiddle .standardList tbody tr', { timeout: 60_000 });
      } catch {}
      const items = await page.$$eval('#table1 tbody tr, .pagesMiddle table.standardList tbody tr', (trs) => {
        const out: Array<{ style_no: string | null; style_name: string | null; color: string | null; qty: number | null; style_link: string | null }> = [];
        function txt(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
        let lastStyleNo: string | null = null;
        let lastStyleName: string | null = null;
        for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
          const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
          if (!tds.length) continue;
          const a = tds[1]?.querySelector('a') as HTMLAnchorElement | null;
          const style_no = (a?.textContent || '').trim() || null;
          const style_link = (a?.getAttribute('href') || null);
          const style_name = txt(tds[2]?.querySelector('.textoverflow, div')) || null;
          const color = txt(tds[4]) || null;
          const qtyTxt = txt(tds[8]);
          let qty: number | null = null;
          if (qtyTxt) {
            const norm = qtyTxt.replace(/\./g, '').replace(/\s+/g, '').replace(/,([0-9]{1,2})$/, '.$1');
            const m = norm.match(/-?\d+(?:\.\d+)?/);
            if (m) qty = Math.round(Number(m[0]));
          }
          const useStyleNo = style_no || lastStyleNo;
          const useStyleName = style_name || lastStyleName;
          if (useStyleNo || useStyleName || color || qty !== null) {
            out.push({ style_no: useStyleNo || null, style_name: useStyleName || null, color, qty, style_link });
          }
          if (style_no) lastStyleNo = style_no;
          if (style_name) lastStyleName = style_name;
        }
        // Deduplicate rows by key to avoid double lines (sticky clones etc.)
        const seen = new Set<string>();
        const dedup: typeof out = [];
        for (const r of out) {
          const key = [r.style_no || '', r.style_name || '', r.color || '', String(r.qty ?? ''), r.style_link || ''].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(r);
        }
        return dedup;
      });
      // Items for this PO are already cleared in bulk above
      if (items.length) {
        const rows = items.map((r) => ({
          po_no: t.po_no,
          style_no: r.style_no,
          style_name: r.style_name,
          color: r.color,
          qty: r.qty,
          style_link: r.style_link,
          scraped_at: new Date().toISOString()
        }));
        try { await supabase.from('purchase_order_items').insert(rows); } catch {}
      }
      processed++;
      await log(job.id, 'info', 'STEP:check_po_done_one', { po_no: t.po_no, items: items.length, category });
    }
    await saveResult(job.id, 'check_purchase_orders_done', { processed, targets: targets.length });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:check_po_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


