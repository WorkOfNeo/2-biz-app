import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  supabase: any;
};

function parseNumberEu(input: string): number {
  const s = String(input || '').replace(/\./g, '').replace(/\s/g, '').replace(/,/, '.');
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : 0;
}

export async function scrapeTopStyles(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  try {
    await log(job.id, 'info', 'STEP:topstyles_begin');
    // Ensure current season
    let currentSeasonId: string | null = null;
    try {
      const { data } = await supabase.from('seasons').select('id').eq('is_current', true).maybeSingle();
      currentSeasonId = (data?.id as string | undefined) || null;
    } catch {}
    if (!currentSeasonId) throw new Error('No current season set');
    await log(job.id, 'info', 'STEP:topstyles_season', { season_id: currentSeasonId });

    // Navigate and login using existing authenticated browser (assumed)
    const webBase = 'https://2-biz.spysystem.dk/confident.php?mode=Topstyles';
    await page.goto(webBase, { waitUntil: 'networkidle', timeout: 120_000 });
    await log(job.id, 'info', 'STEP:topstyles_nav_ok', { url: webBase });
    // Switch grouping to color
    try {
      await page.selectOption('select[name="strGroupBy"]', 'color');
      // Some pages require a JS event to fire request
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="strGroupBy"]') as HTMLSelectElement | null;
        if (sel) sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // wait for table update (either XHR or DOM change)
      await Promise.race([
        page.waitForResponse((res) => res.url().includes('confident.php') || res.request().url().includes('confident.php'), { timeout: 15_000 }).catch(() => null),
        page.waitForTimeout(1500)
      ]);
      await page.waitForSelector('.spy-container table.standardList tbody tr', { timeout: 60_000 });
      await page.waitForTimeout(500);
      await log(job.id, 'info', 'STEP:topstyles_group_set', { groupBy: 'color' });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:topstyles_group_set_failed', { error: e?.message || String(e) });
    }
    // Extract rows
    let rows = await page.$$eval('.spy-container table.standardList tbody tr', (trs) => {
      return Array.from(trs).slice(0, 100).map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const img = (tds[0]?.querySelector('img') as HTMLImageElement | null)?.src || '';
        const styleNo = (tds[1]?.textContent || '').trim();
        const styleName = (tds[2]?.textContent || '').trim();
        const color = (tds[3]?.textContent || '').trim();
        const type = (tds[4]?.textContent || '').trim();
        const quality = (tds[5]?.textContent || '').trim();
        const qty = (tds[6]?.textContent || '').trim();
        const amount = (tds[7]?.textContent || '').trim();
        return { img, styleNo, styleName, color, type, quality, qty, amount };
      });
    });
    if (!rows || rows.length === 0) {
      // fallback: try without changing group
      await log(job.id, 'info', 'STEP:topstyles_zero_rows_try_style');
      rows = await page.$$eval('table.standardList tbody tr', (trs) => {
        return Array.from(trs).slice(0, 100).map((tr) => {
          const tds = Array.from(tr.querySelectorAll('td'));
          const img = (tds[0]?.querySelector('img') as HTMLImageElement | null)?.src || '';
          const styleNo = (tds[1]?.textContent || '').trim();
          const styleName = (tds[2]?.textContent || '').trim();
          const color = (tds[3]?.textContent || '').trim();
          const type = (tds[4]?.textContent || '').trim();
          const quality = (tds[5]?.textContent || '').trim();
          const qty = (tds[6]?.textContent || '').trim();
          const amount = (tds[7]?.textContent || '').trim();
          return { img, styleNo, styleName, color, type, quality, qty, amount };
        });
      });
    }
    await log(job.id, 'info', 'STEP:topstyles_rows_extracted', { rows: rows.length });
    const parsed = rows.map((r) => {
      const img1024 = r.img.replace('s24', 's1024');
      const qty = parseNumberEu(r.qty);
      const amount = parseNumberEu(r.amount);
      return { image_url: img1024, style_no: r.styleNo, style_name: r.styleName, color: r.color, type: r.type, quality: r.quality, qty, amount, currency: 'DKK' };
    }).sort((a, b) => b.qty - a.qty).slice(0, 10);
    if (parsed[0]) {
      await log(job.id, 'info', 'STEP:topstyles_sample', { first: parsed[0] });
    }
    // Replace existing rows for season
    try { await supabase.from('top_styles').delete().eq('season_id', currentSeasonId); } catch {}
    if (parsed.length) {
      const insert = parsed.map((p) => ({ season_id: currentSeasonId, ...p }));
      const { error } = await supabase.from('top_styles').insert(insert);
      if (error) throw error;
    }
    await log(job.id, 'info', 'STEP:topstyles_saved', { season_id: currentSeasonId, count: parsed.length });
    await saveResult(job.id, 'top_styles_saved', { season_id: currentSeasonId, count: parsed.length });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


