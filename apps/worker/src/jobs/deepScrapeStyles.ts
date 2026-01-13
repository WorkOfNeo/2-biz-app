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
  // Load styles including internal id to map colors (skip those without links)
  const { data: styles } = await supabase
    .from('styles')
    .select('id, style_no, link_href')
    .not('link_href', 'is', null)
    .neq('link_href', '');
  if (!styles || styles.length === 0) {
    await saveResult(job.id, 'Deep styles: no styles', { count: 0 });
    await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
    return;
  }
  // Pre-fetch all seasons once (optimization: avoid repeated queries)
  const { data: allSeasons } = await supabase.from('seasons').select('id, spy_season_id');
  const globalSpyToApp = new Map<number, string>();
  for (const r of (allSeasons ?? []) as any[]) {
    globalSpyToApp.set(Number(r.spy_season_id), String(r.id));
  }
  await log(job.id, 'info', 'STEP:deep_styles_seasons_loaded', { count: globalSpyToApp.size });
  
  let updated = 0;
  let colorLinksInserted = 0;
  let imagesUpdated = 0;
  const total = (styles as any[])?.length || 0;
  let idx = 0;
  for (const s of styles as any[]) {
    idx++;
    // Log progress every 10 styles (optimization: reduce log writes)
    if (idx % 10 === 0 || idx === total) {
      try { 
        await log(job.id, 'info', 'STEP:deep_styles_progress', { 
          index: idx, 
          total, 
          percent: Math.round((idx / total) * 100),
          updated,
          colorLinksInserted,
          imagesUpdated
        }); 
      } catch {}
    }
    await ensureNotCancelled(job.id);
    const href = (s.link_href || '').toString();
    if (!href) continue;
    const base = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '');
    const url = base + '#tab=materials';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // We do NOT change the season selects – we read what is already on the page across all boxes
    try {
      await page.waitForSelector('.colorDeliveryBox', { timeout: 5_000 });
    } catch (e: any) {
      // Style may not have materials tab - skip quickly (5s timeout)
      await log(job.id, 'error', 'STEP:deep_styles_no_color_box', { style_no: s.style_no });
      continue;
    }
    // Read the season selects present in materials tab (unique spy season ids)
    const seasons = await page.$$eval('.colorDeliveryBox select.season_id', (sels) => {
      const out: string[] = [];
      for (const sel of Array.from(sels) as HTMLSelectElement[]) {
        const val = sel.value || (sel.selectedOptions?.[0]?.value || '').trim();
        if (val && !out.includes(val)) out.push(val);
      }
      return out;
    });
    // For each materials box: read the SPY season, colors, and images from each row
    const boxes: Array<{ 
      spySeasonId: number; 
      colorRows: Array<{ color: string; imageUrl: string | null }> 
    }> = await page.evaluate(() => {
      const list: Array<{ spySeasonId: number; colorRows: Array<{ color: string; imageUrl: string | null }> }> = [];
      const boxes = Array.from(document.querySelectorAll('.colorDeliveryBox')) as HTMLElement[];
      for (const box of boxes) {
        const sel = box.querySelector('.materials-bar select.season_id') as HTMLSelectElement | null;
        const val = sel?.value || sel?.selectedOptions?.[0]?.value || '';
        const spySeasonId = Number(val || 0) || 0;
        if (spySeasonId <= 0) continue;
        
        const colorRows: Array<{ color: string; imageUrl: string | null }> = [];
        const rows = Array.from(box.querySelectorAll('table.standardList tbody tr')) as HTMLTableRowElement[];
        for (const row of rows) {
          // Get color name from 4th td span
          const colorSpan = row.querySelector('td:nth-child(4) span') as HTMLSpanElement | null;
          const color = (colorSpan?.textContent || '').trim();
          if (!color) continue;
          
          // Get image URL from first td img, replace s24 with s1024 for full size
          const img = row.querySelector('td:first-child img.color-image') as HTMLImageElement | null;
          let imageUrl: string | null = img?.src || null;
          if (imageUrl) {
            // Replace thumbnail size with full size
            imageUrl = imageUrl.replace(/tr:n-s\d+/i, 'tr:n-s1024');
          }
          
          colorRows.push({ color, imageUrl });
        }
        
        if (colorRows.length) list.push({ spySeasonId, colorRows });
      }
      return list;
    });
    // Map SPY season ids from the page to our seasons.id
    if (boxes.length) {
      try {
        // Use pre-fetched seasons map (optimization: no repeated queries)
        // Map UI color names to our style_colors ids and current image_url
        const { data: styleColorRows } = await supabase
          .from('style_colors')
          .select('id, color, image_url')
          .eq('style_id', s.id as string)
          .limit(1000);
        const colorMap = new Map<string, { id: string; image_url: string | null }>();
        for (const r of (styleColorRows ?? []) as any[]) {
          colorMap.set(String(r.color || '').trim().toLowerCase(), { 
            id: String(r.id), 
            image_url: r.image_url || null 
          });
        }
        
        // Collect color images (take first non-null image per color)
        const colorImages = new Map<string, string>(); // color lowercase -> imageUrl
        for (const box of boxes) {
          for (const row of box.colorRows) {
            const key = row.color.toLowerCase();
            if (row.imageUrl && !colorImages.has(key)) {
              colorImages.set(key, row.imageUrl);
            }
          }
        }
        
        // Update style_colors.image_url if changed
        for (const [colorKey, newImageUrl] of colorImages) {
          const colorInfo = colorMap.get(colorKey);
          if (colorInfo && newImageUrl !== colorInfo.image_url) {
            const { error: imgErr } = await supabase
              .from('style_colors')
              .update({ image_url: newImageUrl })
              .eq('id', colorInfo.id);
            if (!imgErr) imagesUpdated++;
          }
        }
        
        // Build desired target pairs for style_color_seasons: {style_color_id|season_id}
        const targetPairs = new Set<string>();
        for (const box of boxes) {
          const appSeasonId = globalSpyToApp.get(box.spySeasonId);
          if (!appSeasonId) continue;
          for (const row of box.colorRows) {
            const colorInfo = colorMap.get(row.color.toLowerCase());
            if (!colorInfo) continue;
            targetPairs.add(`${colorInfo.id}|${appSeasonId}`);
          }
        }
        
        // Fetch existing pairs for this style
        const styleColorIds = Array.from(colorMap.values()).map(c => c.id);
        let existing: Array<{ style_color_id: string; season_id: string }> = [];
        if (styleColorIds.length) {
          const { data: existRows } = await supabase
            .from('style_color_seasons')
            .select('style_color_id, season_id')
            .in('style_color_id', styleColorIds);
          existing = (existRows ?? []) as any[];
        }
        const existingSet = new Set(existing.map((r) => `${r.style_color_id}|${r.season_id}`));
        
        // Inserts (in target but not existing) - batch insert for performance
        const toInsert = Array.from(targetPairs)
          .filter(pair => !existingSet.has(pair))
          .map(pair => {
            const [cid, sid] = pair.split('|');
            return { style_color_id: cid, season_id: sid };
          });
        
        if (toInsert.length > 0) {
          const { error: upErr } = await supabase.from('style_color_seasons').insert(toInsert as any);
          if (!upErr) {
            colorLinksInserted += toInsert.length;
          }
        }
        
        // Deletions (in existing but not target): remove seasons that are not shown in any materials box
        for (const pair of Array.from(existingSet)) {
          if (!targetPairs.has(pair)) {
            const [cid, sid] = pair.split('|');
            await supabase.from('style_color_seasons').delete().eq('style_color_id', cid).eq('season_id', sid);
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
  await saveResult(job.id, 'Deep styles completed', { updated, colorLinksInserted, imagesUpdated });
  await log(job.id, 'info', 'STEP:complete', { updated, colorLinksInserted, imagesUpdated });
}


