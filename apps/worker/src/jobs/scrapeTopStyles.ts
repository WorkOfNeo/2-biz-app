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
    await log(job.id, 'info', 'STEP:topstyles_begin_v3');
    // Precheck page state before navigation
    const beforeUrl = page.url();
    const beforeReady = await page.evaluate(() => document.readyState).catch(() => 'unknown');
    await log(job.id, 'info', 'STEP:topstyles_precheck', { initialUrl: beforeUrl, readyState: beforeReady });
    // Ensure current season
    let currentSeasonId: string | null = null;
    try {
      const { data } = await supabase.from('seasons').select('id').eq('is_current', true).maybeSingle();
      currentSeasonId = (data?.id as string | undefined) || null;
    } catch {}
    if (!currentSeasonId) {
      await log(job.id, 'error', 'STEP:topstyles_no_current_season');
      await setJobFailedOrRequeue(job, 'No current season set');
      return;
    }
    await log(job.id, 'info', 'STEP:topstyles_season', { season_id: currentSeasonId });

    // Navigate and login using existing authenticated browser (assumed)
    const webBase = 'https://2-biz.spysystem.dk/confident.php?mode=Topstyles';
    // Hook network/console for diagnostics
    try {
      page.on('response', (res: any) => {
        try {
          const url = res.url?.() || res.url?.() || res.url();
          if (String(url).includes('confident.php') || String(url).includes('Topstyles')) {
            void log(job.id, 'info', 'STEP:topstyles_http_response', { url, status: res.status?.() || res.status?.() || res.status() });
          }
        } catch {}
      });
      page.on('console', (msg: any) => {
        try { void log(job.id, 'info', 'STEP:topstyles_console', { type: msg.type?.() || 'log', text: msg.text?.() || msg.text?.() || String(msg) }); } catch {}
      });
    } catch {}
    await page.goto(webBase, { waitUntil: 'networkidle', timeout: 120_000 });
    const ready = await page.evaluate(() => document.readyState).catch(() => 'unknown');
    const frames = page.frames();
    const frameUrls = frames.map((f) => f.url());
    await log(job.id, 'info', 'STEP:topstyles_nav_ok', { url: webBase, readyState: ready, frames: frameUrls });

    // Helper: find a frame that contains a selector
    async function findFrameWith(selector: string) {
      // Try main page first
      const hasOnMain = await page.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
      if (hasOnMain) return page.mainFrame();
      for (const f of page.frames()) {
        try {
          const ok = await f.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
          if (ok) return f;
        } catch {}
      }
      return null as any;
    }

    // Resolve frame for select + table
    const selectFrame = await findFrameWith('select[name="strGroupBy"]');
    const tableFrame = await findFrameWith('table.standardList tbody tr');
    await log(job.id, 'info', 'STEP:topstyles_selectors_resolved', {
      selectFrameUrl: selectFrame?.url?.() || null,
      tableFrameUrl: tableFrame?.url?.() || null,
    });
    // Switch grouping to color
    try {
      const target = selectFrame || page;
      await log(job.id, 'info', 'STEP:topstyles_group_set_attempt', { groupBy: 'color', inFrameUrl: (selectFrame || page.mainFrame())?.url?.() || null });
      await target.selectOption('select[name="strGroupBy"]', 'color');
      // Some pages require a JS event to fire request
      await target.evaluate(() => {
        const sel = document.querySelector('select[name="strGroupBy"]') as HTMLSelectElement | null;
        if (sel) sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // wait for table update (either XHR or DOM change)
      await Promise.race([
        (tableFrame || page).waitForResponse((res: any) => res.url().includes('confident.php') || res.request().url().includes('confident.php'), { timeout: 15_000 }).catch(() => null),
        (tableFrame || page).waitForTimeout(1500)
      ]);
      await log(job.id, 'info', 'STEP:topstyles_wait_done');
      await (tableFrame || page).waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
      await (tableFrame || page).waitForTimeout(500);
      await log(job.id, 'info', 'STEP:topstyles_group_set', { groupBy: 'color' });

      // Verify header shows Color in column 3; retry toggling if needed
      const verifyHeader = async () => {
        try {
          const header = await (tableFrame || page).evaluate(() => {
            const headers = Array.from(document.querySelectorAll('table.standardList thead th a')) as any[];
            return headers.map((a: any) => (a?.textContent || '').trim());
          });
          await log(job.id, 'info', 'STEP:topstyles_header_check', { header });
          return Array.isArray(header) && header[3] === 'Color';
        } catch {
          return false;
        }
      };

      let ok = await verifyHeader();
      let attempts = 0;
      while (!ok && attempts < 4) {
        attempts++;
        await log(job.id, 'info', 'STEP:topstyles_header_retry', { attempts });
        // Toggle to style then back to color to force refresh
        try {
          await target.selectOption('select[name="strGroupBy"]', 'style');
          await target.evaluate(() => {
            const sel = document.querySelector('select[name="strGroupBy"]') as HTMLSelectElement | null;
            if (sel) sel.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await (tableFrame || page).waitForTimeout(800);
        } catch {}
        try {
          await target.selectOption('select[name="strGroupBy"]', 'color');
          await target.evaluate(() => {
            const sel = document.querySelector('select[name="strGroupBy"]') as HTMLSelectElement | null;
            if (sel) sel.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await Promise.race([
            (tableFrame || page).waitForResponse((res: any) => res.url().includes('confident.php') || res.request().url().includes('confident.php'), { timeout: 10_000 }).catch(() => null),
            (tableFrame || page).waitForTimeout(1200)
          ]);
          await (tableFrame || page).waitForSelector('table.standardList tbody tr', { timeout: 60_000 }).catch(() => null);
          await (tableFrame || page).waitForTimeout(400);
        } catch {}
        ok = await verifyHeader();
      }
      await log(job.id, ok ? 'info' : 'error', ok ? 'STEP:topstyles_header_ok' : 'STEP:topstyles_header_still_wrong', { attempts });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:topstyles_group_set_failed', { error: e?.message || String(e) });
    }
    // Extract rows
    let rows = await (tableFrame || page).$$eval('table.standardList tbody tr', (trs: any[]) => {
      return Array.from(trs).slice(0, 100).map((tr: any) => {
        const tds = Array.from((tr as any).querySelectorAll('td')) as any[];
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
    await log(job.id, 'info', 'STEP:topstyles_rows_raw', { count: (rows || []).length });
    if (rows && rows.length) {
      for (let i = 0; i < rows.length; i++) {
        try { await log(job.id, 'info', 'STEP:topstyles_row_raw', { index: i, row: rows[i] }); } catch {}
      }
    }
    if (!rows || rows.length === 0) {
      // fallback: try without changing group
      await log(job.id, 'info', 'STEP:topstyles_zero_rows_try_style');
      rows = await (tableFrame || page).$$eval('table.standardList tbody tr', (trs: any[]) => {
        return Array.from(trs).slice(0, 100).map((tr: any) => {
          const tds = Array.from((tr as any).querySelectorAll('td')) as any[];
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
      // If still empty, log a small HTML snippet to debug
      if (!rows || rows.length === 0) {
        const snippet = await (tableFrame || page).evaluate(() => {
          const el = document.querySelector('table.standardList');
          return el ? el.outerHTML.slice(0, 2000) : (document.body?.innerText || '').slice(0, 2000);
        }).catch(() => 'no-html');
        await log(job.id, 'error', 'STEP:topstyles_no_rows_after_fallback', { htmlSnippet: snippet });
      }
    }
    await log(job.id, 'info', 'STEP:topstyles_rows_extracted', { rows: rows.length });
    const parsed = (rows as any[]).map((r: any) => {
      const img1024 = r.img.replace('s24', 's1024');
      const qty = parseNumberEu(r.qty);
      const amount = parseNumberEu(r.amount);
      return { image_url: img1024, style_no: r.styleNo, style_name: r.styleName, color: r.color, type: r.type, quality: r.quality, qty, amount, currency: 'DKK' };
    }).sort((a: any, b: any) => b.qty - a.qty).slice(0, 10);
    await log(job.id, 'info', 'STEP:topstyles_rows_parsed', { count: parsed.length });
    if (parsed && parsed.length) {
      for (let i = 0; i < parsed.length; i++) {
        try { await log(job.id, 'info', 'STEP:topstyles_row_parsed', { index: i, row: parsed[i] }); } catch {}
      }
    }
    if (parsed[0]) {
      await log(job.id, 'info', 'STEP:topstyles_sample', { first: parsed[0] });
    }
    // Replace existing rows for season
    try { await supabase.from('top_styles').delete().eq('season_id', currentSeasonId); } catch {}
    if (parsed.length) {
      const insert = parsed.map((p: any) => ({ season_id: currentSeasonId, ...p }));
      const { data: inserted, error } = await supabase.from('top_styles').insert(insert).select('id, season_id, style_no, color');
      await log(job.id, 'info', 'STEP:topstyles_insert_result', { insertedCount: inserted?.length || 0, error: error ? String(error.message || error) : null });
      if (error) throw error;
    }
    await log(job.id, 'info', 'STEP:topstyles_saved', { season_id: currentSeasonId, count: parsed.length });
    await saveResult(job.id, 'top_styles_saved', { season_id: currentSeasonId, count: parsed.length });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


