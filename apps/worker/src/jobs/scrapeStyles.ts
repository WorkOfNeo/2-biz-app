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

// Fast scan job - scrapes table only, no detail page visits
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
      await page.waitForTimeout(1000); // Reduced from 1200ms
    } else {
      await log(job.id, 'info', 'STEP:styles_show_all_not_found');
    }
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:styles_show_all_error', { error: e?.message || String(e) });
  }
  await page.waitForSelector('table.standardList tbody tr', { timeout: 60_000, state: 'attached' as any });
  try {
    let last = 0;
    let scrollIterations = 0;
    for (let i = 0; i < 20; i++) {
      await ensureNotCancelled(job.id);
      const count = await page.$$eval('table.standardList tbody tr', (trs) => trs.length);
      if (i % 5 === 0 || count >= 100) {
        await log(job.id, 'info', 'STEP:styles_rows_count', { iteration: i + 1, count });
      }
      if (count >= 100) break;
      if (count > last) {
        last = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(600); // Reduced from 800ms
        scrollIterations++;
      } else {
        break;
      }
    }
    await log(job.id, 'info', 'STEP:styles_scroll_complete', { finalCount: last, scrollIterations });
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
  const total = rows.length;
  await log(job.id, 'info', 'STEP:styles_rows_scraped', { count: total });
  
  // Upsert scraped styles (without style_type - that's done by enrich_styles job)
  let upserted = 0;
  const logInterval = Math.max(50, Math.floor(total / 20)); // Log every 50 items or ~20 times total
  for (let i = 0; i < rows.length; i += 1000) {
    await ensureNotCancelled(job.id);
    const batch = rows.slice(i, i + 1000);
    const { error } = await supabase.from('styles').upsert(batch.map(r => ({
      spy_id: r.spy_id,
      style_no: r.style_no,
      style_name: r.style_name,
      supplier: r.supplier,
      image_url: r.image_url,
      link_href: r.link_href,
      missing_from_spy: false, // Clear flag for found styles
      updated_at: new Date().toISOString()
    })), { onConflict: 'style_no' });
    if (error) throw error;
    upserted += batch.length;
    if (upserted % logInterval === 0 || upserted === total) {
      await log(job.id, 'info', 'STEP:styles_progress', {
        index: upserted,
        total,
        percent: Math.round((upserted / total) * 100),
        upserted
      });
    }
  }
  
  // Detect missing styles (in DB but not in SPY)
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:styles_checking_missing');
  const scrapedStyleNos = new Set(rows.map(r => r.style_no));
  const { data: existingStyles } = await supabase.from('styles').select('style_no');
  const existingStyleNos = new Set<string>((existingStyles || []).map((s: any) => String(s.style_no || '')));
  const missingStyleNos = Array.from<string>(existingStyleNos).filter((no: string) => !scrapedStyleNos.has(no));
  
  if (missingStyleNos.length > 0) {
    await supabase.from('styles').update({ missing_from_spy: true }).in('style_no', missingStyleNos);
    await log(job.id, 'info', 'STEP:styles_missing_flagged', { count: missingStyleNos.length });
  }
  
  await saveResult(job.id, 'Styles scrape completed', { upserted, missing: missingStyleNos.length });
  await log(job.id, 'info', 'STEP:complete', { upserted, missing: missingStyleNos.length });
}

