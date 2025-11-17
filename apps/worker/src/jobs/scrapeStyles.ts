import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  captureHtmlSnippet: (target: any, fallbackPage: Page) => Promise<string>;
  supabase: any;
  SPY_BASE_URL: string;
  findFirst: (page: Page, selectors: string[]) => Promise<import('playwright-core').Locator | null>;
};

export async function scrapeStyles(ctx: Ctx) {
  const { job, page, log, saveResult, ensureNotCancelled, captureHtmlSnippet, supabase, SPY_BASE_URL, findFirst } = ctx;
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:styles_begin');
  const stylesUrl = new URL('?controller=Style%5CIndex&action=List&Spy%5CModel%5CStyle%5CIndex%5CListReportSearch%5BbForceSearch%5D=true', SPY_BASE_URL).toString();
  await page.goto(stylesUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:styles_url', { url: stylesUrl });
  try {
    await page.waitForSelector('table.standardList', { timeout: 60_000, state: 'attached' as any });
    await log(job.id, 'info', 'STEP:styles_table_found');
  } catch (e: any) {
    const html = await captureHtmlSnippet(page, page);
    await log(job.id, 'error', 'STEP:styles_table_not_found', { error: e?.message || String(e), html });
    throw e;
  }
  try {
    const showAll = await findFirst(page, ['button[name="show_all"]', 'input[name="show_all"]', 'button:has-text("Show All")']);
    if (showAll) {
      await showAll.click({ timeout: 30_000 }).catch(() => {});
      await log(job.id, 'info', 'STEP:styles_show_all_clicked');
      await page.waitForTimeout(1200);
    } else {
      await log(job.id, 'info', 'STEP:styles_show_all_not_found');
    }
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:styles_show_all_error', { error: e?.message || String(e) });
  }
  await page.waitForSelector('table.standardList tbody tr', { timeout: 60_000, state: 'attached' as any });
  try {
    let last = 0;
    for (let i = 0; i < 20; i++) {
      await ensureNotCancelled(job.id);
      const count = await page.$$eval('table.standardList tbody tr', (trs) => trs.length);
      await log(job.id, 'info', 'STEP:styles_rows_count', { iteration: i + 1, count });
      if (count >= 100) break;
      if (count > last) {
        last = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
      } else {
        break;
      }
    }
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:styles_scroll_error', { error: e?.message || String(e) });
  }
  await ensureNotCancelled(job.id);
  const rows = await page.$$eval('table.standardList tbody tr', (trs) => {
    const out: { spy_id: string | null; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; link_href: string | null }[] = [];
    for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
      const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
      const spyId = (tr.getAttribute('data-reference') || null);
      const img = tds[0]?.querySelector('img') as HTMLImageElement | null;
      const a = tds[1]?.querySelector('a') as HTMLAnchorElement | null;
      const styleNo = (a?.textContent || '').trim();
      const styleName = (tds[2]?.textContent || '').replace(/\s+/g, ' ').trim() || null;
      const supplier = (tds[7]?.textContent || '').replace(/\s+/g, ' ').trim() || null;
      if (styleNo) {
        const rawImg = (img?.getAttribute('src') || '') as string;
        const bigImg = rawImg ? rawImg.replace(/tr:n-s\d+/i, 'tr:n-s1024') : null;
        out.push({ spy_id: spyId, style_no: styleNo, style_name: styleName, supplier, image_url: (bigImg || null), link_href: (a?.getAttribute('href') || null) });
      }
    }
    return out;
  });
  await log(job.id, 'info', 'STEP:styles_rows', { count: rows.length });
  // Enrich with style_type (category) by briefly visiting each style detail page to read the selected Type
  for (let i = 0; i < rows.length; i++) {
    await ensureNotCancelled(job.id);
    const r = rows[i];
    if (!r.link_href) continue;
    try {
      const detailUrl = new URL(r.link_href, SPY_BASE_URL).toString();
      await log(job.id, 'info', 'STEP:styles_detail_nav', { style_no: r.style_no, url: detailUrl, index: i + 1, total: rows.length });
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const typeText = await page.$eval('select[name=\"sTypeId\"]', (sel: HTMLSelectElement) => {
        const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
        return (opt?.textContent || '').trim();
      }).catch(() => null as string | null);
      (r as any).style_type = typeText;
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:styles_detail_error', { style_no: r.style_no, error: e?.message || String(e) });
    }
  }
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    await ensureNotCancelled(job.id);
    const batch = rows.slice(i, i + 1000);
    const { error } = await supabase.from('styles').upsert(batch.map(r => ({
      spy_id: r.spy_id,
      style_no: r.style_no,
      style_name: r.style_name,
      supplier: r.supplier,
      style_type: (r as any).style_type || null,
      image_url: r.image_url,
      link_href: r.link_href,
      updated_at: new Date().toISOString()
    })), { onConflict: 'style_no' });
    if (error) throw error;
    upserted += batch.length;
    await log(job.id, 'info', 'STEP:styles_batch_upsert', { upserted, total: rows.length });
  }
  await saveResult(job.id, 'Styles scrape completed', { upserted });
  await log(job.id, 'info', 'STEP:complete', { upserted });
}


