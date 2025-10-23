import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { JobRow, JobResult } from '@shared/types';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS!;
const SPY_BASE_URL = process.env.SPY_BASE_URL!;
const SPY_USERNAME = process.env.SPY_USERNAME!;
const SPY_PASSWORD = process.env.SPY_PASSWORD!;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Copenhagen';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BROWSERLESS_WS || !SPY_BASE_URL || !SPY_USERNAME || !SPY_PASSWORD) {
  // eslint-disable-next-line no-console
  console.error('Missing required environment variables for worker.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

type Nullable<T> = T | null;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) {
  // Mirror to console for Railway logs
  try {
    // eslint-disable-next-line no-console
    console.log(`[job ${jobId}] [${level}] ${msg}`, data ?? '');
  } catch {}
  await supabase.from('job_logs').insert({ job_id: jobId, level, msg, data: data ?? null });
}

async function leaseNextJob(): Promise<Nullable<JobRow>> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 60_000);
  const { data, error } = await supabase.rpc('lease_next_job', {
    p_now: now.toISOString(),
    p_lease_until: leaseUntil.toISOString()
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('lease_next_job error', error);
    return null;
  }
  const row = (data as any) ?? null;
  // Treat null-id (nullable record) as no job available
  if (!row || !row.id) return null;
  return row as JobRow;
}

async function updateJobHeartbeat(jobId: string) {
  const newLease = new Date(Date.now() + 60_000).toISOString();
  await supabase.from('jobs').update({ lease_until: newLease }).eq('id', jobId);
}

async function setJobSucceeded(jobId: string) {
  await supabase
    .from('jobs')
    .update({ status: 'succeeded', finished_at: new Date().toISOString(), lease_until: null })
    .eq('id', jobId);
}

async function setJobFailedOrRequeue(job: JobRow, errorMsg: string) {
  const nextStatus = job.attempts < job.max_attempts ? 'queued' : 'failed';
  await supabase
    .from('jobs')
    .update({
      status: nextStatus,
      error: nextStatus === 'failed' ? errorMsg : null,
      finished_at: nextStatus === 'failed' ? new Date().toISOString() : null,
      lease_until: null
    })
    .eq('id', job.id);
}

async function saveResult(jobId: string, summary: string, data: Record<string, any>) {
  const { data: inserted, error } = await supabase
    .from('job_results')
    .insert({ job_id: jobId, summary, data })
    .select('*')
    .single();
  if (error) throw error;
  return inserted as JobResult;
}

class CancelledError extends Error {
  constructor(message = 'JOB_CANCELLED') { super(message); this.name = 'CancelledError'; }
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
    return (data?.status as string | undefined) === 'cancelled';
  } catch {
    return false;
  }
}

async function ensureNotCancelled(jobId: string) {
  if (await isJobCancelled(jobId)) throw new CancelledError();
}

async function setJobCancelled(jobId: string, reason: string) {
  await supabase
    .from('jobs')
    .update({ status: 'cancelled', error: reason, finished_at: new Date().toISOString(), lease_until: null })
    .eq('id', jobId);
  try { await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Job cancelled', data: { reason } }); } catch {}
}

async function captureHtmlSnippet(target: any, fallbackPage: Page): Promise<string> {
  try {
    const html: string | undefined = await (target?.content?.() ?? fallbackPage.content?.());
    const trimmed = (html ?? '').replace(/\s+/g, ' ').trim();
    return trimmed.slice(0, 10000); // cap to avoid oversized logs
  } catch {
    return '[unavailable]';
  }
}

async function findFirst(page: Page, selectors: string[]): Promise<Nullable<import('playwright-core').Locator>> {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    if (await loc.first().count().catch(() => 0)) {
      return loc.first();
    }
  }
  return null;
}

async function maybeGetLoginFrame(page: Page): Promise<Page> {
  // If the login form is in an iframe, try to detect it
  for (const frame of page.frames()) {
    try {
      const hasUser = await frame.locator('input#username, input[name="username"], input[type="text"]').first().count();
      const hasPass = await frame.locator('input#password, input[name="password"], input[type="password"]').first().count();
      if (hasUser && hasPass) return frame as unknown as Page;
    } catch {}
  }
  return page;
}

