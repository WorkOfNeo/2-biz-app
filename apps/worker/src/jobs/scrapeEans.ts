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
    
    // Check if this is part of a pipeline and wait for previous step
    const payload = job.payload as any;
    if (payload?.requestedBy === 'cron_weekly_style_refresh' && payload?.pipelineStep === 3 && payload?.runKey) {
      const runKey = payload.runKey;
      // Check if deep_scrape_styles (pipelineStep 2) is complete
      const { data: prevJob } = await supabase
        .from('jobs')
        .select('id, status, finished_at')
        .eq('type', 'deep_scrape_styles')
        .contains('payload', { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 2 })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (!prevJob || prevJob.status !== 'succeeded') {
        await log(job.id, 'info', 'WAITING:deep_scrape_styles_not_complete', { 
          prevJobStatus: prevJob?.status || 'not_found',
          runKey 
        });
        throw new Error('WAITING_FOR_DEEP_SCRAPE_STYLES');
      }
      await log(job.id, 'info', 'STEP:deep_scrape_styles_complete', { prevJobId: prevJob.id });
    }
    
    // Check if we're only scraping specific styles (single-style mode)
    const styleNosFilter = Array.isArray(payload?.styleNos) ? (payload.styleNos as string[]) : [];
    const isSingleStyleMode = styleNosFilter.length > 0;
    
    if (isSingleStyleMode) {
      await log(job.id, 'info', 'STEP:ean_single_mode', { styleNos: styleNosFilter });
      // In single-style mode, only delete EANs for these specific styles (not the whole table)
      try {
        await supabase.from('style_color_eans').delete().in('style_no', styleNosFilter);
        await log(job.id, 'info', 'STEP:ean_flushed_filtered', { styleNos: styleNosFilter });
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:ean_flush_filtered_failed', { error: e?.message || String(e) });
      }
    } else {
      // Flush table once at the start (full scrape mode)
      try {
        await supabase.from('style_color_eans').delete().neq('ean', '__keep__');
        await log(job.id, 'info', 'STEP:ean_flushed');
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:ean_flush_failed', { error: e?.message || String(e) });
      }
    }
    
    // Load styles with links
    let stylesQuery = supabase.from('styles').select('id, style_no, link_href');
    if (isSingleStyleMode) {
      stylesQuery = stylesQuery.in('style_no', styleNosFilter);
    }
    const { data: styles } = await stylesQuery;
    const list = (styles ?? []) as Array<{ id: string; style_no: string; link_href: string | null }>;
    if (list.length === 0) {
      await saveResult(job.id, 'EAN scrape: no styles', { count: 0, filtered: isSingleStyleMode });
      await setJobSucceeded(job.id);
      return;
    }
    // Filter to only styles with links
    const stylesWithLinks = list.filter(s => s.link_href);
    const total = stylesWithLinks.length;
    await log(job.id, 'info', 'STEP:ean_total_requested', { totalRequested: total });
    await log(job.id, 'info', 'STEP:ean_filtered', { activeCount: total, skippedNoLink: list.length - total });
    
    let totalInserted = 0;
    let index = 0;
    for (const s of stylesWithLinks) {
      index++;
      await ensureNotCancelled(job.id);
      const href = (s.link_href || '').toString();
      await log(job.id, 'info', 'STEP:ean_progress', { index, total, style_no: s.style_no });
      const base = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '');
      const url = base + '#tab=ean';
      await log(job.id, 'info', 'STEP:ean_nav', { style_no: s.style_no, url });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Try to switch to EAN tab (supports <td data-tab-name="ean"> and <a href="#tab=ean">)
      try {
        const switched = await page.evaluate(() => {
          const td = document.querySelector('.pageTabContainer .pagesTabSelector td[data-tab-name="ean"]') as HTMLElement | null;
          if (td) { td.click(); return true; }
          const byHref = document.querySelector('a[href$="#tab=ean"], a[href*="#tab=ean"]') as HTMLAnchorElement | null;
          if (byHref) { byHref.click(); return true; }
          return false;
        });
        if (switched) await page.waitForTimeout(300);
      } catch {}
      // Wait a bit for the EAN table to load (poll up to ~8s)
      const ok = await page.waitForFunction(() => {
        const tab = document.querySelector('div[data-tab-name="ean"].pagesTab') as HTMLElement | null;
        if (!tab) return false;
        if (getComputedStyle(tab).display === 'none') return false;
        const table = tab.querySelector('.standardList') as HTMLTableElement | null;
        if (!table) return false;
        const head = table.querySelector('thead.table-fixed') as HTMLTableSectionElement | null;
        const ths = head ? Array.from(head.querySelectorAll('th')).map(th => (th.textContent || '').trim().toLowerCase()) : [];
        const hasCols = ths.includes('color') && ths.includes('size') && ths.join(',').includes('ean');
        const hasRows = !!table.querySelector('tbody[data-section_no] tr');
        return hasCols || hasRows;
      }, {}, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!ok) {
        await log(job.id, 'error', 'STEP:ean_no_table', { style_no: s.style_no, error: 'EAN table not found after wait' });
        continue;
      }
      // Extract rows from the active EAN tab only
      const rows = await page.$eval('div[data-tab-name="ean"].pagesTab', (root) => {
        const out: Array<{ color: string; size: string; ean: string }> = [];
        const trs = Array.from(root.querySelectorAll('.standardList tbody[data-section_no] tr')) as HTMLTableRowElement[];
        for (const tr of trs) {
          const parentTbody = tr.closest('tbody') as HTMLElement | null;
          if (parentTbody && parentTbody.classList.contains('table-fixed--skip')) continue;
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 3) continue;
          const color = (tds[0]?.textContent || '').replace(/\s+/g, ' ').trim();
          const size = (tds[1]?.textContent || '').replace(/\s+/g, ' ').trim();
          const eanInput = tds[2]?.querySelector('input.eanfield') as HTMLInputElement | null;
          const ean = (eanInput?.value || '').trim();
          if (color && size && ean) out.push({ color, size, ean });
        }
        return out;
      });
      await log(job.id, 'info', 'STEP:ean_rows', { style_no: s.style_no, count: rows.length, sample: rows.slice(0, 5) });
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
            await log(job.id, 'info', 'STEP:ean_inserted', { style_no: s.style_no, inserted: chunk.length, totalInserted });
          }
        }
      }
      // Log style completion for progress tracking
      await log(job.id, 'info', 'STEP:ean_style_done', { style_no: s.style_no, index, total, inserted: inserts.length });
    }
    await saveResult(job.id, 'EAN scrape completed', { inserted: totalInserted });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:ean_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


