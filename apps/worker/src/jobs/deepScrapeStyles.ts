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
  const { data: styles } = await supabase.from('styles').select('style_no, link_href');
  if (!styles || styles.length === 0) {
    await saveResult(job.id, 'Deep styles: no styles', { count: 0 });
    await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
    return;
  }
  let updated = 0;
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
          sel.value = targetSeasonId;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (sel.value === targetSeasonId) ok = true;
        }
        return ok;
      }, seasonId);
      if (!applied) {
        await log(job.id, 'error', 'STEP:season_set_failed', { style_no: s.style_no, seasonId });
        throw new Error('Failed to set season on page');
      }
      // Allow any dependent network to settle after selection change
      try { await page.waitForLoadState?.('networkidle', { timeout: 10_000 } as any); } catch {}
      // Verify again
      const verified = await page.evaluate((targetSeasonId) => {
        const sels = Array.from(document.querySelectorAll('select.season_id')) as HTMLSelectElement[];
        return sels.some((sel) => sel.value === targetSeasonId);
      }, seasonId);
      if (!verified) {
        await log(job.id, 'error', 'STEP:season_verify_failed', { style_no: s.style_no, seasonId });
        throw new Error('Season verify failed');
      }
      await log(job.id, 'info', 'STEP:season_set_ok', { style_no: s.style_no, seasonId });
    } catch (e: any) {
      throw new Error(`Season selection failed for ${s.style_no}: ${e?.message || String(e)}`);
    }
    try {
      await page.waitForSelector('.colorDeliveryBox', { timeout: 30_000 });
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:deep_styles_no_color_box', { style_no: s.style_no, error: e?.message || String(e) });
      continue;
    }
    const seasons = await page.$$eval('.colorDeliveryBox select.season_id', (sels) => {
      const out: string[] = [];
      for (const sel of Array.from(sels) as HTMLSelectElement[]) {
        const val = sel.value || (sel.selectedOptions?.[0]?.value || '').trim();
        if (val && !out.includes(val)) out.push(val);
      }
      return out;
    });
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
  await saveResult(job.id, 'Deep styles completed', { updated });
  await log(job.id, 'info', 'STEP:complete', { updated });
}


