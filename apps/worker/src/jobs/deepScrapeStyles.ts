import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
  SPY_BASE_URL: string;
};

export async function deepScrapeStyles(ctx: Ctx) {
  const { job, page, log, saveResult, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:deep_styles_begin');
  // Enforce seasonId presence and apply per page before scraping
  const seasonId = (job.payload as any)?.seasonId as string | undefined;
  if (!seasonId) {
    await log(job.id, 'error', 'STEP:season_missing_abort');
    throw new Error('seasonId is required for deep_scrape_styles to prevent cross-season data pollution');
  }
  // Resolve SPY season id (numeric) for DOM selection
  let spySeasonId: number | null = null;
  try {
    const { data: seasonRow } = await supabase.from('seasons').select('spy_season_id').eq('id', seasonId).maybeSingle();
    const n = Number((seasonRow as any)?.spy_season_id || 0);
    spySeasonId = Number.isFinite(n) && n > 0 ? n : null;
  } catch {}
  if (!spySeasonId) {
    await log(job.id, 'error', 'STEP:season_spy_id_missing', { seasonId });
    throw new Error('Selected season has no spy_season_id mapping; run seasons scrape to map SPY IDs');
  }
  // Load styles including internal id to map colors
  const { data: styles } = await supabase.from('styles').select('id, style_no, link_href');
  if (!styles || styles.length === 0) {
    await saveResult(job.id, 'Deep styles: no styles', { count: 0 });
    await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
    return;
  }
  let updated = 0;
  let colorLinksInserted = 0;
  for (const s of styles as any[]) {
    await ensureNotCancelled(job.id);
    const href = (s.link_href || '').toString();
    if (!href) continue;
    const base = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '');
    const url = base + '#tab=materials';
    await log(job.id, 'info', 'STEP:deep_styles_nav', { style_no: s.style_no, url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Apply season selection; fail fast if cannot set
    try {
      const applied = await page.evaluate(async (targetSeasonId) => {
        const sels = Array.from(document.querySelectorAll('select.season_id')) as HTMLSelectElement[];
        if (sels.length === 0) return false;
        let ok = false;
        for (const sel of sels) {
          sel.value = String(targetSeasonId);
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (sel.value === String(targetSeasonId)) ok = true;
        }
        return ok;
      }, spySeasonId);
      if (!applied) {
        await log(job.id, 'error', 'STEP:season_set_failed', { style_no: s.style_no, seasonId, spySeasonId });
        throw new Error('Failed to set season on page');
      }
      // Allow any dependent network to settle after selection change
      try { await page.waitForLoadState?.('networkidle', { timeout: 10_000 } as any); } catch {}
      // Verify again
      const verified = await page.evaluate((targetSeasonId) => {
        const sels = Array.from(document.querySelectorAll('select.season_id')) as HTMLSelectElement[];
        return sels.some((sel) => sel.value === String(targetSeasonId));
      }, spySeasonId);
      if (!verified) {
        await log(job.id, 'error', 'STEP:season_verify_failed', { style_no: s.style_no, seasonId, spySeasonId });
        throw new Error('Season verify failed');
      }
      await log(job.id, 'info', 'STEP:season_set_ok', { style_no: s.style_no, seasonId, spySeasonId });
    } catch (e: any) {
      throw new Error(`Season selection failed for ${s.style_no}: ${e?.message || String(e)}`);
    }
    try {
      await page.waitForSelector('.colorDeliveryBox', { timeout: 30_000 });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:deep_styles_no_color_box', { style_no: s.style_no, error: e?.message || String(e) });
      continue;
    }
    // Read the season selects present in materials tab
    const seasons = await page.$$eval('.colorDeliveryBox select.season_id', (sels) => {
      const out: string[] = [];
      for (const sel of Array.from(sels) as HTMLSelectElement[]) {
        const val = sel.value || (sel.selectedOptions?.[0]?.value || '').trim();
        if (val && !out.includes(val)) out.push(val);
      }
      return out;
    });
    // For each materials box: read the SELECTed SPY season and the colors listed in the table for that box.
    const boxes: Array<{ spySeasonId: number; colors: string[] }> = await page.evaluate(() => {
      const list: Array<{ spySeasonId: number; colors: string[] }> = [];
      const boxes = Array.from(document.querySelectorAll('.colorDeliveryBox')) as HTMLElement[];
      for (const box of boxes) {
        const sel = box.querySelector('.materials-bar select.season_id') as HTMLSelectElement | null;
        const val = sel?.value || sel?.selectedOptions?.[0]?.value || '';
        const spySeasonId = Number(val || 0) || 0;
        const spans = Array.from(box.querySelectorAll('table.standardList tbody tr td:nth-child(4) span')) as HTMLSpanElement[];
        const colors = spans.map((el) => (el?.textContent || '').trim()).filter(Boolean);
        if (spySeasonId > 0 && colors.length) list.push({ spySeasonId, colors });
      }
      return list;
    });
    // Map SPY season ids from the page to our seasons.id
    if (boxes.length) {
      try {
        const spyIds = Array.from(new Set(boxes.map((b) => b.spySeasonId)));
        const { data: seasonRows } = await supabase.from('seasons').select('id, spy_season_id').in('spy_season_id', spyIds);
        const spyToApp = new Map<number, string>();
        for (const r of (seasonRows ?? []) as any[]) spyToApp.set(Number(r.spy_season_id), String(r.id));
        // Map UI color names to our style_colors ids
        const { data: styleColorRows } = await supabase.from('style_colors').select('id, color').eq('style_id', s.id as string).limit(1000);
        const colorMap = new Map<string, string>();
        for (const r of (styleColorRows ?? []) as any[]) colorMap.set(String(r.color || '').trim().toLowerCase(), String(r.id));
        // Upsert all links color->season for each box
        for (const box of boxes) {
          const appSeasonId = spyToApp.get(box.spySeasonId);
          if (!appSeasonId) continue;
          for (const cname of box.colors) {
            const cid = colorMap.get(cname.toLowerCase());
            if (!cid) continue;
            const { error: upErr } = await supabase.from('style_color_seasons').upsert(
              { style_color_id: cid, season_id: appSeasonId },
              { onConflict: 'style_color_id,season_id' as any }
            );
            if (!upErr) colorLinksInserted++;
          }
        }
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:deep_styles_color_link_failed', { style_no: s.style_no, error: e?.message || String(e) });
      }
    }
    const uniq = Array.from(new Set(seasons));
    const { data: exist } = await supabase.from('style_seasons').select('id, seasons').eq('style_no', s.style_no).maybeSingle();
    const merged = Array.from(new Set([...(exist?.seasons as any[] || []), ...uniq]));
    if (exist?.id) {
      await supabase.from('style_seasons').update({ seasons: merged, scraped_at: new Date().toISOString() }).eq('id', exist.id as string);
    } else {
      await supabase.from('style_seasons').insert({ style_no: s.style_no, seasons: merged, scraped_at: new Date().toISOString() });
    }
    updated++;
  }
  await saveResult(job.id, 'Deep styles completed', { updated, colorLinksInserted });
  await log(job.id, 'info', 'STEP:complete', { updated, colorLinksInserted });
}


