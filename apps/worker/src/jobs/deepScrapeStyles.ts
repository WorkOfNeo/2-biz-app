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