async function runJob(job: JobRow) {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await log(job.id, 'info', 'Connecting to Browserless');
    browser = await chromium.connectOverCDP(BROWSERLESS_WS);
    context = await browser.newContext({ timezoneId: TIMEZONE, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    // Block heavy resources except on explicit pages where needed
    try {
      await context.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        // Allow images only for styles index and when explicitly needed; block fonts/css/media/analytics
        const blockTypes = new Set(['font','media']);
        const isStylesIndex = /Style%5CIndex/.test(url) || /controller=Style%5CIndex/.test(url);
        if (blockTypes.has(type)) return route.abort();
        if (type === 'image' && !isStylesIndex) return route.abort();
        if (/googletagmanager|google-analytics|hotjar|facebook|doubleclick/i.test(url)) return route.abort();
        return route.continue();
      });
    } catch {}

    await page.goto(SPY_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'Loaded login page');

    const framePage = await maybeGetLoginFrame(page);
    // Drop verbose HTML logging to reduce noise

    const userInputLoc = await findFirst(framePage, ['input#username', 'input[name="username"]', 'input[type="text"]']);
    const passInputLoc = await findFirst(framePage, ['input#password', 'input[name="password"]', 'input[type="password"]']);
    if (!userInputLoc || !passInputLoc) throw new Error('Login inputs not found');

    await userInputLoc.fill(SPY_USERNAME, { timeout: 30_000 });
    await passInputLoc.fill(SPY_PASSWORD, { timeout: 30_000 });

    const submitBtn = await findFirst(framePage, ['button[type="submit"]', 'input[type="submit"]', '.btn-login']);
    if (submitBtn) {
      await submitBtn.click({ timeout: 30_000 });
    } else {
      await passInputLoc.press('Enter', { timeout: 30_000 });
    }

    // Post-login check markers
    const markers = ['.dashboard', 'nav[aria-label="main"]', '.user-menu', '.logout', '[data-testid="main-shell"]'];
    await Promise.race(markers.map((m) => framePage.waitForSelector(m, { timeout: 60_000 }))).catch(() => null);
    await log(job.id, 'info', 'Logged in');
    // Drop verbose HTML logging to reduce noise

    await ensureNotCancelled(job.id);
    const toggles = (job.payload?.toggles as Record<string, any>) || {};
    const deep = Boolean(toggles.deep);
    const doSeasons = Boolean((toggles as any).seasons);
    const dryRun = Boolean((toggles as any).dryRun);

    if (dryRun) {
      await log(job.id, 'info', 'Dry-run mode: skipping browser automation', { toggles });
      await saveResult(job.id, 'Dry-run completed', { ok: true, toggles });
      await log(job.id, 'info', 'STEP:complete');
      return;
    }

  if (job.type === 'scrape_styles') {
    await ensureNotCancelled(job.id);
    // Scrape Styles index page
    await log(job.id, 'info', 'STEP:styles_begin');
    const stylesUrl = new URL('?controller=Style%5CIndex&action=List&Spy%5CModel%5CStyle%5CIndex%5CListReportSearch%5BbForceSearch%5D=true', SPY_BASE_URL).toString();
    await page!.goto(stylesUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await ensureNotCancelled(job.id);
    await log(job.id, 'info', 'STEP:styles_url', { url: stylesUrl });
    // Ensure table exists (attached), not necessarily visible yet
    try {
      await page!.waitForSelector('table.standardList', { timeout: 60_000, state: 'attached' as any });
      await log(job.id, 'info', 'STEP:styles_table_found');
    } catch (e: any) {
      const html = await captureHtmlSnippet(page, page!);
      await log(job.id, 'error', 'STEP:styles_table_not_found', { error: e?.message || String(e), html });
      throw e;
    }
    // Try clicking "Show All" to load full list
    try {
      const showAll = await findFirst(page!, ['button[name="show_all"]', 'input[name="show_all"]', 'button:has-text("Show All")']);
      if (showAll) {
        await showAll.click({ timeout: 30_000 }).catch(() => {});
        await log(job.id, 'info', 'STEP:styles_show_all_clicked');
        await page!.waitForTimeout(1200);
      } else {
        await log(job.id, 'info', 'STEP:styles_show_all_not_found');
      }
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:styles_show_all_error', { error: e?.message || String(e) });
    }
    // Wait for at least some rows to appear (attached)
    await page!.waitForSelector('table.standardList tbody tr', { timeout: 60_000, state: 'attached' as any });
    // Scroll to load more rows up to >=100 or until stable
    try {
      let last = 0;
      for (let i = 0; i < 20; i++) {
        await ensureNotCancelled(job.id);
        const count = await page!.$$eval('table.standardList tbody tr', (trs) => trs.length);
        await log(job.id, 'info', 'STEP:styles_rows_count', { iteration: i + 1, count });
        if (count >= 100) break;
        if (count > last) {
          last = count;
          await page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page!.waitForTimeout(800);
        } else {
          break;
        }
      }
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:styles_scroll_error', { error: e?.message || String(e) });
    }
    await ensureNotCancelled(job.id);
    const rows = await page!.$$eval('table.standardList tbody tr', (trs) => {
      const out: { spy_id: string | null; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; link_href: string | null }[] = [];
      for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
        const spyId = (tr.getAttribute('data-reference') || null);
        const img = tds[0]?.querySelector('img') as HTMLImageElement | null;
        const a = tds[1]?.querySelector('a') as HTMLAnchorElement | null; // Style No. link
        const styleNo = (a?.textContent || '').trim();
        const styleName = (tds[2]?.textContent || '').replace(/\s+/g, ' ').trim() || null;
        const supplier = (tds[7]?.textContent || '').replace(/\s+/g, ' ').trim() || null;
        if (styleNo) {
          // Normalize image size to large variant (replace tr:n-s24 with tr:n-s1024 if present)
          const rawImg = (img?.getAttribute('src') || '') as string;
          const bigImg = rawImg ? rawImg.replace(/tr:n-s\d+/i, 'tr:n-s1024') : null;
          out.push({
            spy_id: spyId,
            style_no: styleNo,
            style_name: styleName,
            supplier,
            image_url: (bigImg || null),
            link_href: (a?.getAttribute('href') || null)
          });
        }
      }
      return out;
    });
    await log(job.id, 'info', 'STEP:styles_rows', { count: rows.length });
    // Upsert in batches by unique style_no
    let upserted = 0;
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
        updated_at: new Date().toISOString()
      })), { onConflict: 'style_no' });
      if (error) throw error;
      upserted += batch.length;
      await log(job.id, 'info', 'STEP:styles_batch_upsert', { upserted, total: rows.length });
    }
    await saveResult(job.id, 'Styles scrape completed', { upserted });
    await log(job.id, 'info', 'STEP:complete', { upserted });
    return;
  }
  if (job.type === 'scrape_customers') {
    await ensureNotCancelled(job.id);
    try {
      await log(job.id, 'info', 'STEP:customers_begin');
      const listUrl = new URL('?controller=Admin%5CCustomer%5CIndex&action=ActiveList', SPY_BASE_URL).toString();
      await page!.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await log(job.id, 'info', 'STEP:customers_url', { url: listUrl });
      // click Show All if present
      try {
        const btn = await findFirst(page!, ['button[name="show_all"]']);
        if (btn) { await btn.click({ timeout: 10_000 }).catch(() => {}); await page!.waitForTimeout(1000); }
      } catch {}
      // wait for table and some rows
      await page!.waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
      const rows = await page!.$$eval('table.standardList tbody tr', (trs) => {
        function tx(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
        return Array.from(trs).map(tr => {
          const tds = Array.from((tr as HTMLTableRowElement).querySelectorAll('td')) as HTMLElement[];
          const account = tx(tds[9]);
          const company = tx(tds[1]);
          const city = tx(tds[6]);
          const country = tx(tds[7]);
          const sales_person = tx(tds[5]);
          const phone = tx(tds[12]);
          const priority = tx(tds[14]);
          const ordersA = (tr as HTMLTableRowElement).querySelector('a[href*="show_sales_order"], a[href*="orders"]') as HTMLAnchorElement | null;
          const orders_link = ordersA ? (ordersA.getAttribute('href') || '') : '';
          const spy_id = (tr as HTMLElement).getAttribute('data-reference') || '';
          return { account, company, city, country, sales_person, phone, priority, orders_link, spy_id };
        });
      });
      await log(job.id, 'info', 'STEP:customers_rows', { count: rows.length });
      // Prefetch all salespersons and create a normalized lookup by name
      const { data: spAll } = await supabase.from('salespersons').select('id, name');
      const salespersonByName = new Map<string, string>();
      for (const sp of (spAll ?? []) as any[]) {
        const key = String(sp.name || '').trim().toLowerCase();
        if (key) salespersonByName.set(key, sp.id as string);
      }
      for (const r of rows) {
        if (!r.account) continue;
        // resolve salesperson_id by name
        let salesperson_id: string | null = null;
        const spName = String(r.sales_person || '').trim();
        if (spName) {
          const key = spName.toLowerCase();
          salesperson_id = salespersonByName.get(key) || null;
          if (!salesperson_id) await log(job.id, 'info', 'STEP:customers_salesperson_unmatched', { name: spName });
        }
        const { data: existing } = await supabase.from('customers').select('id').eq('customer_id', r.account).maybeSingle();
        const base = { company: r.company, city: r.city, country: r.country, phone: r.phone, priority: r.priority, orders_link: r.orders_link, spy_id: r.spy_id, salesperson_id } as any;
        if (existing?.id) {
          await supabase.from('customers').update(base).eq('id', existing.id as string);
        } else {
          await supabase.from('customers').insert({ customer_id: r.account, ...base });
        }
      }
      await saveResult(job.id, 'scrape_customers', { imported: rows.length });
      await setJobSucceeded(job.id);
      return;
    } catch (e: any) {
      await setJobFailedOrRequeue(job, e?.message || String(e));
      return;
    }
  }

  if (job.type === 'update_style_stock') {
    await ensureNotCancelled(job.id);
    await log(job.id, 'info', 'STEP:style_stock_begin');
    // Expect payload.styleNos or derive from app_settings.styles_daily_selection
    let styleNos: string[] = Array.isArray(job.payload?.styleNos) ? (job.payload?.styleNos as string[]) : [];
    if (styleNos.length === 0) {
      try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
        styleNos = ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
      } catch {}
    }
    if (styleNos.length === 0) {
      await log(job.id, 'info', 'STEP:style_stock_no_selection');
      await saveResult(job.id, 'Style stock: no styles selected', { count: 0 });
      await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
      return;
    }
    // Fetch style hrefs from styles table
    const { data: styles } = await supabase.from('styles').select('id, style_no, link_href, scrape_enabled').in('style_no', styleNos);
    let totalRows = 0;
    for (const s of (styles ?? []) as any[]) {
      await ensureNotCancelled(job.id);
      const href = (s.link_href || '').toString();
      if (!href) continue;
      // Respect style-level scrape toggle when present
      const styleId: string | null = (s.id as string | undefined) || null;
      const styleScrapeEnabled: boolean = (s as any)?.scrape_enabled !== false;
      if (!styleScrapeEnabled) {
        await log(job.id, 'info', 'STEP:style_stock_skip_style_disabled', { style_no: s.style_no });
        continue;
      }
      // Load per-color scrape flags for this style
      let allowedColors: Record<string, boolean> = {};
      if (styleId) {
        try {
          const { data: colorRows } = await supabase
            .from('style_colors')
            .select('color, scrape_enabled')
            .eq('style_id', styleId);
          for (const c of (colorRows ?? []) as any[]) {
            const key = String(c.color || '').trim().toLowerCase();
            if (key) allowedColors[key] = c.scrape_enabled !== false;
          }
        } catch {}
      }
      // Optimization: skip whole style if we know colors and all are disabled
      const knownColorKeys = Object.keys(allowedColors);
      if (knownColorKeys.length > 0 && knownColorKeys.every((k) => allowedColors[k] === false)) {
        await log(job.id, 'info', 'STEP:style_stock_skip_all_colors_disabled', { style_no: s.style_no });
        continue;
      }
      const url = new URL(href, SPY_BASE_URL).toString().replace(/#.*$/, '') + '#tab=statandstock';
      await log(job.id, 'info', 'STEP:style_stock_nav', { style_no: s.style_no, url });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await ensureNotCancelled(job.id);
      // Try to explicitly activate Stat & Stock tab if there is a tab link
      try {
        const clickedTab = await page!.evaluate(() => {
          const a = document.querySelector('a[href$="#tab=statandstock"], a[href*="#tab=statandstock"]') as HTMLAnchorElement | null;
          if (a) { a.click(); return true; }
          return false;
        });
        if (clickedTab) { await log(job.id, 'info', 'STEP:style_stock_tab_clicked'); await page!.waitForTimeout(500); }
      } catch {}
      // Expand allowed color sections by clicking arrow-down icons (skip inactive or disabled colors)
      try {
        // Wait for markers to appear first
        await page!.waitForFunction(() => !!document.querySelector('.statAndStockBox, .sprite.sprite168.spriteArrowDown.right.clickable, .sprite.sprite168.spriteArrowUp.right.clickable'), {}, { timeout: 30_000 }).catch(() => {});
        // Log counts before expanding
        try {
          const counts = await page!.evaluate(() => ({
            boxes: document.querySelectorAll('.statAndStockBox').length,
            arrowsDown: document.querySelectorAll('.sprite.sprite168.spriteArrowDown.right.clickable').length,
            arrowsUp: document.querySelectorAll('.sprite.sprite168.spriteArrowUp.right.clickable').length
          }));
          await log(job.id, 'info', 'STEP:style_stock_pre_counts', counts as any);
        } catch {}
        // Targeted clicking: only click headers for colors that are not marked inactive and not styled with #900 and allowed by DB flags
        for (let i = 0; i < 10; i++) {
          const clicked = await page!.evaluate((allowed: Record<string, boolean>) => {
            let clicks = 0;
            const headers = Array.from(document.querySelectorAll('.statAndStockBox tr.tableBackgroundBlack')) as HTMLTableRowElement[];
            function getColorName(tr: HTMLTableRowElement): string {
              // Prefer the first cell text in this row
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
            return clicks;
          }, allowedColors);
          await log(job.id, 'info', 'STEP:style_stock_expand_click', { iteration: i + 1, clicked });
          if (!clicked) break;
          await page!.waitForTimeout(500);
        }
        // As a fallback, click any remaining headers that are allowed
        const headerClicks = await page!.evaluate((allowed: Record<string, boolean>) => {
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
        await page!.waitForTimeout(500);
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:style_stock_expand_error', { error: e?.message || String(e) });
      }
      // Ensure statAndStockDetails present (increase timeout)
      try {
        await page!.waitForSelector('.statAndStockDetails', { timeout: 120_000, state: 'attached' as any });
      } catch (e: any) {
        // Last resort: force reveal any hidden tables within boxes
        try {
          const forced = await page!.evaluate(() => {
            let shown = 0;
            document.querySelectorAll('.statAndStockBox table[style*="display: none"]').forEach((t) => { (t as HTMLElement).style.display = 'table'; shown++; });
            return shown;
          });
          await log(job.id, 'info', 'STEP:style_stock_force_show', { tablesShown: forced });
          await page!.waitForTimeout(500);
          await page!.waitForSelector('.statAndStockDetails', { timeout: 10_000, state: 'attached' as any });
        } catch {}
        const html = await captureHtmlSnippet(page, page!);
        await log(job.id, 'error', 'STEP:style_stock_missing', { style_no: s.style_no, error: e?.message || String(e), html });
        continue;
      }
      // Discover ALL color headers (unfiltered) and ensure style_colors is updated before parsing
      try {
        const allColors: string[] = await page!.$$eval('.statAndStockBox', (boxes) => {
          function text(el: Element | null | undefined): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
          const found: string[] = [];
          for (const box of Array.from(boxes) as HTMLElement[]) {
            const details = box.querySelector('.statAndStockDetails') as HTMLElement | null;
            if (!details) continue;
            const firstTable = details.querySelector('table') as HTMLTableElement | null;
            if (!firstTable) continue;
            const firstRow = firstTable.querySelector('tr') as HTMLTableRowElement | null;
            if (!firstRow) continue;
            const firstTd = firstRow.querySelector('td') as HTMLElement | null;
            const color = text(firstTd);
            if (color && !found.includes(color)) found.push(color);
          }
          return found;
        });
        if (styleId && allColors && allColors.length) {
          const { data: existingColors } = await supabase
            .from('style_colors')
            .select('id, color')
            .eq('style_id', styleId);
          const existing = new Set((existingColors ?? []).map((r: any) => String(r.color || '').trim().toLowerCase()));
          const toInsert = allColors
            .filter((c) => !existing.has(String(c || '').trim().toLowerCase()))
            .map((c) => ({ style_id: styleId, color: c, sort_index: 0 }));
          if (toInsert.length) {
            await supabase.from('style_colors').insert(toInsert);
          }
        }
      } catch {}
      const extracted = await page!.$$eval('.statAndStockBox', (boxes, allowed: Record<string, boolean>) => {
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
          const firstTable = details.querySelector('table') as HTMLTableElement | null; // only first table
          if (!firstTable) continue;
          const rows = Array.from(firstTable.querySelectorAll('tr')) as HTMLTableRowElement[];
          if (rows.length === 0) continue;
          const first = rows[0] as HTMLTableRowElement | undefined;
          if (!first) continue;
          const headerTds = Array.from(first.querySelectorAll('td')) as HTMLElement[];
          const color = text(headerTds[0]);
          const colorLower = color.toLowerCase();
          // Failsafe: detect inline red background from the header row outside the details table
          const headerRowOutside = box.querySelector('tr.tableBackgroundBlack') as HTMLTableRowElement | null;
          const styleAttr = (headerRowOutside?.getAttribute('style') || '').toLowerCase();
          const hasRedBg = /#900/.test(styleAttr) || /background[-\s]*color\s*:\s*#900/.test(styleAttr);
          const hasInactive = /\(inactive\)/i.test(color);
          const allowedByDb = Object.keys(allowed || {}).length ? (allowed[colorLower] !== false) : true;
          if (hasInactive || hasRedBg || !allowedByDb) continue;
          const sizeLabels: string[] = [];
          for (let i = 1; i < headerTds.length - 1; i++) sizeLabels.push(text(headerTds[i]));

          let inSold = false;
          let inPurchase = false;
          let inDedicated = false;
          // Track last PO heading in purchase block to propagate link to dedicated rows
          let lastPurchaseHeading: { label: string; link: string | null } | null = null;
          // De-duplicate purchase entries by label+link
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

            // Base physical stock row appears before Sold header as a MAIN row labeled "Stock"
            if (!inSold && !inPurchase && label === 'Stock') { out.push({ color, sizes: sizeLabels, section: 'Stock', row_label: 'Stock', values: numbersFromRow(tds), po_link: null }); continue; }
            // Dedicated main sum row contains edit-dedication link; skip sum to avoid double counting, but enter dedicated mode
            if (rowEl.querySelector('a.edit-dedication')) { inDedicated = true; continue; }
            if (inDedicated && cls.includes('stylecolor-expanded--main') || inDedicated && cls.includes('stylecolor-expanded--sub')) {
              const kind = /Pre/i.test(label) ? 'Pre Dedicated' : 'Stock Dedicated';
              out.push({ color, sizes: sizeLabels, section: kind, row_label: label || kind, values: numbersFromRow(tds), po_link: null });
              continue;
            }
            // Sold block rows: ONLY parse detailed sub-rows; skip main (summed) rows
            if (inSold && cls.includes('stylecolor-expanded--sub')) {
              out.push({ color, sizes: sizeLabels, section: 'Sold', row_label: label || 'Row', values: numbersFromRow(tds), po_link: null });
              continue;
            }
            // Available block rows: capture Available and PO Available as their own sections
            if (!inSold && !inPurchase && cls.includes('stylecolor-expanded--main')) {
              if (/^Available$/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'Available', row_label: 'Available', values: numbersFromRow(tds), po_link: null }); continue; }
              if (/PO Available/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'PO Available', row_label: 'PO Available', values: numbersFromRow(tds), po_link: null }); continue; }
              if (/^Corrected$/i.test(label)) { out.push({ color, sizes: sizeLabels, section: 'Corrected', row_label: 'Corrected', values: numbersFromRow(tds), po_link: null }); continue; }
            }
            // Purchase block rows (both main and sub) with rules:
            // - Skip sum/aggregate lines like NOOS (exact) and Total PO (Run + Ship)
            // - If a non-dedicated sub-row is immediately followed by a dedicated sub-row (Stock/Pre Dedicated), skip the non-dedicated row
            // - Carry over the PO link from the heading row to dedicated rows if missing
            // - De-duplicate purchase entries by (row_label + po_link)
            if (inPurchase && (cls.includes('stylecolor-expanded--main') || cls.includes('stylecolor-expanded--sub'))) {
              const isSumRow = /^NOOS$/i.test(label) || /^Total\s+PO/i.test(label);
              if (isSumRow) { continue; }
              const nextEl = (rows[r + 1] as HTMLTableRowElement | undefined) || undefined;
              const nextCls = nextEl ? (nextEl.className || '') : '';
              const nextLabel = nextEl ? text((Array.from(nextEl.querySelectorAll('td')) as HTMLElement[])[0] || null) : '';
              const isDedicatedLabel = /(Stock\s+Dedicated|Pre\s+Dedicated)/i.test(label);
              const nextIsDedicatedLabel = /(Stock\s+Dedicated|Pre\s+Dedicated)/i.test(nextLabel);
              // Detect heading rows with a PO link
              const headingLinkA = rowEl.querySelector('a[href*="purchase_orders.php"]') as HTMLAnchorElement | null;
              const headingLink = headingLinkA ? (headingLinkA.getAttribute('href') || null) : null;
              if (headingLink) {
                lastPurchaseHeading = { label: label || 'Row', link: headingLink };
              }
              // Skip non-dedicated sub row if the immediately following row is a dedicated sub row
              if (!isDedicatedLabel && cls.includes('stylecolor-expanded--sub') && nextEl && nextCls.includes('stylecolor-expanded--sub') && nextIsDedicatedLabel) {
                // retain heading context (label/link) for the dedicated rows
                continue;
              }
              // Build base row
              let po_link: string | null = headingLink;
              if (!po_link) {
                const poA = rowEl.querySelector('a[href*="purchase_orders.php"]') as HTMLAnchorElement | null;
                po_link = poA ? (poA.getAttribute('href') || null) : null;
              }
              // If this is a dedicated row and missing link, use last heading's link
              if (isDedicatedLabel && !po_link && lastPurchaseHeading) {
                po_link = lastPurchaseHeading.link;
              }
              const key = (label || 'Row') + '|' + String(po_link || '');
              if (seenPurchase.has(key)) { continue; }
              seenPurchase.add(key);
              out.push({ color, sizes: sizeLabels, section: 'Purchase (Running + Shipped)', row_label: label || 'Row', values: numbersFromRow(tds), po_link });
              continue;
            }
          }
        }
        return out;
      }, allowedColors);
      // Delete rows that disappeared and upsert changes per color
      const byColor = new Map<string, typeof extracted>();
      for (const row of extracted) {
        const arr = byColor.get(row.color) || [] as any;
        (arr as any).push(row);
        byColor.set(row.color, arr as any);
      }
      // Debug logs per color: sizes, stock, sold/purchase/dedicated summaries and samples
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
            const len = sizes.length;
            const zero = Array.from({ length: len }, () => 0);
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
      // Upsert discovered colors for this style for management
      try {
        if (styleId) {
          const presentColors = Array.from(byColor.keys());
          const { data: existingColors } = await supabase
            .from('style_colors')
            .select('id, color')
            .eq('style_id', styleId);
          const existing = new Set((existingColors ?? []).map((r: any) => String(r.color || '').trim().toLowerCase()));
          const toInsert = presentColors
            .filter((c) => !existing.has(String(c || '').trim().toLowerCase()))
            .map((c) => ({ style_id: styleId, color: c, sort_index: 0 }));
          if (toInsert.length) {
            await supabase.from('style_colors').insert(toInsert);
          }
        }
      } catch {}
      // Bulk upsert extracted rows to reduce roundtrips
      const scrapeTs = new Date().toISOString();
      const payload = extracted.map((row: any) => ({
        style_no: s.style_no,
        color: row.color,
        sizes: row.sizes,
        section: row.section,
        row_label: row.row_label || '',
        values: row.values,
        po_link: row.po_link,
        scraped_at: scrapeTs
      }));
      // Deduplicate by conflict key to avoid ON CONFLICT affecting the same row twice
      const dedupMap = new Map<string, any>();
      for (const r of payload) {
        const key = `${r.style_no}|${r.color}|${r.section}|${r.row_label || ''}`;
        dedupMap.set(key, r); // last one wins
      }
      const deduped = Array.from(dedupMap.values());
      if (deduped.length) {
        const { error: upErr } = await supabase
          .from('style_stock')
          .upsert(deduped, { onConflict: 'style_no,color,section,row_label' as any });
        if (upErr) throw upErr;
        totalRows += deduped.length;
      }
      await log(job.id, 'info', 'STEP:style_stock_rows', { style_no: s.style_no, rows: extracted.length });
    }
    await saveResult(job.id, 'Style stock scrape completed', { totalRows });
    await log(job.id, 'info', 'STEP:complete', { totalRows });
    return;
  }
  if (job.type === 'deep_scrape_styles') {
    await ensureNotCancelled(job.id);
    await log(job.id, 'info', 'STEP:deep_styles_begin');
    // Fetch all styles with links
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
      await page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      try {
        // Wait for any colorDeliveryBox
        await page!.waitForSelector('.colorDeliveryBox', { timeout: 30_000 });
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:deep_styles_no_color_box', { style_no: s.style_no, error: e?.message || String(e) });
        continue;
      }
      const seasons = await page!.$$eval('.colorDeliveryBox select.season_id', (sels) => {
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
    return;
  }
  if (job.type === 'export_overview') {
    try {
      await log(job.id, 'info', 'STEP:export_overview_begin', job.payload || {});
      const countries = ['All','Denmark','Norway','Sweden','Finland'];
      const s1 = (job.payload as any)?.s1 as string | undefined;
      const s2 = (job.payload as any)?.s2 as string | undefined;
      const list: Array<{ country: string; path: string; publicUrl?: string | null }> = [];
      // Use existing browser connection
      const ctx = await browser!.newContext({ viewport: { width: 1200, height: 1600 } });
      const page = await ctx.newPage();
      const webBase = (process.env.WEB_ORIGIN || '').replace(/\/$/, '');
      for (const country of countries) {
        const url = `${webBase}/statistics/overview/print?country=${encodeURIComponent(country)}${s1?`&s1=${encodeURIComponent(s1)}`:''}${s2?`&s2=${encodeURIComponent(s2)}`:''}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
        await log(job.id, 'info', 'STEP:export_overview_nav', { country, url });
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        const path = `overview/${job.id}/${country}.pdf`;
        try {
          const up = await supabase.storage.from('exports').upload(path, pdf as any, { contentType: 'application/pdf', upsert: true });
          let publicUrl: string | null = null;
          const { data: pub } = supabase.storage.from('exports').getPublicUrl(path);
          publicUrl = pub?.publicUrl ?? null;
          list.push({ country, path, publicUrl });
        } catch (e) {
          list.push({ country, path });
        }
      }
      await ctx.close();
      await saveResult(job.id, 'export_overview', { files: list });
      await setJobSucceeded(job.id);
      return;
    } catch (e: any) {
      await setJobFailedOrRequeue(job, e?.message || String(e));
      return;
    }
  }

  if (doSeasons) {
    // Scrape seasons list and upsert into Supabase
    await log(job.id, 'info', 'STEP:seasons_scrape_begin');
    const seasonsUrl = new URL('?controller=Admin%5CSettings%5CStyle%5CSeason&action=List', SPY_BASE_URL).toString();
    await page.goto(seasonsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
    const rows = await page.$$eval('table.standardList tbody tr', (trs) => {
      function parseSeason(text: string): { yy: number; name: string } | null {
        const t = (text || '').trim();
        const m = t.match(/^(\d{2})\s+(.+)$/);
        if (!m) return null;
        const yyStr = (m[1] ?? '0');
        const nameStr = (m[2] ?? '').trim();
        return { yy: Number(yyStr), name: nameStr };
      }
      const out: { spyId: string; label: string; parsed: { yy: number; name: string } | null }[] = [];
      for (const tr of Array.from(trs)) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
        const a = tds[1]?.querySelector('a[href*="season_id="]') as HTMLAnchorElement | null;
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/season_id=(\d+)/);
        const spyId: string = (m?.[1] ?? '') + '';
        const label = (a.textContent || '').trim();
        out.push({ spyId, label, parsed: parseSeason(label) });
      }
      return out;
    });
    await log(job.id, 'info', 'STEP:seasons_rows', { count: rows.length });
    let upserted = 0;
    for (const r of rows) {
      if (!r.parsed) continue;
      const year = 2000 + Number(r.parsed.yy || 0);
      const displayName = `${String(r.parsed.name || '').trim()} ${year}`.trim();
      const sourceName = displayName;
      try {
        // Prefer matching by spy_season_id when available to avoid conflicts with manually edited names
        const spyIdNum = Number(r.spyId || 0) || null;
        let existingId: string | null = null;
        if (spyIdNum) {
          const { data: bySpy } = await supabase.from('seasons').select('id').eq('spy_season_id', spyIdNum).maybeSingle();
          existingId = (bySpy?.id as string | undefined) || null;
        }
        if (!existingId) {
          const { data: byName } = await supabase.from('seasons').select('id').ilike('name', displayName).maybeSingle();
          existingId = (byName?.id as string | undefined) || null;
        }

        if (!existingId) {
          const { error: insErr } = await supabase.from('seasons').insert({ name: displayName, source_name: sourceName, year, spy_season_id: spyIdNum });
          if (insErr) throw insErr;
          upserted++;
        } else {
          // Update spy_season_id if missing, and keep source_name up to date
          const updates: Record<string, any> = {};
          if (spyIdNum) updates.spy_season_id = spyIdNum;
          updates.source_name = sourceName;
          await supabase.from('seasons').update(updates).eq('id', existingId);
        }
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:seasons_upsert_error', { name: displayName, error: e?.message || String(e) });
      }
    }
    await saveResult(job.id, 'Seasons scrape completed', { upserted, total: rows.length });
    await log(job.id, 'info', 'STEP:complete', { upserted });
      return;
    }

    if (deep) {
      // Deep scrape: Topseller list -> iterate salesperson detail pages -> upsert to DB
      // Determine seasonId: prefer payload, else read selected from Spy dropdown
      let targetSeasonId: string | null = (job.payload?.seasonId as string | undefined) || null;
      // Also capture Spy's internal season ID from the Topseller dropdown for robust invoiced navigation
      let spySeasonId: string | null = null;

      const topsellerUrl = new URL('confident.php?mode=Topseller', SPY_BASE_URL).toString();
      await page.goto(topsellerUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(500);

      // If seasonId not provided, read from select#s_season_id (selected option text like "25 WINTER")
      if (!targetSeasonId) {
        try {
          const seasonInfo = await page.evaluate(() => {
            const sel = document.querySelector('#s_season_id') as HTMLSelectElement | null;
            if (!sel) return null;
            const selectedIndex = sel.selectedIndex >= 0 ? sel.selectedIndex : 0;
            const opt = sel.options?.[selectedIndex] || sel.selectedOptions?.[0] || sel.querySelector('option[selected]');
            const value = sel.value || (opt as HTMLOptionElement | null)?.value || '';
            const text = ((opt as HTMLOptionElement | null)?.textContent || '').trim();
            return { value, text };
          });
          if (seasonInfo && seasonInfo.text) {
            spySeasonId = (seasonInfo.value && seasonInfo.value !== '0') ? seasonInfo.value : null;
            // If not present in settings, try seasons.spy_season_id mapping
            if (!spySeasonId) {
              try {
                const { data: seasonRow } = await supabase.from('seasons').select('spy_season_id').eq('id', targetSeasonId).maybeSingle();
                const spyId = (seasonRow?.spy_season_id as number | null) ?? null;
                if (spyId && String(spyId).trim().length > 0) spySeasonId = String(spyId);
              } catch {}
            }
            function normalizeSeasonLabel(label: string): { name: string; year: number } {
              const parts = label.trim().split(/\s+/);
              const yy = parts.shift() || '';
              const year = 2000 + (parseInt(yy, 10) || 0);
              let name = parts.join(' ').toUpperCase();
              // Strip prefixes like "BASIC - "
              name = name.replace(/^BASIC\s*-\s*/i, '').trim();
              return { name, year: isFinite(year) ? year : new Date().getFullYear() };
            }
            const { name, year } = normalizeSeasonLabel(seasonInfo.text);
            const displayName = `${name} ${year}`;
            // Find or create season by display name
            const { data: found } = await supabase.from('seasons').select('id').ilike('name', displayName).maybeSingle();
            if (found?.id) {
              targetSeasonId = found.id as string;
            } else {
              const { data: ins, error: insErr } = await supabase
                .from('seasons')
                .insert({ name: displayName, year })
                .select('id')
                .single();
              if (!insErr) targetSeasonId = ins!.id as string;
            }
            await log(job.id, 'info', 'STEP:season_selected', { label: seasonInfo.text, seasonName: displayName, seasonId: targetSeasonId });
          }
        } catch {}
      }

      if (!targetSeasonId) throw new Error('seasonId could not be determined');

      const stdTableSel = 'table.standardList';
      await page.waitForSelector(stdTableSel, { timeout: 60_000 });
      // Success criteria: tbody has at least 3 rows
      await page.waitForFunction(() => {
        const tb = document.querySelector('table.standardList tbody');
        return !!tb && tb.querySelectorAll('tr').length >= 3;
      }, {}, { timeout: 60_000 });
      await log(job.id, 'info', 'STEP:begin_deep', { seasonId: targetSeasonId });
      await log(job.id, 'info', 'STEP:topseller_ready');

      // Extract salesperson rows: take 2nd td link and name
      const salespeople = await page.$$eval('table.standardList tbody tr', (trs) => {
        const list: { name: string; href: string }[] = [];
        for (const tr of Array.from(trs)) {
          const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
          if (tds.length < 2) continue;
          const anchor = tds[1]?.querySelector('a') as HTMLAnchorElement | null;
          const name = (anchor?.textContent || '').trim();
          const href = (anchor?.getAttribute('href') || '').trim();
          if (name && href) list.push({ name, href });
        }
        return list;
      });
      await log(job.id, 'info', 'STEP:salespersons_total', { total: salespeople.length });

      // helpers
      function toAbs(href: string): string {
        try { return new URL(href, SPY_BASE_URL).toString(); } catch { return href; }
      }
      function parseAmount(value: string): { amount: number; currency: string | null } {
        const trimmed = (value || '').replace(/\s+/g, ' ').trim();
        if (!trimmed) return { amount: 0, currency: null };
        // Handle European formatting like "1.335,00 DKK" or "5.926,25 DKK"
        const parts = trimmed.split(' ');
        const currency: string | null = parts.length > 1 ? (parts[parts.length - 1] || null) : null;
        const numPart = currency ? trimmed.slice(0, trimmed.length - (currency.length + 1)) : trimmed;
        const normalized = numPart.replace(/\./g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
        const amount = Number(normalized) || 0;
        return { amount, currency };
      }

      async function ensureSalespersonId(name: string): Promise<string | null> {
        if (!name) return null;
        const { data: found } = await supabase.from('salespersons').select('id').ilike('name', name).maybeSingle();
        if (found?.id) return found.id as string;
        const { data: inserted, error } = await supabase.from('salespersons').insert({ name }).select('id').single();
        if (error) throw error;
        return inserted!.id as string;
      }

      async function ensureCustomerIdByAccount(accountNo: string, fields: { company?: string | null; city?: string | null; country?: string | null; salesperson_id?: string | null }): Promise<string | null> {
        if (!accountNo) return null;
        const { data: existing } = await supabase.from('customers').select('id').eq('customer_id', accountNo).maybeSingle();
        if (existing?.id) return existing.id as string;
        const { data: ins, error: insErr } = await supabase
          .from('customers')
          .insert({ customer_id: accountNo, ...fields })
          .select('id')
          .single();
        if (insErr) throw insErr;
        return ins!.id as string;
      }

      let processed = 0;
      let totalRowsUpserted = 0;
      const resultSamples: Array<{ salesperson: string; rows: Array<{ customer: string; account: string; country: string; qty: string; amount: string; salesperson: string }> }> = [];
      const topsellerDump: Array<{ salesperson: string; rows: Array<{ customer: string; account: string; country: string; qty: number; amount: number; currency: string | null }> }> = [];
      for (const sp of salespeople) {
        await ensureNotCancelled(job.id);
        processed++;
        await log(job.id, 'info', 'STEP:salesperson_start', { index: processed, total: salespeople.length, name: sp.name });
        const url = toAbs(sp.href);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await ensureNotCancelled(job.id);

        // Wait for the single table and at least 1 row
        const tableSel = 'table';
        try {
          await page.waitForSelector(tableSel, { timeout: 60_000 });
          await page.waitForFunction(() => {
            const t = document.querySelector('table');
            if (!t) return false;
            return !!t.querySelector('tbody tr');
          }, {}, { timeout: 60_000 });
        } catch (e) {
          await log(job.id, 'error', 'STEP:salesperson_timeout', { name: sp.name });
          continue; // skip to next salesperson instead of failing job
        }

        // Parse headers to find column indices
        const headers: string[] = await page.$$eval('table thead th', (ths) => ths.map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim()));
        const idx = {
          customer: headers.findIndex((h) => /^customer$/i.test(h)),
          account: headers.findIndex((h) => /^account$/i.test(h)),
          country: headers.findIndex((h) => /^country$/i.test(h)),
          qty: headers.findIndex((h) => /qty/i.test(h)),
          amountCus: headers.findIndex((h) => /T\.\s*Amount.*Cus/i.test(h) || /Amount \(Cus\. Cur\.\)/i.test(h)),
          salesperson: headers.findIndex((h) => /^salesperson$/i.test(h))
        };

        const rows = await page.$$eval('table tbody tr', (trs, idx) => {
          function cellText(tr: HTMLTableRowElement, i: number): string {
            const el = tr.querySelectorAll('td')[i] as HTMLElement | undefined;
            if (!el) return '';
            const link = el.querySelector('a') as HTMLElement | null;
            const span = el.querySelector('span') as HTMLElement | null;
            return ((el.innerText || link?.innerText || span?.innerText || el.textContent || '') as string).replace(/\s+/g, ' ').trim();
          }
          const out: { customer: string; account: string; country: string; qty: string; amount: string; salesperson: string }[] = [];
          for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
            out.push({
              customer: idx.customer >= 0 ? cellText(tr, idx.customer) : '',
              account: idx.account >= 0 ? cellText(tr, idx.account) : '',
              country: idx.country >= 0 ? cellText(tr, idx.country) : '',
              qty: idx.qty >= 0 ? cellText(tr, idx.qty) : '0',
              amount: idx.amountCus >= 0 ? cellText(tr, idx.amountCus) : '0',
              salesperson: idx.salesperson >= 0 ? cellText(tr, idx.salesperson) : ''
            });
          }
          return out;
        }, idx as any);

        // Upsert rows into DB
        const salespersonId = await ensureSalespersonId(sp.name);
        let upsertedForSp = 0;
        // Collect up to 5 sample rows for results visibility
        try {
          resultSamples.push({ salesperson: sp.name, rows: rows.slice(0, Math.min(5, rows.length)) });
        } catch {}
        // Collect all rows (with numeric amounts) for logs (cap to avoid over-large payloads)
        try {
          const normalized = rows.slice(0, 500).map((r) => {
            const { amount, currency } = parseAmount(r.amount || '');
            return { customer: r.customer, account: r.account, country: r.country, qty: Number((r.qty || '0').replace(/[^0-9.\-]/g, '')) || 0, amount, currency };
          });
          topsellerDump.push({ salesperson: sp.name, rows: normalized });
        } catch {}
        const upsertedRowsForLog: Array<{ account: string; customer: string; qty: number; price: number; currency: string | null; op: 'created' | 'updated' }> = [];
        for (const r of rows) {
          const qty = Number((r.qty || '0').replace(/[^0-9.\-]/g, '')) || 0;
          const { amount: price, currency } = parseAmount(r.amount || '');
          const accountNo = (r.account || '').trim();
          const customerName = (r.customer || '').trim();
          const country = (r.country || '').trim();
          // Ensure customer exists
          const customerUuid = await ensureCustomerIdByAccount(accountNo, { company: customerName || null, country: country || null, salesperson_id: salespersonId });
          const insertRow: any = {
            season_id: targetSeasonId,
            account_no: accountNo,
            customer_id: customerUuid,
            customer_name: customerName || null,
            city: null,
            salesperson_id: salespersonId,
            salesperson_name: sp.name,
            qty,
            price,
            currency: currency || null
          };
          // Determine whether this will create or update
          let op: 'created' | 'updated' = 'created';
          try {
            const { data: existing } = await supabase
              .from('sales_stats')
              .select('id')
              .eq('season_id', targetSeasonId)
              .eq('account_no', accountNo)
              .maybeSingle();
            if (existing?.id) op = 'updated';
          } catch {}

          const { error: upErr } = await supabase
            .from('sales_stats')
            .upsert(insertRow, { onConflict: 'season_id,account_no' });
          if (upErr) throw upErr;
          upsertedForSp++;
          if (upsertedRowsForLog.length < 10) {
            upsertedRowsForLog.push({ account: accountNo, customer: customerName, qty, price, currency: currency || null, op });
          }
        }
        totalRowsUpserted += upsertedForSp;
        await log(job.id, 'info', 'STEP:salesperson_done', { index: processed, total: salespeople.length, upserted: upsertedForSp, name: sp.name, rows: upsertedRowsForLog });
      }

      // After seasonal totals per salesperson, fetch invoiced list for the same season
      async function scrapeInvoicedLines(seasonId: string, spySeasonIdParam: string | null): Promise<Array<{
        customerName: string;
        qty: number;
        userCurrencyAmount: { amount: number; currency: string | null } | null;
        customerCurrencyAmount: { amount: number; currency: string | null } | null;
        invoiceNo?: string;
        invoiceDate?: string;
        matchedCustomerId?: string | null;
        salespersonName?: string | null;
      }>> {
        await log(job.id, 'info', 'STEP:invoiced_begin');
        // Always force the iSeasonID if we have it
        const base = spySeasonIdParam && spySeasonIdParam.trim().length > 0
          ? `?controller=Sale%5CInvoiced&action=List&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BbForceSearch%5D=true&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BiSeasonID%5D=${encodeURIComponent(spySeasonIdParam)}&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BstrOrderType%5D=pre`
          : `?controller=Sale%5CInvoiced&action=List&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BstrOrderType%5D=pre`;
        const url = new URL(base, SPY_BASE_URL).toString();
        await page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await log(job.id, 'info', 'STEP:invoiced_url', { url, spySeasonId: spySeasonIdParam ?? null });
        // Determine display label like "25 WINTER" from seasons table
        let displayLabel: string | null = null;
        try {
          const { data: seasonRow } = await supabase.from('seasons').select('name, year').eq('id', seasonId).maybeSingle();
          const name = (seasonRow?.name || '').toUpperCase().replace(/^BASIC\s*-\s*/i, '').trim();
          const year = (seasonRow?.year as number | null) ?? undefined;
          if (year && name) displayLabel = String(year).slice(-2) + ' ' + name;
        } catch {}
        await log(job.id, 'info', 'STEP:invoiced_season_label', { label: displayLabel ?? '(auto)' });

        // If we didn't include seasonId in URL, fall back to selecting by label and clicking Search
        if (!spySeasonIdParam) {
          try {
            await page!.waitForSelector('select#Spy\\.Model\\.Sale\\.Invoiced\\.InvoicedReportSearch\\[iSeasonID\\]', { timeout: 30_000 });
            await page!.evaluate((label) => {
              const sel = document.querySelector('select#Spy\\.Model\\.Sale\\.Invoiced\\.InvoicedReportSearch\\[iSeasonID\\]') as HTMLSelectElement | null;
              if (!sel || !label) return;
              for (const opt of Array.from(sel.options)) {
                const t = (opt.textContent || '').trim().toUpperCase();
                if (t === label.toUpperCase()) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
              }
            }, displayLabel);
            // Click search (try to find a submit button)
            const submitBtn = await findFirst(page!, [
              'button[name="search"][type="submit"]',
              'button[name="search"]',
              'form button[name="search"]',
              'form button[type="submit"]',
              'form input[type="submit"]',
              'button.search',
              '.btn.btn-primary'
            ]);
            if (submitBtn) {
              await submitBtn.click({ timeout: 30_000 }).catch(() => {});
              await log(job.id, 'info', 'STEP:invoiced_search_clicked');
            } else {
              // Fallback: try submitting the first form on the page
              try {
                await page!.evaluate(() => {
                  const f = document.querySelector('form') as HTMLFormElement | null;
                  if (f) f.requestSubmit ? f.requestSubmit() : f.submit();
                });
                await log(job.id, 'info', 'STEP:invoiced_search_submit_fallback');
              } catch {}
            }
          } catch {}
        }

        // Wait for the results table
        await page!.waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
        await page!.waitForFunction(() => {
          const tr = document.querySelector('table.standardList tbody tr');
          return !!tr && (tr as HTMLElement).innerText.trim().length > 0;
        }, {}, { timeout: 60_000 }).catch(() => {});
        await log(job.id, 'info', 'STEP:invoiced_ready');

        // Attempt to load all rows: scroll to bottom repeatedly until count stabilizes
        try {
          let last = 0;
          for (let i = 0; i < 20; i++) {
            const count = await page!.$$eval('table.standardList tbody tr', (trs) => trs.length);
            await log(job.id, 'info', 'STEP:invoiced_rows_count', { iteration: i + 1, count });
            if (count > last) {
              last = count;
              await page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
              await page!.waitForTimeout(800);
            } else {
              break;
            }
          }
        } catch (e: any) {
          await log(job.id, 'error', 'STEP:invoiced_scroll_error', { error: e?.message ?? String(e) });
        }

        // Extract rows according to header mapping (Customer, Qty, amounts)
        const rows: Array<{ customerName: string; qty: number; userCurr: string; custCurr: string; invoiceNo?: string; invoiceDate?: string }> = await page!.$$eval(
          'table.standardList tbody tr',
          (trs) => {
            function parseNumEu(s: string): number { const n = (s || '').replace(/\./g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, ''); return Number(n) || 0; }
            return Array.from(trs).map((tr) => {
              const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
              const customerDiv = tds[2]?.querySelector('div') as HTMLElement | null;
              const customerName = (customerDiv?.textContent || tds[2]?.textContent || '').trim();
              const qty = parseNumEu((tds[10]?.textContent || '').trim());
              const userCurrText = (tds[12]?.textContent || '').trim();
              const custCurrText = (tds[13]?.textContent || '').trim();
              const invoiceNo = (tds[7]?.textContent || '').trim();
              const invoiceDate = (tds[8]?.textContent || '').trim();
              return { customerName, qty, userCurr: userCurrText, custCurr: custCurrText, invoiceNo, invoiceDate };
            });
          }
        );
        await (async () => { try { await log(job.id, 'info', 'STEP:invoiced_lines', { count: rows.length }); } catch {} })();

        const out: Array<{ customerName: string; qty: number; userCurrencyAmount: { amount: number; currency: string | null } | null; customerCurrencyAmount: { amount: number; currency: string | null } | null; invoiceNo?: string; invoiceDate?: string; matchedCustomerId?: string | null; matchedAccount?: string | null; salespersonName?: string | null; }> = [];
        for (const r of rows) {
          const user = parseAmount(r.userCurr);
          const cust = parseAmount(r.custCurr);
          let matchedCustomerId: string | null = null;
          let matchedAccount: string | null = null;
          let salespersonName: string | null = null;
          if (r.customerName) {
            try {
              const { data: found } = await supabase.from('customers').select('id, customer_id, salespersons(name)').ilike('company', r.customerName).maybeSingle();
              if (found?.id) matchedCustomerId = found.id as string;
              // @ts-ignore
              matchedAccount = (found as any)?.customer_id ?? null;
              // @ts-ignore
              salespersonName = (found as any)?.salespersons?.name ?? null;
            } catch {}
          }
          out.push({ customerName: r.customerName, qty: r.qty, userCurrencyAmount: { amount: user.amount, currency: user.currency }, customerCurrencyAmount: { amount: cust.amount, currency: cust.currency }, invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate, matchedCustomerId, matchedAccount, salespersonName });
        }
        return out;
      }

      // Ensure we have SPY season id before visiting invoiced page: prefer mapping if not yet set
      if (!spySeasonId && targetSeasonId) {
        try {
          const { data: seasonRow } = await supabase.from('seasons').select('spy_season_id').eq('id', targetSeasonId).maybeSingle();
          const spyId = (seasonRow?.spy_season_id as number | null) ?? null;
          if (spyId && String(spyId).trim().length > 0) {
            spySeasonId = String(spyId);
            await log(job.id, 'info', 'STEP:invoiced_spy_id_from_mapping', { spySeasonId });
          }
        } catch {}
      }
      await log(job.id, 'info', 'STEP:invoiced_call', { targetSeasonId, spySeasonId: spySeasonId ?? null });
      const invoicedLines: Array<{ customerName: string; qty: number; userCurrencyAmount: { amount: number; currency: string | null } | null; customerCurrencyAmount: { amount: number; currency: string | null } | null; invoiceNo?: string; invoiceDate?: string; matchedCustomerId?: string | null; matchedAccount?: string | null; salespersonName?: string | null; }> = await scrapeInvoicedLines(targetSeasonId, spySeasonId);

      // Persist raw invoices for idempotency and detail views
      try {
        let upserts = 0;
        for (const inv of invoicedLines) {
          const accountNo = (inv.matchedAccount || '').trim();
          if (!accountNo || !inv.invoiceNo) continue;
          const pick = inv.userCurrencyAmount || inv.customerCurrencyAmount;
          const amount = Number(pick?.amount || 0) || 0;
          // If this invoice row has been manually edited, skip overwriting qty/amount
          const { data: existingInv } = await supabase
            .from('sales_invoices')
            .select('id, manual_edited')
            .eq('season_id', targetSeasonId)
            .eq('account_no', accountNo)
            .eq('invoice_no', inv.invoiceNo)
            .maybeSingle();
          if (existingInv?.id && existingInv.manual_edited) {
            // keep manual values, update non-destructive fields only
            await supabase
              .from('sales_invoices')
              .update({ customer_name: inv.customerName || null, currency: pick?.currency || null, invoice_date: inv.invoiceDate || null, updated_at: new Date().toISOString() })
              .eq('id', existingInv.id as string);
          } else {
            await supabase
              .from('sales_invoices')
              .upsert({
                season_id: targetSeasonId,
                account_no: accountNo,
                customer_name: inv.customerName || null,
                qty: Number(inv.qty || 0) || 0,
                amount,
                currency: pick?.currency || null,
                invoice_no: inv.invoiceNo,
                invoice_date: inv.invoiceDate || null
              }, { onConflict: 'season_id,account_no,invoice_no' });
          }
          upserts++;
        }
        await log(job.id, 'info', 'STEP:invoiced_rows_upserted', { count: upserts });
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:invoiced_rows_upsert_error', { error: e?.message || String(e) });
      }

      // Apply invoiced adjustments (add/subtract to the same season/account in sales_stats)
      try {
        let adjusted = 0;
        for (const inv of invoicedLines) {
          const accountNo = (inv.matchedAccount || '').trim();
          if (!accountNo) continue;
          const pick = inv.userCurrencyAmount || inv.customerCurrencyAmount;
          if (!pick) continue;
          const deltaPrice = Number(pick.amount || 0) || 0; // may be negative
          let deltaQty = Number(inv.qty || 0) || 0;
          if (deltaPrice < 0) deltaQty = -Math.abs(deltaQty); // reflect sign on qty as well

          // Fetch existing row to aggregate
          const { data: existing } = await supabase
            .from('sales_stats')
            .select('id, qty, price')
            .eq('season_id', targetSeasonId)
            .eq('account_no', accountNo)
            .maybeSingle();

          if (existing?.id) {
            const newQty = (Number((existing as any).qty || 0) || 0) + deltaQty;
            const newPrice = (Number((existing as any).price || 0) || 0) + deltaPrice;
            const { error: upErr } = await supabase
              .from('sales_stats')
              .update({ qty: newQty, price: newPrice, currency: pick.currency || null })
              .eq('id', existing.id as string);
            if (upErr) throw upErr;
          } else {
            // Create a minimal row if none exists yet
            const { error: insErr } = await supabase.from('sales_stats').insert({
              season_id: targetSeasonId,
              account_no: accountNo,
              customer_id: null,
              qty: deltaQty,
              price: deltaPrice,
              currency: pick.currency || null
            });
            if (insErr) throw insErr;
          }
          adjusted++;
        }
        await log(job.id, 'info', 'STEP:invoiced_adjustments_applied', { count: adjusted });
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:invoiced_adjustments_error', { error: e?.message || String(e) });
      }

      await saveResult(job.id, 'Deep scrape completed', {
        seasonId: targetSeasonId,
        salespersons: salespeople.length,
        rowsUpserted: totalRowsUpserted,
        samples: resultSamples,
        parsed: { topseller: topsellerDump, invoiced: { count: invoicedLines.length, lines: invoicedLines } }
      });
      await log(job.id, 'info', 'STEP:complete', { rows: totalRowsUpserted });
    } else {
      // Shallow scrape: navigate to Topseller table and extract rows
    await ensureNotCancelled(job.id);
      await log(job.id, 'info', 'Starting shallow scrape');
      const topsellerUrl = new URL('confident.php?mode=Topseller', SPY_BASE_URL).toString();
      await page.goto(topsellerUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1200);
      await log(job.id, 'info', 'Topseller page loaded', { url: topsellerUrl });

      const tableSelector = 'table.standardList.sortTable.table-fixed--set.selector_selection_set[name="top_sellers"]';
      await page.waitForSelector(tableSelector, { timeout: 30_000 });
      // Wait for rows to actually contain text or data-sort-value
      await page.waitForFunction((sel: string) => {
        const table = document.querySelector(sel);
        if (!table) return false;
        const first = table.querySelector('tbody tr');
        if (!first) return false;
        const tds = Array.from(first.querySelectorAll('td')) as HTMLElement[];
        return tds.some((td) => (td.innerText && td.innerText.trim().length > 0) || (td.getAttribute('data-sort-value') || '').trim().length > 0);
      }, tableSelector, { timeout: 60_000 });
      // Drop verbose HTML logging

      // Extract headers (second header row has the real labels)
      const headers: string[] = await page.$$eval(
        `${tableSelector} thead.table-fixed:not(.table-fixed--header):first-of-type tr:nth-of-type(2) th`,
        (ths) => ths.map((th) => ((th as HTMLElement).innerText || th.textContent || '').replace(/\s+/g, ' ').trim())
      );

      // Extract body rows (cap to 100 rows)
      const rowsRaw: string[][] = await page.$$eval(
        `${tableSelector} tbody tr`,
        (trs) =>
          Array.from(trs)
            .slice(0, 100)
            .map((tr) =>
              Array.from(tr.querySelectorAll('td')).map((td) => {
                const el = td as HTMLElement;
                // Try multiple sources for content
                const link = el.querySelector('a') as HTMLElement | null;
                const span = el.querySelector('span') as HTMLElement | null;
                const txt = (el.innerText || link?.innerText || span?.innerText || el.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim();
                const sort = (el.getAttribute('data-sort-value') || '').trim();
                return txt || sort;
              })
            )
      );

      // Build objects using headers where possible
      const normalizedHeaders = headers.map((h, i) => (h && h.length > 0 ? h : `col_${i}`));
      const rowObjects = rowsRaw.map((cells) => {
        const obj: Record<string, string> = {};
        const len = Math.min(normalizedHeaders.length, cells.length);
        for (let i = 0; i < len; i++) {
          const key = normalizedHeaders[i] ?? `col_${i}`;
          obj[key] = cells[i] ?? '';
        }
        return obj;
      });

      await log(job.id, 'info', 'Topseller rows collected', {
        count: rowObjects.length,
        headersLen: headers.length,
        firstRowLen: rowsRaw[0]?.length ?? 0,
        headers: headers,
        sample: rowObjects[0] ?? null,
        sampleCells: rowsRaw[0] ?? null
      });
      await saveResult(job.id, 'Topseller shallow snapshot', { headers: normalizedHeaders, rows: rowObjects });
      await log(job.id, 'info', 'STEP:complete');
    }
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

const IDLE_SLEEP_MS = Math.max(500, Number(process.env.IDLE_SLEEP_MS || '2000') || 2000);
const IDLE_SLEEP_MAX_MS = Math.max(IDLE_SLEEP_MS, Number(process.env.IDLE_SLEEP_MAX_MS || '60000') || 60000);

async function mainLoop() {
  // eslint-disable-next-line no-console
  console.log('[worker] started', new Date().toISOString());
  try {
    const u = new URL(SUPABASE_URL);
    // eslint-disable-next-line no-console
    console.log('[worker] supabase host', u.host);
  } catch {}
  let idleMs = IDLE_SLEEP_MS;
  while (true) {
    const job = await leaseNextJob();
    if (!job) {
      // eslint-disable-next-line no-console
      if (idleMs === IDLE_SLEEP_MS) console.log(`[worker] no jobs, sleeping ${idleMs}ms`);
      await sleep(idleMs);
      idleMs = Math.min(IDLE_SLEEP_MAX_MS, Math.floor(idleMs * 2));
      continue;
    }
    idleMs = IDLE_SLEEP_MS; // reset backoff when we get a job

    const heartbeat = setInterval(() => updateJobHeartbeat(job.id).catch(() => {}), 45_000);
    try {
      await log(job.id, 'info', 'Job leased');
    await runJob(job);
    // Check if job was cancelled during run; if so, avoid marking as succeeded
    if (await isJobCancelled(job.id)) {
      await log(job.id, 'info', 'Job cancelled (post-run check)');
    } else {
      await setJobSucceeded(job.id);
      await log(job.id, 'info', 'Job succeeded');
    }
    } catch (err: any) {
      const message = err?.message ?? String(err);
    if (err?.name === 'CancelledError' || message === 'JOB_CANCELLED') {
      await log(job.id, 'info', 'Job cancelled by request');
      await setJobCancelled(job.id, 'Stopped by staff');
    } else {
      await log(job.id, 'error', 'Job failed', { error: message });
      await setJobFailedOrRequeue(job, message);
    }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

mainLoop().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker error', e);
  process.exit(1);
});


