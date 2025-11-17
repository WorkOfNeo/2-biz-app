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
  SPY_BASE_URL: string;
};

export async function scrapeEans(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  try {
    await log(job.id, 'info', 'STEP:ean_begin');
    // Flush table once at the start
    try {
      await supabase.from('style_color_eans').delete().neq('ean', '__keep__');
      await log(job.id, 'info', 'STEP:ean_flushed');
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:ean_flush_failed', { error: e?.message || String(e) });
    }
    // Load styles with links
    const { data: styles } = await supabase.from('styles').select('id, style_no, link_href');
    const list = (styles ?? []) as Array<{ id: string; style_no: string; link_href: string | null }>;
    if (list.length === 0) {
      await saveResult(job.id, 'EAN scrape: no styles', { count: 0 });
      await setJobSucceeded(job.id);
      return;
    }
    let totalInserted = 0;
    const total = list.length;
    let index = 0;
    for (const s of list) {
      index++;
      await ensureNotCancelled(job.id);
      const href = (s.link_href || '').toString();
      if (!href) continue;
      await log(job.id, 'info', 'STEP:ean_progress', { index, total, style_no: s.style_no });
      const base = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '');
      const url = base + '#tab=ean';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Try to switch to EAN tab robustly (by href or visible text)
      try {
        const switched = await page.evaluate(() => {
          function clickEl(el: Element | null): boolean {
            if (!el) return false;
            (el as HTMLElement).click();
            return true;
          }
          const byHref = document.querySelector('a[href$="#tab=ean"], a[href*="#tab=ean"]') as HTMLAnchorElement | null;
          if (clickEl(byHref)) return true;
          const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
          const eanLink = links.find(a => (a.textContent || '').trim().toLowerCase() === 'ean');
          if (clickEl(eanLink || null)) return true;
          return false;
        });
        if (switched) await page.waitForTimeout(300);
      } catch {}
      // Avoid waiting for "visible" (some tables may be present but hidden before clicking),
      // just ensure the container exists or move on quickly (max ~5s)
      const hasContainer = await page.waitForSelector('.spy-container', { timeout: 5000 }).then(() => true).catch(() => false);
      if (!hasContainer) {
        await log(job.id, 'error', 'STEP:ean_no_table', { style_no: s.style_no, error: 'EAN container not found' });
        continue;
      }
      // Extract rows
      const rows = await page.$$eval('.spy-container .standardList tbody[data-section_no] tr', (trs) => {
        const out: Array<{ color: string; size: string; ean: string }> = [];
        for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
          const parentTbody = tr.closest('tbody') as HTMLTableSectionElement | null;
          if (parentTbody && parentTbody.classList.contains('table-fixed--skip')) continue;
          const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
          if (tds.length < 3) continue;
          const color = (tds[0]?.textContent || '').replace(/\s+/g, ' ').trim();
          const size = (tds[1]?.textContent || '').replace(/\s+/g, ' ').trim();
          const eanInput = tds[2]?.querySelector('input.eanfield') as HTMLInputElement | null;
          const ean = (eanInput?.value || '').trim();
          if (color && size && ean) out.push({ color, size, ean });
        }
        return out;
      });
      if (!rows.length) continue;
      // Map color -> style_color_id for this style
      const { data: colorRows } = await supabase.from('style_colors').select('id, color').eq('style_id', s.id);
      const byColor = new Map<string, string>();
      for (const r of (colorRows ?? []) as any[]) byColor.set(String(r.color || '').trim().toLowerCase(), String(r.id));
      // Prepare inserts
      const inserts = rows.map((r) => ({
        style_id: s.id,
        style_no: s.style_no,
        style_color_id: byColor.get(r.color.trim().toLowerCase()) || null,
        color: r.color,
        size: r.size,
        ean: r.ean,
        scraped_at: new Date().toISOString()
      }));
      if (inserts.length) {
        // Insert in chunks to avoid payload size issues
        const CHUNK = 500;
        for (let i = 0; i < inserts.length; i += CHUNK) {
          const chunk = inserts.slice(i, i + CHUNK);
          const { error } = await supabase.from('style_color_eans').insert(chunk as any);
          if (error) {
            await log(job.id, 'error', 'STEP:ean_insert_error', { style_no: s.style_no, error: error?.message || String(error) });
          } else {
            totalInserted += chunk.length;
          }
        }
      }
    }
    await saveResult(job.id, 'EAN scrape completed', { inserted: totalInserted });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:ean_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


