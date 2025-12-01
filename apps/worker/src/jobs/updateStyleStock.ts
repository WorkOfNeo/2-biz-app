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

export async function updateStyleStock(ctx: Ctx) {
  const { job, page, log, saveResult, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  // Tunable timeouts to avoid long stalls on pages that do not render details
  const SELECTOR_TIMEOUT_MS = 20_000;      // previously 120_000
  const FORCED_SELECTOR_TIMEOUT_MS = 5_000;
  const BETWEEN_CLICK_WAIT_MS = 350;       // previously 500
  // Navigation tuning
  try {
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);
    // Block heavy assets not needed for parsing
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
  } catch {}
  async function gotoWithRetry(url: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        return true;
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:navigate_retry', { url, attempt, error: e?.message || String(e) });
        await page.waitForTimeout(500);
      }
    }
    return false;
  }
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:style_stock_begin');
  let styleNos: string[] = Array.isArray(job.payload?.styleNos) ? (job.payload?.styleNos as string[]) : [];
  if (styleNos.length === 0) {
    try {
      // Prefer per-user selection union
      const { data: sel } = await supabase.from('app_settings').select('value').eq('key', 'styles_user_selection').maybeSingle();
      const map = ((sel?.value as any) || {}) as Record<string, string[]>;
      const set = new Set<string>();
      for (const arr of Object.values(map)) for (const no of (arr || [])) if (no && typeof no === 'string') set.add(no);
      styleNos = Array.from(set);
      if (styleNos.length === 0) {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
        styleNos = ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
      }
    } catch {}
  }
  if (styleNos.length === 0) {
    await log(job.id, 'info', 'STEP:style_stock_no_selection');
    await saveResult(job.id, 'Style stock: no styles selected', { count: 0 });
    await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
    return;
  }
  const { data: styles } = await supabase.from('styles').select('id, style_no, link_href, scrape_enabled').in('style_no', styleNos);
  let totalRows = 0;
  const missingStyles: Array<{ style_no: string; reason: string }> = [];
  for (const s of (styles ?? []) as any[]) {
    await ensureNotCancelled(job.id);
    const href = (s.link_href || '').toString();
    if (!href) continue;
    const styleId: string | null = (s.id as string | undefined) || null;
    const styleScrapeEnabled: boolean = (s as any)?.scrape_enabled !== false;
    if (!styleScrapeEnabled) { await log(job.id, 'info', 'STEP:style_stock_skip_style_disabled', { style_no: s.style_no }); continue; }
    let allowedColors: Record<string, boolean> = {};
    if (styleId) {
      try {
        const { data: colorRows } = await supabase.from('style_colors').select('color, scrape_enabled').eq('style_id', styleId);
        for (const c of (colorRows ?? []) as any[]) { const key = String(c.color || '').trim().toLowerCase(); if (key) allowedColors[key] = c.scrape_enabled !== false; }
      } catch {}
    }
    const knownColorKeys = Object.keys(allowedColors);
    if (knownColorKeys.length > 0 && knownColorKeys.every((k) => allowedColors[k] === false)) {
      await log(job.id, 'info', 'STEP:style_stock_skip_all_colors_disabled', { style_no: s.style_no });
      continue;
    }
    const url = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '') + '#tab=statandstock';
    await log(job.id, 'info', 'STEP:style_stock_nav', { style_no: s.style_no, url });
    const ok = await gotoWithRetry(url);
    if (!ok) {
      await log(job.id, 'error', 'STEP:style_stock_nav_timeout', { style_no: s.style_no, url });
      missingStyles.push({ style_no: s.style_no, reason: 'nav_timeout' });
      continue;
    }
    try {
      const clickedTab = await page.evaluate(() => {
        const a = document.querySelector('a[href$="#tab=statandstock"], a[href*="#tab=statandstock"]') as HTMLAnchorElement | null;
        if (a) { a.click(); return true; }
        return false;
      });
      if (clickedTab) { await log(job.id, 'info', 'STEP:style_stock_tab_clicked'); await page.waitForTimeout(500); }
    } catch {}
    try {
      await page.waitForFunction(() => !!document.querySelector('.statAndStockBox, .sprite.sprite168.spriteArrowDown.right.clickable, .sprite.sprite168.spriteArrowUp.right.clickable'), {}, { timeout: 30_000 }).catch(() => {});
      try {
        const counts = await page.evaluate(() => ({
          boxes: document.querySelectorAll('.statAndStockBox').length,
          arrowsDown: document.querySelectorAll('.sprite.sprite168.spriteArrowDown.right.clickable').length,
          arrowsUp: document.querySelectorAll('.sprite.sprite168.spriteArrowUp.right.clickable').length
        }));
        await log(job.id, 'info', 'STEP:style_stock_pre_counts', counts as any);
        // If nothing seems visible, try a fast reload-and-tab-click once
        if ((counts as any)?.boxes === 0 && (counts as any)?.arrowsDown === 0 && (counts as any)?.arrowsUp === 0) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          try {
            const clickedAgain = await page.evaluate(() => {
              const a = document.querySelector('a[href$="#tab=statandstock"], a[href*="#tab=statandstock"]') as HTMLAnchorElement | null;
              if (a) { a.click(); return true; }
              return false;
            });
            if (clickedAgain) await page.waitForTimeout(250);
          } catch {}
        }
      } catch {}
      for (let i = 0; i < 6; i++) {
        const { clicked, remaining } = await page.evaluate((allowed: Record<string, boolean>) => {
          let clicks = 0;
          const headers = Array.from(document.querySelectorAll('.statAndStockBox tr.tableBackgroundBlack')) as HTMLTableRowElement[];
          function getColorName(tr: HTMLTableRowElement): string {
            const td = tr.querySelector('td');
            const raw = (td?.textContent || '').replace(/\s+/g, ' ').trim();
            return raw;
          }
          for (const tr of headers) {
            const colorName = getColorName(tr);
            const lower = colorName.toLowerCase();
            const hasInactive = /\(inactive\)/i.test(colorName);
            const styleAttr = (tr.getAttribute('style') || '').toLowerCase();
            const hasRedBg = /#900/.test(styleAttr) || /background[-\s]*color\s*:\s*#900/.test(styleAttr);
            const allowedByDb = Object.keys(allowed || {}).length ? (allowed[lower] !== false) : true;
            if (hasInactive || hasRedBg || !allowedByDb) continue;
            const arrow = tr.querySelector('.sprite.sprite168.spriteArrowDown.right.clickable') as HTMLElement | null;
            if (arrow) { arrow.click(); clicks++; }
          }
          const remaining = document.querySelectorAll('.sprite.sprite168.spriteArrowDown.right.clickable').length;
          return { clicked: clicks, remaining };
        }, allowedColors);
        await log(job.id, 'info', 'STEP:style_stock_expand_click', { iteration: i + 1, clicked, remaining });
        if (!clicked || remaining === 0) break;
        await page.waitForTimeout(BETWEEN_CLICK_WAIT_MS);
      }
      const headerClicks = await page.evaluate((allowed: Record<string, boolean>) => {
        let clicked = 0;
        const headers = Array.from(document.querySelectorAll('.statAndStockBox tr.tableBackgroundBlack')) as HTMLTableRowElement[];
        for (const tr of headers) {
          const td = tr.querySelector('td');
          const colorName = (td?.textContent || '').replace(/\s+/g, ' ').trim();
          const lower = colorName.toLowerCase();
          const hasInactive = /\(inactive\)/i.test(colorName);
          const styleAttr = (tr.getAttribute('style') || '').toLowerCase();
          const hasRedBg = /#900/.test(styleAttr) || /background[-\s]*color\s*:\s*#900/.test(styleAttr);
          const allowedByDb = Object.keys(allowed || {}).length ? (allowed[lower] !== false) : true;
          if (hasInactive || hasRedBg || !allowedByDb) continue;
          const arrow = tr.querySelector('.sprite.sprite168.spriteArrowDown.right.clickable') as HTMLElement | null;
          if (arrow) { arrow.click(); clicked++; }
        }
        return clicked;
      }, allowedColors).catch(() => 0);
      if (headerClicks) await log(job.id, 'info', 'STEP:style_stock_header_clicks', { clicked: headerClicks });
      await page.waitForTimeout(BETWEEN_CLICK_WAIT_MS);
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:style_stock_expand_error', { error: e?.message || String(e) });
    }
    try {
      await page.waitForSelector('.statAndStockDetails', { timeout: SELECTOR_TIMEOUT_MS, state: 'attached' as any });
    } catch (e: any) {
      try {
        const forced = await page.evaluate(() => {
          let shown = 0;
          (document.querySelectorAll('.statAndStockBox table[style*="display: none"]') as any).forEach((t: HTMLElement) => { (t as HTMLElement).style.display = 'table'; shown++; });
          return shown;
        });
        await log(job.id, 'info', 'STEP:style_stock_force_show', { tablesShown: forced });
        await page.waitForTimeout(250);
        await page.waitForSelector('.statAndStockDetails', { timeout: FORCED_SELECTOR_TIMEOUT_MS, state: 'attached' as any });
      } catch {}
      const html = await page.content();
      await log(job.id, 'error', 'STEP:style_stock_missing_skip', { style_no: s.style_no, error: e?.message || String(e), html_sample: String(html || '').slice(0, 5_000) });
      missingStyles.push({ style_no: s.style_no, reason: 'details_missing' });
      continue;
    }
    const extracted = await page.$$eval('.statAndStockBox', (boxes, allowed: Record<string, boolean>) => {
      function text(el: Element | null | undefined): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
      function numbersFromRow(tds: HTMLElement[]): number[] {
        const arr: number[] = [];
        for (let i = 1; i < tds.length - 1; i++) {
          const raw = (tds[i]?.textContent || '').replace(/\s+/g, ' ').trim();
          const n = Number(raw.replace(/[^0-9\-]/g, '')) || 0;
          arr.push(n);
        }
        return arr;
      }
      const out: Array<{ color: string; sizes: string[]; section: string; row_label: string; values: number[]; po_link: string | null }> = [];
      for (const box of Array.from(boxes) as HTMLElement[]) {
        const details = box.querySelector('.statAndStockDetails') as HTMLElement | null;
        if (!details) continue;
        const firstTable = details.querySelector('table') as HTMLTableElement | null;
        if (!firstTable) continue;
        const rows = Array.from(firstTable.querySelectorAll('tr')) as HTMLTableRowElement[];
        if (rows.length === 0) continue;
        const first = rows[0] as HTMLTableRowElement | undefined;
        if (!first) continue;
        const headerTds = Array.from(first.querySelectorAll('td')) as HTMLElement[];
        const color = text(headerTds[0]);
        const colorLower = color.toLowerCase();
        const headerRowOutside = box.querySelector('tr.tableBackgroundBlack') as HTMLTableRowElement | null;
        const styleAttr = (headerRowOutside?.getAttribute('style') || '').toLowerCase();
        const hasRedBg = /#900/.test(styleAttr) || /background[-\s]*color\s*:\s*#900/.test(styleAttr);
        const hasInactive = /\(inactive\)/i.test(color);
        const allowedByDb = Object.keys(allowed || {}).length ? (allowed[colorLower] !== false) : true;
        if (hasInactive || hasRedBg || !allowedByDb) continue;
        const sizeLabels: string[] = [];
        for (let i = 1; i < headerTds.length - 1; i++) sizeLabels.push(text(headerTds[i]));
        let inSold = false; let inPurchase = false; let inDedicated = false;
        let lastPurchaseHeading: { label: string; link: string | null } | null = null;
        const seenPurchase = new Set<string>();
        for (let r = 1; r < rows.length; r++) {
          const rowEl = rows[r] as HTMLTableRowElement;
          const tds = Array.from(rowEl.querySelectorAll('td')) as HTMLElement[];
          const label = text(tds[0]);
          const cls = rowEl.className || '';
          if (/Sold/.test(label) && /header/.test(cls)) { inSold = true; inPurchase = false; inDedicated = false; continue; }
          if (/Available/.test(label) && /header/.test(cls)) { inSold = false; inDedicated = false; continue; }
          if (/Purchase/.test(label) && /header/.test(cls)) { inPurchase = true; inSold = false; inDedicated = false; continue; }
          if (/Net Need/.test(label) && /header/.test(cls)) { inPurchase = false; inDedicated = false; break; }
          if (!inSold && !inPurchase && label === 'Stock') { out.push({ color, sizes: sizeLabels, section: 'Stock', row_label: 'Stock', values: (numbersFromRow(tds)), po_link: null }); continue; }
          if (rowEl.querySelector('a.edit-dedication')) { inDedicated = true; continue; }
          if (inDedicated && cls.includes('stylecolor-expanded--main') || inDedicated && cls.includes('stylecolor-expanded--sub')) {
            const kind = /Pre/i.test(label) ? 'Pre Dedicated' : 'Stock Dedicated';
            out.push({ color, sizes: sizeLabels, section: kind, row_label: label || kind, values: numbersFromRow(tds), po_link: null });
            continue;
          }
          if (inSold && cls.includes('stylecolor-expanded--sub')) {
            out.push({ color, sizes: sizeLabels, section: 'Sold', row_label: label || 'Row', values: numbersFromRow(tds), po_link: null });
            continue;
          }
          if (!inSold && !inPurchase && cls.includes('stylecolor-expanded--main')) {
            if (/^Available$/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'Available', row_label: 'Available', values: numbersFromRow(tds), po_link: null }); continue; }
            if (/PO Available/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'PO Available', row_label: 'PO Available', values: numbersFromRow(tds), po_link: null }); continue; }
            if (/^Corrected$/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'Corrected', row_label: 'Corrected', values: numbersFromRow(tds), po_link: null }); continue; }
          }
          if (inPurchase) {
            // Only keep detailed PO rows (sub rows). Skip headers and aggregated main rows.
            if (!cls.includes('stylecolor-expanded--sub')) { continue; }
            // Skip non-PO summary rows
            const isSumRow = /^NOOS$/i.test(label) || /^Total\s+PO/i.test(label);
            if (isSumRow) { continue; }
            // Skip dedicated summary lines within purchase block
            const isDedicatedLabel = /(Stock\s+Dedicated|Pre\s+Dedicated)/i.test(label);
            if (isDedicatedLabel) { continue; }
            // Capture PO link if present
            let po_link: string | null = null;
            const poA = rowEl.querySelector('a[href*="purchase_orders.php"]') as HTMLAnchorElement | null;
            if (poA) po_link = poA.getAttribute('href') || null;
            const key = (label || 'Row') + '|' + String(po_link || '');
            if (!(seenPurchase as any).has?.(key)) {
              (seenPurchase as any).add?.(key);
              out.push({ color, sizes: sizeLabels, section: 'Purchase (Running + Shipped)', row_label: label || 'Row', values: numbersFromRow(tds), po_link });
            }
            continue;
          }
        }
      }
      return out;
    }, allowedColors);
    const byColor = new Map<string, typeof extracted>();
    for (const row of extracted) {
      const arr = byColor.get(row.color) || [] as any;
      (arr as any).push(row);
      byColor.set(row.color, arr as any);
    }
    try {
      const trim = (arr: number[]) => (arr || []).slice(0, 20);
      for (const [colorName, rowsList] of byColor.entries()) {
        const sizes = (rowsList.find((r: any) => r.section === 'Stock') || rowsList[0])?.sizes || [];
        const stockVals = (rowsList.find((r: any) => r.section === 'Stock')?.values) || [];
        const soldRows = rowsList.filter((r: any) => r.section === 'Sold');
        const purchaseRows = rowsList.filter((r: any) => r.section === 'Purchase (Running + Shipped)');
        const stockDed = rowsList.filter((r: any) => r.section === 'Stock Dedicated');
        const preDed = rowsList.filter((r: any) => r.section === 'Pre Dedicated');
        const sum = (rows: any[]) => {
          const len = sizes.length; const zero = Array.from({ length: len }, () => 0);
          return rows.reduce((acc: number[], r: any) => acc.map((v: number, i: number) => v + Number((r.values?.[i] ?? 0) || 0)), zero);
        };
        await log(job.id, 'info', 'STEP:style_stock_parsed', {
          style_no: s.style_no,
          color: colorName,
          sizes,
          stock: trim(stockVals as any),
          sold: { count: soldRows.length, sum: trim(sum(soldRows)), sample: soldRows.slice(0, 2).map((r: any) => ({ label: r.row_label, values: trim(r.values) })) },
          purchase: { count: purchaseRows.length, sum: trim(sum(purchaseRows)), sample: purchaseRows.slice(0, 2).map((r: any) => ({ label: r.row_label, values: trim(r.values) })) },
          dedicated: { stockDedicated: { count: stockDed.length, sum: trim(sum(stockDed)) }, preDedicated: { count: preDed.length, sum: trim(sum(preDed)) } }
        });
      }
    } catch {}
    try {
      if (styleId) {
        const presentColors = Array.from(byColor.keys());
        const { data: existingColors } = await supabase.from('style_colors').select('id, color').eq('style_id', styleId);
        const existing = new Set((existingColors ?? []).map((r: any) => String(r.color || '').trim().toLowerCase()));
        const toInsert = presentColors.filter((c) => !existing.has(String(c || '').trim().toLowerCase())).map((c) => ({ style_id: styleId, color: c, sort_index: 0 }));
        if (toInsert.length) { await supabase.from('style_colors').insert(toInsert); }
      }
    } catch {}
    const scrapeTs = new Date().toISOString();
    const payload = extracted.map((row: any) => ({ 
      style_no: s.style_no, 
      color: row.color, 
      sizes: row.sizes, 
      section: row.section, 
      row_label: String(row.row_label || '').trim(),  // Normalize: trim whitespace, convert null to empty string
      values: row.values, 
      po_link: row.po_link, 
      scraped_at: scrapeTs 
    }));
    const dedupMap = new Map<string, any>();
    for (const r of payload) { 
      const key = `${r.style_no}|${r.color}|${r.section}|${r.row_label}`; 
      dedupMap.set(key, r); 
    }
    const deduped = Array.from(dedupMap.values());
    
    // Step 1: Get existing colors before deletion
    const { data: existingStockColors } = await supabase
      .from('style_stock')
      .select('color')
      .eq('style_no', s.style_no);
    
    const previousColors = new Set<string>(
      (existingStockColors ?? []).map((r: any) => String(r.color || '').trim())
    );
    
    // Step 2: Delete ALL old data for this style_no (SPY is single source of truth)
    if (previousColors.size > 0) {
      const { error: delErr } = await supabase
        .from('style_stock')
        .delete()
        .eq('style_no', s.style_no);
      
      if (delErr) throw delErr;
      await log(job.id, 'info', 'STEP:deleted_old_stock_data', { 
        style_no: s.style_no, 
        previous_colors: previousColors.size 
      });
    }
    
    // Step 3: Insert fresh scraped data
    if (deduped.length) {
      const { error: insErr } = await supabase.from('style_stock').insert(deduped);
      if (insErr) throw insErr;
      totalRows += deduped.length;
    }
    
    // Step 4: Track missing colors
    const scrapedColors = new Set<string>(
      deduped.map((r: any) => String(r.color || '').trim())
    );
    
    // Find colors that disappeared
    const missingColors = [...previousColors].filter(c => !scrapedColors.has(c));
    
    if (missingColors.length > 0) {
      await log(job.id, 'info', 'STEP:missing_colors_detected', {
        style_no: s.style_no,
        missing_colors: missingColors
      });
      
      // Increment consecutive_misses for missing colors
      for (const color of missingColors) {
        try {
          await supabase.rpc('increment_missing_color', {
            p_style_no: s.style_no,
            p_color: color
          });
        } catch (e) {
          // Log but don't fail the job
          await log(job.id, 'info', 'STEP:increment_missing_color_error', { 
            style_no: s.style_no, 
            color, 
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }
    
    // Reset counter for colors that are present/reappeared
    for (const color of scrapedColors) {
      try {
        await supabase
          .from('style_color_missing_tracker')
          .upsert({
            style_no: s.style_no,
            color: color,
            consecutive_misses: 0,
            last_seen_at: scrapeTs,
            last_checked_at: scrapeTs
          }, { onConflict: 'style_no,color' });
      } catch (e) {
        // Log but don't fail
        await log(job.id, 'info', 'STEP:reset_missing_tracker_error', { 
          style_no: s.style_no, 
          color, 
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    
    // Step 5: Delete colors with 3+ consecutive misses
    try {
      const { data: toDelete } = await supabase
        .from('style_color_missing_tracker')
        .select('style_no, color')
        .gte('consecutive_misses', 3);
      
      if (toDelete && toDelete.length > 0) {
        for (const item of toDelete) {
          // Delete from style_stock
          await supabase
            .from('style_stock')
            .delete()
            .eq('style_no', item.style_no)
            .eq('color', item.color);
          
          // Delete from tracker
          await supabase
            .from('style_color_missing_tracker')
            .delete()
            .eq('style_no', item.style_no)
            .eq('color', item.color);
          
          await log(job.id, 'info', 'STEP:deleted_missing_color', {
            style_no: item.style_no,
            color: item.color,
            reason: '3+ consecutive misses'
          });
        }
      }
    } catch (e) {
      // Log but don't fail
      await log(job.id, 'info', 'STEP:cleanup_missing_colors_error', { 
        error: e instanceof Error ? e.message : String(e) 
      });
    }
    
    await log(job.id, 'info', 'STEP:style_stock_rows', { style_no: s.style_no, rows: extracted.length });
  }
  await saveResult(job.id, 'Style stock scrape completed', { totalRows, missingStyles });
  await log(job.id, 'info', 'STEP:complete', { totalRows, missing: missingStyles.length });
}