// Enrichment job - visits detail pages to populate style_type
export async function enrichStyles(ctx: Ctx) {
  const { job, page, log, saveResult, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:enrich_styles_begin');
  
  // Fetch styles that need enrichment (style_type IS NULL OR cost_price IS NULL OR needs_enrichment = true)
  const { data: stylesToEnrich } = await supabase
    .from('styles')
    .select('id, style_no, link_href, style_type, cost_price, needs_enrichment')
    .or('style_type.is.null,cost_price.is.null,needs_enrichment.eq.true')
    .not('link_href', 'is', null)
    .neq('link_href', '');
  
  if (!stylesToEnrich || stylesToEnrich.length === 0) {
    await saveResult(job.id, 'Enrich styles: no styles to enrich', { count: 0 });
    await log(job.id, 'info', 'STEP:complete', { enriched: 0 });
    return;
  }
  
  const total = stylesToEnrich.length;
  let enriched = 0;
  let failed = 0;
  let idx = 0;
  
  for (const style of stylesToEnrich as any[]) {
    idx++;
    await ensureNotCancelled(job.id);
    
    // Log progress every 10 styles
    if (idx % 10 === 0 || idx === total) {
      try {
        await log(job.id, 'info', 'STEP:enrich_styles_progress', {
          index: idx,
          total,
          percent: Math.round((idx / total) * 100),
          enriched,
          failed
        });
      } catch {}
    }
    
    if (!style.link_href) {
      failed++;
      continue;
    }
    
    try {
      const detailUrl = new URL(style.link_href, SPY_BASE_URL).toString();
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Extract style_type
      const typeText = await page.$eval('select[name="sTypeId"]', (sel: HTMLSelectElement) => {
        const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
        return (opt?.textContent || '').trim();
      }).catch(() => null as string | null);
      
      // Extract cost_price and cost_price_currency from #calculation table
      const costData = await page.evaluate(() => {
        const calcTable = document.querySelector('#calculation');
        if (!calcTable) return { costPrice: null, costCurrency: null };
        
        const tbody = calcTable.querySelector('tbody');
        if (!tbody) return { costPrice: null, costCurrency: null };
        
        const firstRow = tbody.querySelector('tr');
        if (!firstRow) return { costPrice: null, costCurrency: null };
        
        // Get cost price from input[name="sOfferprice"]
        const priceInput = firstRow.querySelector('input[name="sOfferprice"]') as HTMLInputElement | null;
        const priceValue = priceInput?.value || null;
        
        // Get currency from select[name="cp_exchange_id"]
        const currencySelect = firstRow.querySelector('select[name="cp_exchange_id"]') as HTMLSelectElement | null;
        let currencyValue: string | null = null;
        if (currencySelect && currencySelect.selectedIndex >= 0) {
          const selectedOption = currencySelect.options[currencySelect.selectedIndex];
          currencyValue = selectedOption?.textContent?.trim() || null;
        }
        
        return { costPrice: priceValue, costCurrency: currencyValue };
      }).catch(() => ({ costPrice: null, costCurrency: null }));
      
      // Extract customs_tariff_no from select[name="sCustomsTariffNo"]
      const customsTariff = await page.$eval('select[name="sCustomsTariffNo"]', (sel: HTMLSelectElement) => {
        if (sel && sel.selectedIndex >= 0) {
          const opt = sel.options[sel.selectedIndex];
          const text = (opt?.textContent || '').trim();
          // Skip "-- Select --" option
          if (text && text !== '-- Select --') {
            return text;
          }
        }
        return null;
      }).catch(() => null as string | null);
      
      // Extract country_of_origin from select[name="origin_country_id"]
      const countryOfOrigin = await page.$eval('select[name="origin_country_id"]', (sel: HTMLSelectElement) => {
        if (sel && sel.selectedIndex >= 0) {
          const opt = sel.options[sel.selectedIndex];
          const text = (opt?.textContent || '').trim();
          // Skip "-- Select --" option
          if (text && text !== '-- Select --') {
            return text;
          }
        }
        return null;
      }).catch(() => null as string | null);
      
      // Parse cost price (remove commas, convert to number)
      let costPriceNum: number | null = null;
      if (costData.costPrice) {
        const cleaned = costData.costPrice.replace(/[^0-9.,-]/g, '').replace(',', '.');
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          costPriceNum = parsed;
        }
      }
      
      // Update style with style_type, cost_price, cost_price_currency, customs_tariff_no, country_of_origin and clear needs_enrichment flag
      const { error } = await supabase
        .from('styles')
        .update({
          style_type: typeText || null,
          cost_price: costPriceNum,
          cost_price_currency: costData.costCurrency || null,
          customs_tariff_no: customsTariff,
          country_of_origin: countryOfOrigin,
          needs_enrichment: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', style.id);
      
      if (error) {
        await log(job.id, 'error', 'STEP:enrich_styles_update_error', { style_no: style.style_no, error: error.message });
        failed++;
      } else {
        enriched++;
      }
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:enrich_styles_detail_error', { style_no: style.style_no, error: e?.message || String(e) });
      failed++;
    }
  }
  
  await saveResult(job.id, 'Enrich styles completed', { enriched, failed, total });
  await log(job.id, 'info', 'STEP:complete', { enriched, failed, total });
}


