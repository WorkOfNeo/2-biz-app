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

    await page.goto(SPY_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'Loaded login page');

    const framePage = await maybeGetLoginFrame(page);
    const loginHtml = await captureHtmlSnippet(framePage, page);
    await log(job.id, 'info', 'Login page HTML', { html: loginHtml });

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
    const postLoginHtml = await captureHtmlSnippet(framePage, page);
    await log(job.id, 'info', 'Post-login page HTML', { html: postLoginHtml });

    const toggles = (job.payload?.toggles as Record<string, any>) || {};
    const deep = Boolean(toggles.deep);
    const dryRun = Boolean((toggles as any).dryRun);

    if (dryRun) {
      await log(job.id, 'info', 'Dry-run mode: skipping browser automation', { toggles });
      await saveResult(job.id, 'Dry-run completed', { ok: true, toggles });
      await log(job.id, 'info', 'STEP:complete');
      return;
    }

    if (deep) {
      // Deep scrape: Topseller list -> iterate salesperson detail pages -> upsert to DB
      // Determine seasonId: prefer payload, else read selected from Spy dropdown
      let targetSeasonId: string | null = (job.payload?.seasonId as string | undefined) || null;

      const topsellerUrl = new URL('confident.php?mode=Topseller', SPY_BASE_URL).toString();
      await page.goto(topsellerUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(500);

      // If seasonId not provided, read from select#s_season_id (selected option text like "25 WINTER")
      if (!targetSeasonId) {
        try {
          const seasonInfo = await page.evaluate(() => {
            const sel = document.querySelector('#s_season_id') as HTMLSelectElement | null;
            if (!sel) return null;
            const opt = sel.selectedOptions?.[0] || sel.querySelector('option[selected]');
            if (!opt) return null;
            return { value: (opt as HTMLOptionElement).value || '', text: ((opt as HTMLOptionElement).textContent || '').trim() };
          });
          if (seasonInfo && seasonInfo.text) {
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
      for (const sp of salespeople) {
        processed++;
        await log(job.id, 'info', 'STEP:salesperson_start', { index: processed, total: salespeople.length, name: sp.name });
        const url = toAbs(sp.href);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

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
          const { error: upErr } = await supabase
            .from('sales_stats')
            .upsert(insertRow, { onConflict: 'season_id,account_no' });
          if (upErr) throw upErr;
          upsertedForSp++;
        }
        totalRowsUpserted += upsertedForSp;
        await log(job.id, 'info', 'STEP:salesperson_done', { index: processed, total: salespeople.length, upserted: upsertedForSp, name: sp.name });
      }

      await saveResult(job.id, 'Deep scrape completed', {
        seasonId: targetSeasonId,
        salespersons: salespeople.length,
        rowsUpserted: totalRowsUpserted,
        samples: resultSamples
      });
      await log(job.id, 'info', 'STEP:complete', { rows: totalRowsUpserted });
    } else {
      // Shallow scrape: navigate to Topseller table and extract rows
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
      const firstRowHtml = await page.$eval(`${tableSelector} tbody tr`, (tr) => (tr as HTMLElement).innerHTML);
      await log(job.id, 'info', 'First table row HTML', { html: (firstRowHtml || '').slice(0, 1000) });

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
      await setJobSucceeded(job.id);
      await log(job.id, 'info', 'Job succeeded');
    } catch (err: any) {
      const message = err?.message ?? String(err);
      await log(job.id, 'error', 'Job failed', { error: message });
      await setJobFailedOrRequeue(job, message);
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


