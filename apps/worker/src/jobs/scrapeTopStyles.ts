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
    const selectFrame = await findFrameWith('.top-styles-container select[name="strGroupBy"], select[name="strGroupBy"]');
    const tableFrame = await findFrameWith('.top-styles-container table.standardList tbody tr');
    await log(job.id, 'info', 'STEP:topstyles_selectors_resolved', {
      selectFrameUrl: selectFrame?.url?.() || null,
      tableFrameUrl: tableFrame?.url?.() || null,
    });
    // Helper: enforce Color grouping with retries and hard failure
    const setGroupByColor = async (): Promise<boolean> => {
      try {
        const target = (tableFrame || selectFrame || page);
        await log(job.id, 'info', 'STEP:topstyles_group_set_attempt', { groupBy: 'color', inFrameUrl: (selectFrame || page.mainFrame())?.url?.() || null });
        // Prefer the select inside the top-styles container
        await target.evaluate(() => {
          const sc = document.querySelector('.top-styles-container select[name="strGroupBy"]') as HTMLSelectElement | null;
          const sel = sc || (document.querySelector('select[name="strGroupBy"]') as HTMLSelectElement | null);
          if (sel) {
            sel.value = 'color';
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            if (sel.form) {
              if (typeof (sel.form as any).requestSubmit === 'function') {
                (sel.form as any).requestSubmit();
              } else {
                sel.form.submit();
              }
            }
          }
        });
        try { await target.selectOption('.top-styles-container select[name="strGroupBy"], select[name="strGroupBy"]', 'color'); } catch {}
        // Robust waiting: allow either network response or DOM fulfillment of header + rows
        await Promise.race([
          page.waitForResponse((res: any) => {
            try { const url = res.url?.() || res.url?.() || res.url(); return String(url).includes('confident.php'); } catch { return false; }
          }, { timeout: 15_000 }).catch(() => null),
          (tableFrame || page).waitForFunction(() => {
            const sel = (document.querySelector('.top-styles-container select[name="strGroupBy"]') || document.querySelector('select[name="strGroupBy"]')) as HTMLSelectElement | null;
            const anchors = Array.from(document.querySelectorAll('.top-styles-container table.standardList thead th a')).map(a => (a.textContent || '').trim());
            const rows = document.querySelectorAll('.top-styles-container table.standardList tbody tr').length;
            return sel?.value === 'color' && anchors[3] === 'Color' && rows > 0;
          }, {}, { timeout: 15_000 }).catch(() => null)
        ]);
        try { await page.waitForLoadState('networkidle', { timeout: 5_000 }); } catch {}
        await (tableFrame || page).waitForSelector('.top-styles-container table.standardList tbody tr', { timeout: 60_000 });
        await (tableFrame || page).waitForTimeout(500);
        // Verify header
        const ok = await (async () => {
          try {
            const info = await (tableFrame || page).evaluate(() => {
              function headerTexts(): string[] {
                const ths = Array.from(document.querySelectorAll('.top-styles-container table.standardList thead th')) as HTMLElement[];
                return ths.map((th) => {
                  const a = th.querySelector('a');
                  const txt = (a?.textContent || th.innerText || th.textContent || '') as string;
                  return txt.replace(/\s+/g, ' ').trim();
                });
              }
              const sel = (document.querySelector('.top-styles-container select[name="strGroupBy"]') || document.querySelector('select[name="strGroupBy"]')) as HTMLSelectElement | null;
              return { headers: headerTexts(), selectValue: sel?.value || null };
            });
            await log(job.id, 'info', 'STEP:topstyles_header_check', info as any);
            const h = (info as any)?.headers as string[];
            const expect = ['','Style No.','Style Name','Color','Type','Quality','Qty','Sales Amount'];
            const exact = Array.isArray(h) && h.length >= 8 && h[1] === expect[1] && h[2] === expect[2] && h[3] === expect[3] && /qty/i.test(h[6]||'') && /sales/i.test(h[7]||'');
            const isColorSelected = (info as any)?.selectValue === 'color';
            return exact && isColorSelected;
          } catch {
            return false;
          }
        })();
        await log(job.id, ok ? 'info' : 'error', ok ? 'STEP:topstyles_header_ok' : 'STEP:topstyles_header_still_wrong');
        if (!ok) {
          // Try one more toggle sequence: style -> color
          try {
            await target.selectOption('.top-styles-container select[name="strGroupBy"], select[name="strGroupBy"]', 'style');
            await (tableFrame || page).waitForTimeout(400);
          } catch {}
          try {
            await target.selectOption('.top-styles-container select[name="strGroupBy"], select[name="strGroupBy"]', 'color');
            await (tableFrame || page).waitForFunction(() => {
              const sel = (document.querySelector('.top-styles-container select[name="strGroupBy"]') || document.querySelector('select[name="strGroupBy"]')) as HTMLSelectElement | null;
              const anchors = Array.from(document.querySelectorAll('.top-styles-container table.standardList thead th a')).map(a => (a.textContent || '').trim());
              const rows = document.querySelectorAll('.top-styles-container table.standardList tbody tr').length;
              return sel?.value === 'color' && anchors[3] === 'Color' && rows > 0;
            }, {}, { timeout: 10_000 }).catch(() => null);
          } catch {}
          return await setGroupByColor();
        }
        return true;
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:topstyles_group_set_failed', { error: e?.message || String(e) });
        return false;
      }
    };

    const grouped = await setGroupByColor();
    if (!grouped) {
      await log(job.id, 'error', 'STEP:topstyles_group_set_gave_up');
      throw new Error('Could not switch group to color');
    }
    // Resolve header mapping to be robust against column order
    const headerEval = await (tableFrame || page).evaluate(() => {
      const ths = Array.from(document.querySelectorAll('.top-styles-container table.standardList thead th')) as HTMLElement[];
      const headers = ths.map((th) => ((th.innerText || th.textContent || '') as string).replace(/\s+/g, ' ').trim());
      const anchors = ths.map((th) => {
        const a = th.querySelector('a');
        return ((a?.textContent || th.innerText || th.textContent || '') as string).replace(/\s+/g, ' ').trim();
      });
      return { headers, anchors };
    });
    const headerTexts: string[] = (headerEval as any)?.headers || [];
    const anchorTexts: string[] = (headerEval as any)?.anchors || headerTexts;
    const findIdx = (patterns: RegExp[]): number => {
      for (let i = 0; i < headerTexts.length; i++) {
        const h = headerTexts[i] || '';
        if (patterns.some((re) => re.test(h))) return i;
      }
      return -1;
    };
    const idxMap = {
      img: 0,
      styleNo: findIdx([/style\s*no\.?/i, /^style$/i]),
      styleName: findIdx([/style\s*name/i, /^name$/i]),
      color: findIdx([/color/i, /colour/i]),
      type: findIdx([/^type$/i]),
      quality: findIdx([/^quality$/i]),
      qty: findIdx([/^qty/i, /quantity/i]),
      amount: findIdx([/amount/i, /sales/i])
    } as { img: number; styleNo: number; styleName: number; color: number; type: number; quality: number; qty: number; amount: number };
    // Prefer exact anchor positions when available
    const exact = {
      styleNo: anchorTexts.findIndex((h) => /^Style\s*No\.?$/i.test(h)),
      styleName: anchorTexts.findIndex((h) => /^Style\s*Name$/i.test(h)),
      color: anchorTexts.findIndex((h) => /^Color$/i.test(h)),
      type: anchorTexts.findIndex((h) => /^Type$/i.test(h)),
      quality: anchorTexts.findIndex((h) => /^Quality$/i.test(h)),
      qty: anchorTexts.findIndex((h) => /^Qty$/i.test(h) || /Qty\s*$/i.test(h)),
      amount: anchorTexts.findIndex((h) => /Sales\s*Amount/i.test(h) || /^Amount$/i.test(h)),
    };
    if (exact.styleNo >= 0) idxMap.styleNo = exact.styleNo;
    if (exact.styleName >= 0) idxMap.styleName = exact.styleName;
    if (exact.color >= 0) idxMap.color = exact.color;
    if (exact.type >= 0) idxMap.type = exact.type;
    if (exact.quality >= 0) idxMap.quality = exact.quality;
    if (exact.qty >= 0) idxMap.qty = exact.qty;
    if (exact.amount >= 0) idxMap.amount = exact.amount;
    await log(job.id, 'info', 'STEP:topstyles_header_map', { headers: headerTexts, anchors: anchorTexts, idxMap });
    // Fallback to expected positions if detection failed
    if (idxMap.styleNo < 0) idxMap.styleNo = 1;
    if (idxMap.styleName < 0) idxMap.styleName = 2;
    if (idxMap.color < 0) idxMap.color = 3;
    if (idxMap.type < 0) idxMap.type = 4;
    if (idxMap.quality < 0) idxMap.quality = 5;
    if (idxMap.qty < 0) idxMap.qty = 6;
    if (idxMap.amount < 0) idxMap.amount = 7;

    // Extract rows using detected indices (with validation pass)
    let rows = await (tableFrame || page).$$eval('.top-styles-container table.standardList tbody tr', (trs: any[], idx: any) => {
      return Array.from(trs).slice(0, 100).map((tr: any) => {
        const tds = Array.from((tr as any).querySelectorAll('td')) as any[];
        const img = (tds[idx.img]?.querySelector('img') as HTMLImageElement | null)?.src || '';
        const styleNo = (tds[idx.styleNo]?.textContent || '').toString().trim();
        const styleName = (tds[idx.styleName]?.textContent || '').toString().trim();
        const color = (tds[idx.color]?.textContent || '').toString().trim();
        const type = (tds[idx.type]?.textContent || '').toString().trim();
        const quality = (tds[idx.quality]?.textContent || '').toString().trim();
        const qty = (tds[idx.qty]?.textContent || '').toString().trim();
        const amount = (tds[idx.amount]?.textContent || '').toString().trim();
        return { img, styleNo, styleName, color, type, quality, qty, amount };
      });
    }, idxMap as any);
    await log(job.id, 'info', 'STEP:topstyles_rows_raw', { count: (rows || []).length });
    if (rows && rows.length) {
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        try { await log(job.id, 'info', 'STEP:topstyles_row_raw', { index: i, row: rows[i] }); } catch {}
      }
    }
    if (!rows || rows.length === 0) {
      // fallback: try without changing group
      await log(job.id, 'info', 'STEP:topstyles_zero_rows_try_style');
      rows = await (tableFrame || page).$$eval('.top-styles-container table.standardList tbody tr', (trs: any[]) => {
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
          const container = document.querySelector('.top-styles-container');
          const table = container?.querySelector('table.standardList') as HTMLElement | null;
          if (table) return table.outerHTML.slice(0, 2000);
          if (container) return container.outerHTML.slice(0, 2000);
          return (document.body?.innerText || '').slice(0, 2000);
        }).catch(() => 'no-html');
        await log(job.id, 'error', 'STEP:topstyles_no_rows_after_fallback', { htmlSnippet: snippet });
      }
    }
    // Post-extract verification: ensure header still correct; if not, re-group and re-extract once
    const stillOk = await (async () => {
      try {
        const info = await (tableFrame || page).evaluate(() => {
          const ths = Array.from(document.querySelectorAll('.top-styles-container table.standardList thead th')) as HTMLElement[];
          const headers = ths.map((th) => {
            const a = th.querySelector('a');
            const txt = (a?.textContent || th.innerText || th.textContent || '') as string;
            return txt.replace(/\s+/g, ' ').trim();
          });
          const sel = (document.querySelector('.top-styles-container select[name="strGroupBy"]') || document.querySelector('select[name="strGroupBy"]')) as HTMLSelectElement | null;
          return { headers, selectValue: sel?.value || null };
        });
        const h = (info as any)?.headers as string[];
        const ok = Array.isArray(h) && h[3] === 'Color' && ((info as any)?.selectValue === 'color');
        return ok;
      } catch { return false; }
    })();
    if (!stillOk) {
      await log(job.id, 'error', 'STEP:topstyles_post_extract_header_wrong');
      const regrouped = await setGroupByColor();
      if (!regrouped) throw new Error('Color header verification failed after extract');
      rows = await (tableFrame || page).$$eval('.top-styles-container table.standardList tbody tr', (trs: any[], idx: any) => {
        return Array.from(trs).slice(0, 100).map((tr: any) => {
          const tds = Array.from((tr as any).querySelectorAll('td')) as any[];
          const img = (tds[idx.img]?.querySelector('img') as HTMLImageElement | null)?.src || '';
          const styleNo = (tds[idx.styleNo]?.textContent || '').toString().trim();
          const styleName = (tds[idx.styleName]?.textContent || '').toString().trim();
          const color = (tds[idx.color]?.textContent || '').toString().trim();
          const type = (tds[idx.type]?.textContent || '').toString().trim();
          const quality = (tds[idx.quality]?.textContent || '').toString().trim();
          const qty = (tds[idx.qty]?.textContent || '').toString().trim();
          const amount = (tds[idx.amount]?.textContent || '').toString().trim();
          return { img, styleNo, styleName, color, type, quality, qty, amount };
        });
      }, idxMap as any);
      await log(job.id, 'info', 'STEP:topstyles_rows_raw_retry', { count: (rows || []).length });
    }
    await log(job.id, 'info', 'STEP:topstyles_rows_extracted', { rows: rows.length });
    const parsed = (rows as any[]).map((r: any) => {
      const img1024 = r.img.replace('s24', 's1024');
      const qty = parseNumberEu(r.qty);
      const amount = parseNumberEu(r.amount);
      return { image_url: img1024, style_no: r.styleNo, style_name: r.styleName, color: r.color, type: r.type, quality: r.quality, qty, sales_amount: amount, currency: 'DKK' };
    }).sort((a: any, b: any) => b.qty - a.qty);
    await log(job.id, 'info', 'STEP:topstyles_rows_parsed', { count: parsed.length });
    if (parsed && parsed.length) {
      for (let i = 0; i < Math.min(parsed.length, 10); i++) {
        try { await log(job.id, 'info', 'STEP:topstyles_row_parsed', { index: i, row: parsed[i] }); } catch {}
      }
    }
    // Sanity check: if color equals type in majority of first 10, warn
    try {
      const sample = parsed.slice(0, 10);
      const eq = sample.reduce((a, r) => a + (String(r.color || '').toUpperCase() === String(r.type || '').toUpperCase() ? 1 : 0), 0);
      if (sample.length >= 5 && eq / sample.length > 0.7) {
        await log(job.id, 'error', 'STEP:topstyles_color_suspect', { eq, sample: sample.map(r => ({ style_no: r.style_no, color: r.color, type: r.type })).slice(0, 10) });
      }
    } catch {}
    if (parsed[0]) {
      await log(job.id, 'info', 'STEP:topstyles_sample', { first: parsed[0] });
    }
    // Aggregate by style_no (sum qty/sales_amount across colors) and UPSERT all for current season
    const byStyle = new Map<string, { season_id: string; style_no: string; style_name: string | null; image_url: string | null; type: string | null; quality: string | null; qty: number; sales_amount: number; sort_index: number; colors: Set<string> }>();
    for (const p of parsed) {
      const key = p.style_no;
      const prev = byStyle.get(key);
      if (!prev) {
        byStyle.set(key, {
          season_id: currentSeasonId!,
          style_no: p.style_no,
          style_name: p.style_name || null,
          image_url: p.image_url || null,
          type: p.type || null,
          quality: p.quality || null,
          qty: Number(p.qty || 0) || 0,
          sales_amount: Number(p.sales_amount || 0) || 0,
          sort_index: 0,
          colors: new Set<string>([(p.color || '').trim()].filter(Boolean))
        });
      } else {
        prev.qty += Number(p.qty || 0) || 0;
        prev.sales_amount += Number(p.sales_amount || 0) || 0;
        if ((p.color || '').trim()) prev.colors.add((p.color || '').trim());
        // keep first non-null metadata
        if (!prev.style_name && p.style_name) prev.style_name = p.style_name;
        if (!prev.image_url && p.image_url) prev.image_url = p.image_url;
        if (!prev.type && p.type) prev.type = p.type;
        if (!prev.quality && p.quality) prev.quality = p.quality;
      }
    }
    const upsertList = Array.from(byStyle.values()).map((v) => ({
      season_id: v.season_id,
      style_no: v.style_no,
      style_name: v.style_name,
      image_url: v.image_url,
      type: v.type,
      quality: v.quality,
      qty: v.qty,
      sales_amount: v.sales_amount,
      sort_index: v.sort_index,
      colors: Array.from(v.colors)
    }));
    await log(job.id, 'info', 'STEP:topstyles_aggregate', { uniqueStyles: upsertList.length });
    if (upsertList.length) {
      const { error } = await supabase
        .from('top_styles')
        .upsert(upsertList as any, { onConflict: 'season_id,style_no' as any });
      await log(job.id, error ? 'error' : 'info', 'STEP:topstyles_upsert_result', { upserted: upsertList.length, error: error ? String(error.message || error) : null });
      if (error) throw error;
    }
    await log(job.id, 'info', 'STEP:topstyles_saved', { season_id: currentSeasonId, count: parsed.length });
    await saveResult(job.id, 'top_styles_saved', { season_id: currentSeasonId, count: parsed.length });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


