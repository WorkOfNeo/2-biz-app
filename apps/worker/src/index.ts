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
  return (data as any) ?? null;
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

    const toggles = (job.payload?.toggles as Record<string, any>) || {};
    const deep = Boolean(toggles.deep);

    if (deep) {
      // Placeholder deep scrape: visit a couple of sections and extract limited JSON
      await log(job.id, 'info', 'Starting deep scrape');
      await page.waitForTimeout(1500);
      const data = { sections: ['overview', 'details'], rowsCollected: 5 };
      await saveResult(job.id, 'Deep scrape placeholder complete', data);
    } else {
      // Placeholder shallow scrape: capture a few KPI texts
      await log(job.id, 'info', 'Starting shallow scrape');
      await page.waitForTimeout(1000);
      const data = { kpis: [{ key: 'visitors', value: '123' }, { key: 'sales', value: '45' }] };
      await saveResult(job.id, 'Shallow scrape placeholder complete', data);
    }
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

async function mainLoop() {
  // eslint-disable-next-line no-console
  console.log('[worker] started');

  while (true) {
    const job = await leaseNextJob();
    if (!job) {
      // eslint-disable-next-line no-console
      console.log('[worker] no jobs, sleeping');
      await sleep(2000);
      continue;
    }

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


