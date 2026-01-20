import dotenv from 'dotenv';
// Load environment variables from .env.local
dotenv.config({ path: '.env.local' });

// eslint-disable-next-line no-console
console.log('[worker] boot', { ts: new Date().toISOString() });

import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { JobRow, JobResult } from '@shared/types';
import { scrapeStyles, enrichStyles } from './jobs/scrapeStyles.js';
import { scrapeCustomers, applyCustomerScrapePreview } from './jobs/scrapeCustomers.js';
import { deepScrapeStyles as deepScrapeStylesJob } from './jobs/deepScrapeStyles.js';
import { exportOverview as exportOverviewJob } from './jobs/exportOverview.js';
import { exportTopStyles as exportTopStylesJob } from './jobs/exportTopStyles.js';
import { exportStockList as exportStockListJob } from './jobs/exportStockList.js';
import { exportSuppleringer as exportSuppleringerJob } from './jobs/exportSuppleringer.js';
import { scrapeTopStyles as scrapeTopStylesJob } from './jobs/scrapeTopStyles.js';
import { scrapeStatisticsPerSize } from './jobs/scrapeStatisticsPerSize.js';
import { fixInvoices as fixInvoicesJob } from './jobs/fixInvoices.js';
import { scrapePurchaseOrders as scrapePurchaseOrdersJob } from './jobs/scrapePurchaseOrders.js';
import { checkPurchaseOrders as checkPurchaseOrdersJob } from './jobs/checkPurchaseOrders.js';
import { checkStockFix as checkStockFixJob } from './jobs/checkStockFix.js';
import { scrapeEans as scrapeEansJob } from './jobs/scrapeEans.js';
import { pushAppPoToSpy } from './jobs/pushAppPoToSpy.js';
import { syncAppPoFromSpy } from './jobs/syncAppPoFromSpy.js';
import { createSpyStockOrder } from './jobs/createSpyStockOrder.js';
import { scrapeStyleRawCosts } from './jobs/scrapeStyleRawCosts.js';
import { scrapeXlsxSalesOrders } from './jobs/scrapeXlsxSalesOrders.js';
import { sendEmail } from './jobs/sendEmail.js';
import { analyzeConversationMessage } from './jobs/analyzeConversationMessage.js';
import { runAiAnalysis } from './jobs/runAiAnalysis.js';
import { exportAiAnalysis } from './jobs/exportAiAnalysis.js';
import { exportPurchaseRoundPdf } from './jobs/exportPurchaseRoundPdf.js';
import { runStatisticsEmailPipeline } from './jobs/runStatisticsEmailPipeline.js';
// (imported with .js extension above)

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS!;
const SPY_BASE_URL = process.env.SPY_BASE_URL!;
const SPY_USERNAME = process.env.SPY_USERNAME!;
const SPY_PASSWORD = process.env.SPY_PASSWORD!;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Copenhagen';
const JOB_QUEUE = process.env.JOB_QUEUE || 'default';

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

async function log(jobId: string, level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) {
  // Mirror to console for Railway logs
  try {
    // eslint-disable-next-line no-console
    console.log(`[job ${jobId}] [${level}] ${msg}`, data ?? '');
  } catch {}
  await supabase.from('job_logs').insert({ job_id: jobId, level, msg, data: data ?? null });
}

let lastErrorLogTime = 0;
const ERROR_LOG_THROTTLE_MS = 60_000; // Only log errors once per minute

async function leaseNextJob(): Promise<Nullable<JobRow>> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 60_000);
  try {
    const { data, error } = await supabase.rpc('lease_next_job', {
      p_now: now.toISOString(),
      p_lease_until: leaseUntil.toISOString(),
      p_queue: JOB_QUEUE
    });
    if (error) {
      // Throttle error logging to avoid spam
      const nowMs = Date.now();
      if (nowMs - lastErrorLogTime > ERROR_LOG_THROTTLE_MS) {
        lastErrorLogTime = nowMs;
        // eslint-disable-next-line no-console
        console.error('[worker] lease_next_job error', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          queue: JOB_QUEUE
        });
      }
      return null;
    }
    const row = (data as any) ?? null;
    // Treat null-id (nullable record) as no job available
    if (!row || !row.id) {
      // Check if there are jobs waiting for scheduled_for time
      const { data: waitingJobs } = await supabase
        .from('jobs')
        .select('id, type, scheduled_for, status')
        .eq('status', 'queued')
        .not('scheduled_for', 'is', null)
        .gt('scheduled_for', now.toISOString())
        .limit(5);
      
      if (waitingJobs && waitingJobs.length > 0) {
        const nextJob = waitingJobs[0];
        const waitTime = new Date(nextJob.scheduled_for).getTime() - now.getTime();
        // Only log every 30 seconds to avoid spam
        if (Date.now() % 30000 < 2000) {
          // eslint-disable-next-line no-console
          console.log(`[worker] No jobs ready. ${waitingJobs.length} job(s) waiting for scheduled time. Next: ${nextJob.type} at ${nextJob.scheduled_for} (in ${Math.round(waitTime / 1000)}s)`);
        }
      }
      return null;
    }
    
    // Log when we lease a job with scheduled_for
    if (row.scheduled_for) {
      const scheduledTime = new Date(row.scheduled_for);
      const delayMs = scheduledTime.getTime() - now.getTime();
      // eslint-disable-next-line no-console
      console.log(`[worker] Leased job ${row.id} (${row.type}) that was scheduled for ${row.scheduled_for} (${Math.round(delayMs / 1000)}s ${delayMs > 0 ? 'in future' : 'ago'})`);
    }
    
    return row as JobRow;
  } catch (err: any) {
    // Handle network errors (fetch failed, etc.)
    const nowMs = Date.now();
    if (nowMs - lastErrorLogTime > ERROR_LOG_THROTTLE_MS) {
      lastErrorLogTime = nowMs;
      // eslint-disable-next-line no-console
      console.error('[worker] lease_next_job network error', {
        message: err?.message || String(err),
        name: err?.name,
        queue: JOB_QUEUE
      });
    }
    return null;
  }
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

// Job types that don't require a browser
const BROWSERLESS_JOB_TYPES = new Set([
  'run_ai_analysis',
  'export_ai_analysis',
  'export_purchase_round_pdf',
  'send_email',
  'send_stock_list_email',
  'analyze_conversation_message',
  'fix_invoices',
  'apply_customer_preview',
  // Internal orchestration jobs
  'export_stock_list_after_update_stock',
  'run_statistics_email_pipeline'
]);

async function runJob(job: JobRow) {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Handle jobs that don't need a browser first
    if (BROWSERLESS_JOB_TYPES.has(job.type as string)) {
      await log(job.id, 'info', 'Running browser-less job');
      
      // Handle run_ai_analysis job
      if ((job.type as any) === 'run_ai_analysis') {
        const result = await runAiAnalysis(
          supabase,
          job.payload as any,
          async (level, msg, data) => log(job.id, level, msg, data)
        );
        if (result.success) {
          await saveResult(job.id, 'AI analysis completed', { analysisId: result.analysisId });
          await setJobSucceeded(job.id);
          
          // Enqueue PDF export job if analysis succeeded
          if (result.analysisId) {
            try {
              await supabase.from('jobs').insert({
                type: 'export_ai_analysis',
                payload: { analysisId: result.analysisId },
                status: 'queued',
                max_attempts: 2
              });
              await log(job.id, 'info', 'Enqueued PDF export job', { analysisId: result.analysisId });
            } catch (enqueueErr: any) {
              await log(job.id, 'error', 'Failed to enqueue PDF export', { error: enqueueErr.message });
            }
          }
        } else {
          await setJobFailedOrRequeue(job, result.error || 'AI analysis failed');
        }
        return;
      }
      
      // Handle export_ai_analysis job (PDF generation)
      if ((job.type as any) === 'export_ai_analysis') {
        // This job needs a page for Image loading in React-PDF (even if minimal)
        // But we can try without first - React-PDF can fetch images directly
        try {
          await exportAiAnalysis({
            job,
            page: null as any, // Not used for this job
            log: async (_, level, msg, data) => log(job.id, level, msg, data),
            saveResult,
            setJobFailedOrRequeue,
            setJobSucceeded,
            supabase
          });
        } catch (e: any) {
          await setJobFailedOrRequeue(job, e.message || 'Export failed');
        }
        return;
      }

      // Handle export_purchase_round_pdf job
      if ((job.type as any) === 'export_purchase_round_pdf') {
        try {
          await exportPurchaseRoundPdf({
            job,
            page: null as any, // Not used for this job
            log: async (_, level, msg, data) => log(job.id, level, msg, data),
            saveResult,
            setJobFailedOrRequeue,
            setJobSucceeded,
            supabase
          });
        } catch (e: any) {
          await setJobFailedOrRequeue(job, e.message || 'Export failed');
        }
        return;
      }

      // Handle analyze_conversation_message job
      if ((job.type as any) === 'analyze_conversation_message') {
        const result = await analyzeConversationMessage(
          supabase,
          job.payload as any,
          async (level, msg, data) => log(job.id, level, msg, data)
        );
        if (result.success) {
          await saveResult(job.id, 'Conversation analyzed', result);
          await setJobSucceeded(job.id);
        } else {
          await setJobFailedOrRequeue(job, result.error || 'Conversation analysis failed');
        }
        return;
      }

      // Handle send_email job
      if ((job.type as any) === 'send_email' || (job.type as any) === 'send_stock_list_email') {
        const result = await sendEmail(
          supabase,
          job.payload as any,
          async (level, msg, data) => log(job.id, level, msg, data)
        );
        if (result.success) {
          await setJobSucceeded(job.id);
        } else {
          await setJobFailedOrRequeue(job, result.message || 'Failed to send email');
        }
        return;
      }

      // Handle fix_invoices job
      if ((job.type as any) === 'fix_invoices') {
        await fixInvoicesJob({ job, log, saveResult, ensureNotCancelled, supabase });
        return;
      }

      // Handle apply_customer_preview job
      if ((job.type as any) === 'apply_customer_preview') {
        await applyCustomerScrapePreview({ job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase });
        return;
      }

      // Wait for update_style_stock batches to finish, then enqueue export_stock_list
      if ((job.type as any) === 'export_stock_list_after_update_stock') {
        const triggerJobId = String((job.payload as any)?.triggerJobId || '').trim();
        const requestedBy = (job.payload as any)?.requestedBy as string | undefined;
        const waitMs = Math.max(30_000, Number((job.payload as any)?.waitMs || 120_000) || 120_000);
        if (!triggerJobId) throw new Error('export_stock_list_after_update_stock missing payload.triggerJobId');

        // Find all update_style_stock jobs in this run (root + fan-out batches)
        const { data: stockJobs, error: stockJobsErr } = await supabase
          .from('jobs')
          .select('id,status')
          .eq('type', 'update_style_stock')
          .or(`id.eq.${triggerJobId},payload->>rootId.eq.${triggerJobId}`);
        if (stockJobsErr) throw new Error(`Failed to query update_style_stock jobs: ${stockJobsErr.message}`);

        const list = (stockJobs ?? []) as Array<{ id: string; status: string }>;
        const pending = list.filter((j) => j.status === 'queued' || j.status === 'running');
        if (pending.length > 0) {
          await log(job.id, 'info', 'WAITING:update_style_stock_batches', { triggerJobId, pending: pending.length });
          throw new Error('WAITING_FOR_UPDATE_STYLE_STOCK');
        }

        // Dedupe: only enqueue one export_stock_list per triggerJobId
        const { data: existingExport } = await supabase
          .from('jobs')
          .select('id,status,created_at')
          .eq('type', 'export_stock_list')
          .contains('payload', { triggerJobId })
          .order('created_at', { ascending: false })
          .limit(1);
        const existing = (existingExport ?? [])[0] as any | undefined;
        if (existing && (existing.status === 'queued' || existing.status === 'running' || existing.status === 'succeeded')) {
          await saveResult(job.id, 'Export stock list already enqueued for this stock update', { triggerJobId, existingJobId: existing.id, status: existing.status });
          return;
        }

        const { data: inserted, error: insErr } = await supabase
          .from('jobs')
          .insert({
            type: 'export_stock_list',
            payload: { requestedBy: requestedBy || 'after_update_stock', triggerJobId },
            status: 'queued',
            max_attempts: 3,
            queue: 'default',
            priority: 110,
          })
          .select('id')
          .single();
        if (insErr) throw new Error(`Failed to enqueue export_stock_list: ${insErr.message}`);

        await saveResult(job.id, 'Enqueued export_stock_list after update_style_stock', { triggerJobId, exportJobId: (inserted as any)?.id });
        return;
      }

      // Handle run_statistics_email_pipeline job
      if ((job.type as any) === 'run_statistics_email_pipeline') {
        await runStatisticsEmailPipeline(job, log, saveResult, setJobSucceeded, setJobFailedOrRequeue);
        return;
      }

      // If we get here, the job type was in the set but not handled
      throw new Error(`Unhandled browser-less job type: ${job.type}`);
    }

    // For browser-based jobs, connect to Browserless (silent)
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
      // Avoid waiting for Playwright's auto-wait navigation (which can hang on SPA redirects)
      await submitBtn.click({ timeout: 30_000, noWaitAfter: true });
    } else {
      await passInputLoc.press('Enter', { timeout: 30_000, noWaitAfter: true } as any);
    }

    // Post-login check markers
    const markers = ['.dashboard', 'nav[aria-label="main"]', '.user-menu', '.logout', '[data-testid="main-shell"]'];
    // Quicker post-login readiness check; do not block more than 20s
    await Promise.race(markers.map((m) => framePage.waitForSelector(m, { timeout: 20_000 }))).catch(() => null);
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
    await scrapeStyles({ job, page: page!, log, saveResult, ensureNotCancelled, captureHtmlSnippet, supabase, SPY_BASE_URL, findFirst });
    return;
  }
  if ((job.type as any) === 'enrich_styles') {
    await enrichStyles({ job, page: page!, log, saveResult, ensureNotCancelled, captureHtmlSnippet, supabase, SPY_BASE_URL, findFirst });
    return;
  }
  if ((job.type as any) === 'scrape_eans') {
    await scrapeEansJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL });
    return;
  }
  if (job.type === 'scrape_customers') {
    await scrapeCustomers({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL, findFirst });
    return;
  }
  // apply_customer_preview is now handled in browser-less section at the top
  if ((job.type as any) === 'push_app_po_to_spy') {
    await pushAppPoToSpy({ 
      job, 
      page: page!, 
      log, 
      saveResult, 
      setJobFailedOrRequeue: async (jobId: string, error: string) => setJobFailedOrRequeue(job, error), 
      setJobSucceeded, 
      ensureNotCancelled, 
      supabase, 
      SPY_BASE_URL 
    });
    return;
  }
  if ((job.type as any) === 'sync_app_po_from_spy') {
    await syncAppPoFromSpy({ 
      job, 
      page: page!, 
      log, 
      saveResult, 
      setJobFailedOrRequeue: async (jobId: string, error: string) => setJobFailedOrRequeue(job, error), 
      setJobSucceeded, 
      ensureNotCancelled, 
      supabase, 
      SPY_BASE_URL
    });
    return;
  }
  if ((job.type as any) === 'create_spy_stock_order') {
    await createSpyStockOrder({ 
      job, 
      page: page!, 
      log, 
      saveResult, 
      setJobFailedOrRequeue: async (jobId: string, error: string) => setJobFailedOrRequeue(job, error), 
      setJobSucceeded, 
      ensureNotCancelled, 
      supabase, 
      SPY_BASE_URL
    });
    return;
  }
  if ((job.type as any) === 'scrape_style_raw_costs') {
    await scrapeStyleRawCosts({ 
      job, 
      page: page!, 
      log, 
      saveResult, 
      setJobFailedOrRequeue, 
      setJobSucceeded, 
      ensureNotCancelled, 
      supabase, 
      SPY_BASE_URL
    });
    return;
  }
  if ((job.type as any) === 'scrape_xlsx_sales_orders') {
    await scrapeXlsxSalesOrders({ 
      job, 
      page: page!, 
      log, 
      saveResult, 
      setJobFailedOrRequeue: async (jobId: string, error: string) => setJobFailedOrRequeue(job, error), 
      setJobSucceeded, 
      ensureNotCancelled, 
      supabase, 
      SPY_BASE_URL
    });
    return;
  }

  if (job.type === 'update_style_stock') {
    await ensureNotCancelled(job.id);
    await log(job.id, 'info', 'STEP:style_stock_begin');
    // Expect payload.styleNos or derive from:
    // - payload.mode === 'all' → all styles in DB
    // - else union from app_settings.styles_user_selection
    // Fallback: legacy app_settings.styles_daily_selection
    let styleNos: string[] = Array.isArray(job.payload?.styleNos) ? (job.payload?.styleNos as string[]) : [];
    if (styleNos.length === 0) {
      try {
        if ((job.payload as any)?.mode === 'all') {
          const { data: rows } = await supabase.from('styles').select('style_no').limit(100000);
          styleNos = ((rows ?? []) as any[]).map((r) => String(r.style_no || '')).filter(Boolean);
        } else {
          // New per-user selection map: { [user_id]: string[] }
          const { data: sel } = await supabase.from('app_settings').select('value').eq('key', 'styles_user_selection').maybeSingle();
          const map = ((sel?.value as any) || {}) as Record<string, string[]>;
          const set = new Set<string>();
          for (const arr of Object.values(map)) {
            for (const no of (arr || [])) if (no && typeof no === 'string') set.add(no);
          }
          styleNos = Array.from(set);
          if (styleNos.length === 0) {
            // Legacy fallback
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
        styleNos = ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
          }
        }
      } catch {}
    }
    // Fan-out: split into chunks of ~30 and enqueue follow-up jobs for the remainder
    const BATCH_SIZE = Math.max(1, Number(process.env.STOCK_BATCH_SIZE || '30') || 30);
    const rootId: string = ((job.payload as any)?.rootId as string) || job.id;
    const currentBatchIndex: number = Number(((job.payload as any)?.batchIndex as number) || 1);
    if (styleNos.length > BATCH_SIZE) {
      const rest = styleNos.slice(BATCH_SIZE);
      const chunks: string[][] = [];
      for (let i = 0; i < rest.length; i += BATCH_SIZE) chunks.push(rest.slice(i, i + BATCH_SIZE));
      const batchTotal = 1 + chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          await supabase
            .from('jobs')
            .insert({ type: 'update_style_stock', payload: { styleNos: chunk, requestedBy: (job.payload as any)?.requestedBy, mode: (job.payload as any)?.mode, rootId, batchIndex: (currentBatchIndex + 1 + i), batchTotal }, status: 'queued', max_attempts: 3, queue: ((job as any)?.queue || 'default'), priority: ((job as any)?.priority ?? 100) });
        } catch {}
      }
      await log(job.id, 'info', 'STEP:style_stock_fanout', { batchSize: BATCH_SIZE, total: styleNos.length, enqueued: rest.length, rootId, batchIndex: currentBatchIndex, batchTotal });
      // Also log to the root job for easy frontend lookup
      if (currentBatchIndex === 1 && rootId === job.id) {
        await log(rootId, 'info', 'STEP:style_stock_total_requested', { totalRequested: styleNos.length, batchTotal });
      }
      styleNos = styleNos.slice(0, BATCH_SIZE);
    }
    // Log batch info for this job (even when <= BATCH_SIZE)
    try {
      const batchTotal = Math.ceil(Math.max(1, ((job.payload as any)?.totalCount as number) || styleNos.length) / BATCH_SIZE);
      await log(job.id, 'info', 'STEP:style_stock_batches', { rootId, batchIndex: currentBatchIndex, batchTotal, batchSize: BATCH_SIZE });
    } catch {}
    if (styleNos.length === 0) {
      await log(job.id, 'info', 'STEP:style_stock_no_selection');
      await saveResult(job.id, 'Style stock: no styles selected', { count: 0 });
      await log(job.id, 'info', 'STEP:complete', { upserted: 0 });
      return;
    }
    // Fetch style hrefs from styles table (exclude inactive styles)
    const { data: styles } = await supabase.from('styles').select('id, style_no, style_name, link_href, scrape_enabled, inactive').in('style_no', styleNos).eq('inactive', false);
    const totalStyles = (styles ?? []).length;
    const skippedInactive = styleNos.length - totalStyles;
    
    // Log the actual count after filtering (important for frontend progress calculation)
    await log(job.id, 'info', 'STEP:style_stock_filtered', { 
      requestedCount: styleNos.length, 
      activeCount: totalStyles, 
      skippedInactive, 
      rootId, 
      batchIndex: currentBatchIndex 
    });
    
    let processedStyles = 0;
    const startedAt = Date.now();
    const maxDurationMs = Math.max(0, Number((job.payload as any)?.maxDurationMs || process.env.STOCK_MAX_MS || 0) || 0);
    let totalRows = 0;
    // Pre-fetch all style_colors to eliminate N+1 queries (optimization: 1 query instead of N)
    const styleIds = (styles ?? []).map((s: any) => s.id).filter(Boolean);
    let allStyleColors = new Map<string, Map<string, boolean>>(); // styleId -> (colorKey -> scrapeEnabled)
    if (styleIds.length > 0) {
      try {
        const { data: allColors } = await supabase
          .from('style_colors')
          .select('style_id, color, scrape_enabled')
          .in('style_id', styleIds);
        for (const c of (allColors ?? []) as any[]) {
          const sid = c.style_id;
          if (!allStyleColors.has(sid)) allStyleColors.set(sid, new Map());
          const key = String(c.color || '').trim().toLowerCase();
          if (key) allStyleColors.get(sid)!.set(key, c.scrape_enabled !== false);
        }
      } catch {}
    }
    for (const s of (styles ?? []) as any[]) {
      processedStyles++;
      const styleName = (s as any)?.style_name || null;
      // Log every 10 styles or on last style (optimization: reduce log writes by 90%)
      if (processedStyles % 10 === 0 || processedStyles === totalStyles) {
        await log(job.id, 'info', 'STEP:update_style_stock_progress', { 
          index: processedStyles, 
          total: totalStyles, 
          percent: Math.round((processedStyles / totalStyles) * 100),
          style_no: s.style_no, 
          style_name: styleName 
        });
      }
      if (maxDurationMs > 0 && (Date.now() - startedAt) > maxDurationMs) {
        await log(job.id, 'info', 'STEP:style_stock_timeout', { processed: processedStyles, total: totalStyles, ms: Date.now() - startedAt });
        break;
      }
      await ensureNotCancelled(job.id);
      
      // IMMEDIATELY delete ALL existing stock rows for this style (before any other logic)
      // Note: We keep style_stock_movements history intact
      console.log(`[updateStyleStock] Deleting all style_stock rows for style: ${s.style_no}`);
      await log(job.id, 'info', 'STEP:style_stock_delete_all_start', { style_no: s.style_no });
      try {
        // First, count existing rows
        const { count: existingCount } = await supabase.from('style_stock').select('*', { count: 'exact', head: true }).eq('style_no', s.style_no);
        const stockRowCount = existingCount || 0;
        
        // Delete all style_stock rows (Stock, Sold, Purchase, etc.)
        const { error: delErr } = await supabase.from('style_stock').delete().eq('style_no', s.style_no);
        if (delErr) throw new Error(`style_stock delete failed: ${delErr.message}`);
        
        console.log(`[updateStyleStock] Deleted ${stockRowCount} style_stock rows for style: ${s.style_no}`);
        await log(job.id, 'info', 'STEP:style_stock_delete_all_success', { 
          style_no: s.style_no, 
          rows_deleted: stockRowCount
        });
      } catch (e: any) {
        console.error(`[updateStyleStock] Exception deleting data for ${s.style_no}:`, e?.message || String(e));
        await log(job.id, 'error', 'STEP:style_stock_delete_all_error', { style_no: s.style_no, error: e?.message || String(e) });
      }
      
      const styleStart = Date.now();
      const href = (s.link_href || '').toString();
      if (!href) continue;
      // Respect style-level scrape toggle when present
      const styleId: string | null = (s.id as string | undefined) || null;
      const styleScrapeEnabled: boolean = (s as any)?.scrape_enabled !== false;
      if (!styleScrapeEnabled) {
        await log(job.id, 'info', 'STEP:style_stock_skip_style_disabled', { style_no: s.style_no });
        continue;
      }
      // Note: stock_all_zeros flag is ONLY for badge display, NOT for controlling scraping
      // Only scrape_enabled (manual control) determines whether to scrape
      // Use pre-fetched color data (optimization: no query in loop)
      let allowedColors: Record<string, boolean> = {};
      if (styleId && allStyleColors.has(styleId)) {
        const colorMap = allStyleColors.get(styleId)!;
        for (const [key, enabled] of colorMap.entries()) {
          allowedColors[key] = enabled;
        }
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
      // Ensure statAndStockDetails present with fast exit when missing
      try {
        await page!.waitForSelector('.statAndStockDetails', { timeout: 25_000, state: 'attached' as any });
      } catch (e: any) {
        let forced = 0;
        try {
          forced = await page!.evaluate(() => {
            let shown = 0;
            document.querySelectorAll('.statAndStockBox table[style*="display: none"]').forEach((t) => { (t as HTMLElement).style.display = 'table'; shown++; });
            return shown;
          });
        } catch {}
        try { await log(job.id, 'info', 'STEP:style_stock_force_show', { tablesShown: forced }); } catch {}
        if (!forced) {
          try {
            const html = await captureHtmlSnippet(page, page!);
            await log(job.id, 'info', 'STEP:style_stock_missing_skip', { style_no: s.style_no, html });
          } catch {}
          // Flag style to skip in future scrapes
          if (styleId) {
            try {
              await supabase.from('styles').update({ stock_all_zeros: true }).eq('id', styleId);
              await log(job.id, 'info', 'STEP:style_stock_flag_missing_skip', { style_no: s.style_no, style_id: styleId });
            } catch (err: any) {
              await log(job.id, 'error', 'STEP:style_stock_flag_error', { style_no: s.style_no, error: err?.message || String(err) });
            }
          }
          continue; // skip quickly when nothing to show
        }
        try {
          await page!.waitForTimeout(300);
          await page!.waitForSelector('.statAndStockDetails', { timeout: 5_000, state: 'attached' as any });
        } catch {}
        // If still no details, log and continue
        try {
        const html = await captureHtmlSnippet(page, page!);
        await log(job.id, 'error', 'STEP:style_stock_missing', { style_no: s.style_no, error: e?.message || String(e), html });
        } catch {}
        // Flag style to skip in future scrapes
        if (styleId) {
          try {
            await supabase.from('styles').update({ stock_all_zeros: true }).eq('id', styleId);
            await log(job.id, 'info', 'STEP:style_stock_flag_missing', { style_no: s.style_no, style_id: styleId });
          } catch (err: any) {
            await log(job.id, 'error', 'STEP:style_stock_flag_error', { style_no: s.style_no, error: err?.message || String(err) });
          }
        }
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
        function normalizeLabel(label: string): string { return (label || '').replace(/\s+/g, ' ').trim().toUpperCase(); }
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
            // Purchase block rows rules:
            // - Skip sum lines (NOOS, Total PO (Run + Ship))
            // - Do not save .stylecolor-expanded--main (titles); only .stylecolor-expanded--sub
            // - Capture PO link from main row and propagate to sub rows
            // - Skip non-dedicated sub when followed by a dedicated sub
            // - De-duplicate by normalized (row_label + po_link)
            if (inPurchase) {
              const isSumRow = /^NOOS$/i.test(label) || /^Total\s+PO\s*\(/i.test(label);
              if (isSumRow) { continue; }
              if (cls.includes('stylecolor-expanded--main')) {
                const headingLinkA = rowEl.querySelector('a[href*="purchase_orders.php"]') as HTMLAnchorElement | null;
                const headingLink = headingLinkA ? (headingLinkA.getAttribute('href') || null) : null;
                if (headingLink) { lastPurchaseHeading = { label: label || 'Row', link: headingLink }; }
                continue;
              }
              if (cls.includes('stylecolor-expanded--sub')) {
                const isDedicatedLabel = /(Stock\s+Dedicated|Pre\s+Dedicated)/i.test(label);
                if (isDedicatedLabel) { continue; }
                let po_link: string | null = null;
              const poA = rowEl.querySelector('a[href*="purchase_orders.php"]') as HTMLAnchorElement | null;
                po_link = poA ? (poA.getAttribute('href') || null) : null;
                if (!po_link && lastPurchaseHeading) po_link = lastPurchaseHeading.link;
                const key = normalizeLabel(label || 'Row') + '|' + String(po_link || '');
                if (seenPurchase.has(key)) { continue; }
                seenPurchase.add(key);
                out.push({ color, sizes: sizeLabels, section: 'Purchase (Running + Shipped)', row_label: label || 'Row', values: numbersFromRow(tds), po_link });
              continue;
              }
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
          // Removed verbose STEP:style_stock_parsed log (Phase 2 optimization)
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
      // Timestamp for this style scrape batch
      const scrapeTs = new Date().toISOString();
      // Compute diffs vs existing before bulk upsert for overview logs
      let diffEntries: Array<{ color: string; section: string; row_label: string; size: string; from: number; to: number }> = [];
      let stockMovements: Array<{ style_no: string; color: string; size: string; prev_value: number; value: number; delta: number; scraped_at: string; job_id: string; kind: string }> = [];
        try {
          const { data: existingRows } = await supabase
          .from('style_stock')
          .select('color, section, row_label, sizes, values')
          .eq('style_no', s.style_no)
          .limit(20000);
        const existingMap = new Map<string, { sizes: string[]; values: number[] }>();
        for (const r of (existingRows ?? []) as any[]) {
          const key = `${String(r.color||'')}|${String(r.section||'')}|${String(r.row_label||'')}`;
          existingMap.set(key, { sizes: (r.sizes as string[]|undefined) ?? [], values: (r.values as number[]|undefined) ?? [] });
        }
        for (const row of extracted) {
          const key = `${row.color}|${row.section}|${row.row_label||''}`;
          const prev = existingMap.get(key);
          if (!prev) continue;
          const prevVals = Array.isArray(prev.values) ? prev.values : [];
          const sizes = Array.isArray(row.sizes) ? row.sizes : (prev.sizes || []);
          const newVals = Array.isArray(row.values) ? row.values : [];
          const len = Math.min(newVals.length, prevVals.length, sizes.length);
          for (let i = 0; i < len; i++) {
            const a = Number(prevVals[i] ?? 0);
            const b = Number(newVals[i] ?? 0);
            if (a !== b) {
              diffEntries.push({ color: row.color, section: row.section, row_label: row.row_label || '', size: String(sizes[i] ?? String(i)), from: a, to: b });
              // Persist movements only for physical Stock section
              // Record movement kinds by section
              if (row.section === 'Stock') {
                stockMovements.push({ style_no: s.style_no, color: row.color, size: String(sizes[i] ?? String(i)), prev_value: a, value: b, delta: (b - a), scraped_at: scrapeTs, job_id: job.id, kind: 'stock' });
              } else if (row.section === 'Sold') {
                stockMovements.push({ style_no: s.style_no, color: row.color, size: String(sizes[i] ?? String(i)), prev_value: a, value: b, delta: (b - a), scraped_at: scrapeTs, job_id: job.id, kind: 'sold' });
              } else if (row.section === 'Purchase (Running + Shipped)') {
                stockMovements.push({ style_no: s.style_no, color: row.color, size: String(sizes[i] ?? String(i)), prev_value: a, value: b, delta: (b - a), scraped_at: scrapeTs, job_id: job.id, kind: 'purchase' });
              }
              if (diffEntries.length >= 50) break; // limit per style
            }
          }
          if (diffEntries.length >= 50) break;
        }
      } catch {}
      // Bulk upsert extracted rows to reduce roundtrips
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
      // Deduplicate by conflict key to avoid ON CONFLICT affecting the same row twice
      const dedupMap = new Map<string, any>();
      for (const r of payload) {
        const key = `${r.style_no}|${r.color}|${r.section}|${r.row_label}`;
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
      const styleMs = Date.now() - styleStart;
      await log(job.id, 'info', 'STEP:style_stock_style_done', { style_no: s.style_no, style_name: styleName, rows: deduped.length, ms: styleMs });
      if (diffEntries && diffEntries.length) {
        try { await log(job.id, 'info', 'STEP:style_stock_changes', { style_no: s.style_no, style_name: styleName, count: diffEntries.length, sample: diffEntries.slice(0, 25) }); } catch {}
      }
      if (stockMovements.length) {
        try { await supabase.from('style_stock_movements').insert(stockMovements); } catch {}
      }
      // Update style_stock_totals for fast check_stock_fix comparisons
      try {
        await supabase.rpc('update_style_stock_total', { p_style_no: s.style_no });
      } catch (e: any) {
        // Non-fatal: totals table may not exist yet during migration period
        // Will be populated via refresh_all_style_stock_totals() after migration
      }
      // Check per-color if all values across all sections are 0 and update maybe_inactive flag
      try {
        // Group extracted rows by color
        const colorMap = new Map<string, any[]>();
        for (const row of extracted) {
          const color = String(row.color || '').trim().toLowerCase();
          if (!colorMap.has(color)) colorMap.set(color, []);
          colorMap.get(color)!.push(row);
        }
        // Check each color
        for (const [colorKey, colorRows] of colorMap.entries()) {
          const allZero = colorRows.every((row: any) => {
            const values = row.values || [];
            return values.every((v: any) => Number(v) === 0);
          });
          // Find the style_color_id for this color
          if (styleId) {
            const { data: styleColor } = await supabase
              .from('style_colors')
              .select('id')
              .eq('style_id', styleId)
              .ilike('color', colorKey)
              .maybeSingle();
            if (styleColor?.id) {
              await supabase.from('style_colors').update({ maybe_inactive: allZero }).eq('id', styleColor.id);
              // Removed verbose per-color logging (Phase 2 optimization)
              // maybe_inactive flag is updated silently in database
            }
          }
        }
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:style_inactive_check_error', { style_no: s.style_no, error: e?.message || String(e) });
      }
      // Removed redundant STEP:style_stock_rows log (row count included in style_stock_style_done)
    }
    
    // Trigger check-stock-fix job only for full/selected runs (not checker runs) and only from root job
    const isRootJob = rootId === job.id;
    const requestedBy = (job.payload as any)?.requestedBy as string | undefined;
    const mode = (job.payload as any)?.mode as string | undefined;
    const isFullOrSelectedRun = mode === 'all' || (requestedBy && requestedBy !== 'checker' && requestedBy !== 'check-stock-fix');
    
    if (isRootJob && isFullOrSelectedRun && currentBatchIndex === 1) {
      // Check if check_stock_fix has already been enqueued for this root job
      const { data: existingCheckJob } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', 'check_stock_fix')
        .contains('payload', { triggerJobId: rootId })
        .maybeSingle();
      
      if (!existingCheckJob) {
        try {
          await log(job.id, 'info', 'STEP:check_stock_fix_enqueuing', { rootId, mode, requestedBy });
          
          // Enqueue check_stock_fix job (lower priority so other batches complete first)
          await supabase
            .from('jobs')
            .insert({
              type: 'check_stock_fix',
              payload: {
                triggerJobId: rootId,
                mode,
                requestedBy,
              },
              status: 'queued',
              max_attempts: 2,
              queue: 'default',
              priority: 80, // Lower priority so it runs after other batches
            });
          
          await log(job.id, 'info', 'STEP:check_stock_fix_enqueued', { rootId });
        } catch (e: any) {
          await log(job.id, 'error', 'STEP:check_stock_fix_enqueue_failed', { error: e?.message || String(e) });
        }
      } else {
        await log(job.id, 'info', 'STEP:check_stock_fix_already_enqueued', { existingJobId: existingCheckJob.id });
      }
    }

    // Always export stock lists after full/selected stock update runs.
    // Note: update_style_stock is a fan-out job. We enqueue a small waiter job that will
    // wait until all batches (root + payload.rootId fan-outs) are done before enqueuing export_stock_list once.
    if (isRootJob && isFullOrSelectedRun && currentBatchIndex === 1) {
      try {
        const { data: existingFollowup } = await supabase
          .from('jobs')
          .select('id,status')
          .eq('type', 'export_stock_list_after_update_stock')
          .contains('payload', { triggerJobId: rootId })
          .in('status', ['queued', 'running'])
          .maybeSingle();
        if (!existingFollowup) {
          const { data: followup, error: followErr } = await supabase
            .from('jobs')
            .insert({
              type: 'export_stock_list_after_update_stock',
              payload: { triggerJobId: rootId, requestedBy: requestedBy || 'after_update_stock', waitMs: 120_000 },
              status: 'queued',
              max_attempts: 120, // ~4 hours at 2-min intervals
              queue: 'default',
              priority: 90,
            })
            .select('id')
            .single();
          if (!followErr) {
            await log(job.id, 'info', 'STEP:export_stock_list_after_enqueued', { triggerJobId: rootId, followupJobId: (followup as any)?.id });
          } else {
            await log(job.id, 'error', 'STEP:export_stock_list_after_insert_error', { error: followErr.message, triggerJobId: rootId });
          }
        } else {
          await log(job.id, 'info', 'STEP:export_stock_list_after_already_enqueued', { triggerJobId: rootId, existingJobId: (existingFollowup as any)?.id });
        }
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:export_stock_list_after_enqueue_failed', { error: e?.message || String(e), triggerJobId: rootId });
      }
    }
    
    await saveResult(job.id, 'Style stock scrape completed', { totalRows });
    await log(job.id, 'info', 'STEP:complete', { totalRows });
    return;
  }
  if (job.type === 'deep_scrape_styles') {
    await deepScrapeStylesJob({ job, page: page!, log, saveResult, ensureNotCancelled, supabase, SPY_BASE_URL });
      return;
    }
  if (job.type === 'scrape_statistics') {
    // Route: when explicitly requested (kind === 'per_size'), run per-size snapshot.
    // Otherwise, allow the deep/shallow statistics block below (toggled by payload.toggles.deep) to execute.
    const kind = (job.payload as any)?.kind as string | undefined;
    if (kind === 'per_size') {
      await scrapeStatisticsPerSize({
        job,
        page: page!,
        log,
        saveResult,
        setJobFailedOrRequeue,
        setJobSucceeded,
        ensureNotCancelled,
        captureHtmlSnippet,
        supabase,
        SPY_BASE_URL,
      });
      return;
    }
    // fall through to deep/shallow stats handling when not per_size
  }
  if (job.type === 'export_overview') {
    await exportOverviewJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase });
    return;
  }
  if ((job.type as any) === 'export_stock_list') {
    await exportStockListJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase });
    return;
  }
  if ((job.type as any) === 'export_top_styles') {
    await exportTopStylesJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase });
    return;
  }
  if ((job.type as any) === 'export_suppleringer') {
    await exportSuppleringerJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase });
    return;
  }
  if ((job.type as any) === 'scrape_top_styles') {
    await scrapeTopStylesJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase });
    return;
  }
  // fix_invoices is now handled in browser-less section at the top
  if ((job.type as any) === 'scrape_purchase_orders') {
    await scrapePurchaseOrdersJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase });
    return;
  }
  if ((job.type as any) === 'check_purchase_orders') {
    await checkPurchaseOrdersJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase });
    return;
  }
  if ((job.type as any) === 'check_stock_fix') {
    await checkStockFixJob({ job, page: page!, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL, findFirst });
    return;
  }
  /* LEGACY export_overview handler (disabled)
    try {
      await log(job.id, 'info', 'STEP:export_overview_begin', job.payload || {});
      // React-PDF export for General (zipped)
      if ((job.payload as any)?.mode === 'general_react_pdf') {
        const s1 = (job.payload as any)?.s1 as string | undefined;
        const s2 = (job.payload as any)?.s2 as string | undefined;
        // Fallback to season_compare
        let season1 = s1 || '';
        let season2 = s2 || '';
        try {
          if (!season1 || !season2) {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle();
            season1 = season1 || ((data?.value as any)?.s1 as string || '');
            season2 = season2 || ((data?.value as any)?.s2 as string || '');
          }
        } catch {}
        // Aggregate a simple snapshot similar to General
        let s1Qty = 0, s1Price = 0, s2Qty = 0, s2Price = 0;
        try {
          const { data: rows } = await supabase
            .from('sales_stats')
            .select('season_id, qty, price')
            .in('season_id', [season1, season2]);
          for (const r of (rows ?? []) as any[]) {
            if (r.season_id === season1) { s1Qty += Number(r.qty || 0); s1Price += Number(r.price || 0); }
            else if (r.season_id === season2) { s2Qty += Number(r.qty || 0); s2Price += Number(r.price || 0); }
          }
        } catch {}
        const styles = StyleSheet.create({
          page: { padding: 24 },
          h1: { fontSize: 18, marginBottom: 8 },
          p: { fontSize: 12, marginBottom: 4 }
        });
        const doc = React.createElement(
          Document,
          null,
          React.createElement(
            PdfPage,
            { size: 'A4', style: styles.page },
            React.createElement(Text, { style: styles.h1 }, 'General Export'),
            React.createElement(Text, { style: styles.p }, `Season 1 Qty: ${String(s1Qty)}`),
            React.createElement(Text, { style: styles.p }, `Season 1 Price: ${String(Math.round(s1Price))}`),
            React.createElement(Text, { style: styles.p }, `Season 2 Qty: ${String(s2Qty)}`),
            React.createElement(Text, { style: styles.p }, `Season 2 Price: ${String(Math.round(s2Price))}`),
            React.createElement(Text, { style: styles.p }, `Generated: ${new Date().toLocaleString()}`)
          )
        );
        const pdfBuf = await pdf(doc).toBuffer();
        // Zip it
        const zip = new JSZip();
        zip.file('general.pdf', pdfBuf);
        const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
        const path = `general/${job.id}/general.zip`;
        try { await supabase.storage.from('exports').upload(path, zipBuf as any, { contentType: 'application/zip', upsert: true }); } catch {}
        let publicUrl: string | null = null;
        try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
        try { await supabase.from('exports').insert({ kind: 'general_pdf_zip', title: 'General', path, public_url: publicUrl, meta: { s1: season1, s2: season2 }, job_id: job.id }); } catch {}
        await saveResult(job.id, 'export_general_pdf_zip', { file: { path, publicUrl } });
        await setJobSucceeded(job.id);
        return;
      }
      // React-PDF export for General per-salesperson (zipped, matches page semantics)
      if ((job.payload as any)?.mode === 'general_salesmen_react_pdf') {
        const getSeasonCompare = async (): Promise<{ s1: string | null; s2: string | null }> => {
          const body = { s1: (job.payload as any)?.s1 as string | undefined, s2: (job.payload as any)?.s2 as string | undefined };
          if (body.s1 && body.s2) return { s1: body.s1, s2: body.s2 };
          try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle(); return { s1: (data?.value as any)?.s1 ?? null, s2: (data?.value as any)?.s2 ?? null }; } catch { return { s1: null, s2: null }; }
        };
        const { s1, s2 } = await getSeasonCompare();
        if (!s1 || !s2) throw new Error('Missing season compare (s1/s2)');
        // Fetch salespersons (with currency)
        const { data: people } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
        const list = (people ?? []) as Array<{ id: string; name: string; currency?: string | null }>;
        // Currency rates and season names
        let rates: Record<string, number> = { DKK: 1 };
        try { const { data: rateRow } = await supabase.from('app_settings').select('value').eq('key', 'currency_rates').maybeSingle(); rates = { DKK: 1, ...((rateRow?.value as any) ?? {}) } as Record<string, number>; } catch {}
        const seasonNames = async (id: string | null): Promise<string | null> => {
          if (!id) return null;
          try {
            const { data } = await supabase.from('seasons').select('name, year').eq('id', id).maybeSingle();
            if (!data) return null;
            const n = (data as any).name as string | null;
            const y = (data as any).year as number | null;
            return n ? (y ? `${n} ${y}` : n) : null;
          } catch { return null; }
        };
        const s1Name = await seasonNames(s1);
        const s2Name = await seasonNames(s2);
        const total = list.length;
        const zip = new JSZip();
        const filesList: Array<{ name: string; path: string; publicUrl: string | null }> = [];
        const pagesAll: any[] = [];
        let idx = 0;
        for (const sp of list) {
          idx++;
          // Log progress
          await log(job.id, 'info', 'STEP:export_general_progress', { index: idx, total, name: sp.name });
          // Fetch customers for salesperson
          const { data: customers } = await supabase.from('customers').select('customer_id, company, city, nulled, excluded, permanently_closed').eq('salesperson_id', sp.id);
          const items = (customers ?? []) as Array<{ customer_id: string; company: string | null; city: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null }>;
          // Seasonal overrides (hidden/nulled)
          let hiddenSet = new Set<string>(); let nulledSet = new Set<string>();
          try {
            const key = `season_overrides:${s1}`;
            const { data: ov } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
            const val = (ov?.value as any) || {};
            (Array.isArray(val.hidden) ? val.hidden : []).forEach((a: string) => hiddenSet.add(a));
            (Array.isArray(val.nulled) ? val.nulled : []).forEach((a: string) => nulledSet.add(a));
          } catch {}
          const accountNos = items.map((c) => c.customer_id).filter(Boolean);
          let rows: Array<{ account: string; company: string; city: string; nulled: boolean; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>= [];
          if (accountNos.length) {
            const statResp = await supabase
              .from('sales_stats')
              .select('account_no, qty, price, season_id')
              .in('season_id', [s1, s2])
              .in('account_no', accountNos)
              .limit(200000);
            const statRows: Array<{ account_no: string | null; qty: number | null; price: number | null; season_id: string }>
              = ((statResp as any)?.data ?? []) as any[];
            const map = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>();
            for (const rowItem of statRows) {
              const key = String(rowItem.account_no || ''); if (!key) continue;
              const agg = map.get(key) || { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
              if (rowItem.season_id === s1) { agg.s1Qty += Number(rowItem.qty||0); agg.s1Price += Number(rowItem.price||0); }
              else if (rowItem.season_id === s2) { agg.s2Qty += Number(rowItem.qty||0); agg.s2Price += Number(rowItem.price||0); }
              map.set(key, agg);
            }
            for (const c of items) {
              const agg = map.get(c.customer_id);
              const isHidden = hiddenSet.has(c.customer_id) || Boolean(c.excluded);
              if (!agg || isHidden) continue;
              const isNulled = nulledSet.has(c.customer_id) || Boolean(c.nulled) || Boolean(c.permanently_closed);
              rows.push({ account: c.customer_id, company: c.company || '-', city: c.city || '-', nulled: isNulled, ...agg });
            }
            // Sort by company name for readability
            rows.sort((a,b)=> a.company.localeCompare(b.company));
          }
          // Build PDF for this salesperson
          const styles = StyleSheet.create({
            page: { padding: 16, fontSize: 8, color: '#0f172a' },
            h1: { fontSize: 14, marginBottom: 2, color: '#0f172a' },
            small: { fontSize: 8, color: '#64748b', marginBottom: 6, fontWeight: 700 },
            tableHeaderGlobal: { flexDirection: 'row', backgroundColor: '#eaeaea', color: '#000000', borderBottom: 0.5, borderColor: '#bfdbfe' },
            tableHeader: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff', borderBottom: 0.5, borderColor: '#bfdbfe' },
            headerCell: { padding: 4, fontSize: 9, fontWeight: 700 },
            row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
            rowAlt: { backgroundColor: '#f1f5f9' },
            mutedRow: { opacity: 0.5 },
            cell: { padding: 4, fontSize: 8 },
            left: { textAlign: 'left' },
            right: { textAlign: 'right' },
            strike: { textDecoration: 'line-through', color: '#64748b' },
            green: { color: '#16a34a' },
            red: { color: '#dc2626' }
          });
          const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) => React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : styles.right, extra || {}] }, txt);
          const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
          // Group header row
          const groupHeader = React.createElement(View, { style: styles.tableHeaderGlobal },
            Cell('KUNDE', '45%', 'left', styles.headerCell),
            Cell(s1Name ?? 'S1', '20%', 'right', styles.headerCell),
            Cell(s2Name ?? 'S2', '20%', 'right', styles.headerCell),
            Cell('Forskel', '15%', 'right', styles.headerCell)
          );
          // Headers below global
          const header = React.createElement(View, { style: styles.tableHeader },
            Cell('Kunde', '30%', 'left', styles.headerCell),
            Cell('By', '15%', 'left', styles.headerCell),
            Cell('Stk', '8%', 'right', styles.headerCell),
            Cell('Oms', '12%', 'right', styles.headerCell),
            Cell('Stk', '8%', 'right', styles.headerCell),
            Cell('Oms', '12%', 'right', styles.headerCell),
            Cell('Stk', '7%', 'right', styles.headerCell),
            Cell('Oms', '8%', 'right', styles.headerCell)
          );
          const body = rows.map((r, i) => {
            const devQty = r.s1Qty - r.s2Qty; const devPrice = r.s1Price - r.s2Price;
            const devQtyStyle = devQty >= 0 ? styles.green : styles.red;
            const devPriceStyle = devPrice >= 0 ? styles.green : styles.red;
            const baseRow = i % 2 === 1 ? [styles.row, styles.rowAlt] : [styles.row];
            const rowStyle = r.nulled ? [...baseRow, styles.mutedRow] : baseRow;
            const nameStyle = r.nulled ? styles.strike : undefined;
            const s1QtyStyle = r.s1Qty === 0 ? undefined : (r.s1Qty > r.s2Qty ? styles.green : r.s1Qty < r.s2Qty ? styles.red : undefined);
            const s1PriceStyle = r.s1Price === 0 ? undefined : (r.s1Price > r.s2Price ? styles.green : r.s1Price < r.s2Price ? styles.red : undefined);
            return React.createElement(View, { style: rowStyle },
              Cell(r.company, '30%', 'left', nameStyle),
              Cell(r.city, '15%', 'left', nameStyle),
              Cell(String(r.s1Qty), '8%', 'right', s1QtyStyle),
              Cell(fmt(r.s1Price), '12%', 'right', s1PriceStyle),
              Cell(String(r.s2Qty), '8%', 'right'),
              Cell(fmt(r.s2Price), '12%', 'right'),
              Cell((devQty>0?'+':'')+String(devQty), '7%', 'right', r.nulled ? [devQtyStyle, styles.strike] : devQtyStyle),
              Cell((devPrice>0?'+':'')+fmt(devPrice), '8%', 'right', r.nulled ? [devPriceStyle, styles.strike] : devPriceStyle)
            );
          });
          // Totals (local currency and DKK)
          const totals = rows.reduce((a, r) => ({ s1Qty: a.s1Qty + r.s1Qty, s2Qty: a.s2Qty + r.s2Qty, s1Price: a.s1Price + r.s1Price, s2Price: a.s2Price + r.s2Price }), { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 });
          const currency = (sp.currency || 'DKK').toUpperCase();
          const rate = rates[currency] ?? 1;
          const totalsDkk = { s1: totals.s1Price * rate, s2: totals.s2Price * rate };
          const totalsLocal = { s1: totals.s1Price, s2: totals.s2Price };
          const totalsView = React.createElement(View, { style: { marginTop: 6 } },
            React.createElement(Text, { style: { fontSize: 10, fontWeight: 700, marginBottom: 3 } }, 'TOTALS'),
            React.createElement(View, { style: styles.tableHeader },
              Cell('', '45%', 'left', styles.headerCell),
              Cell(`${s1Name ?? 'S1'} (${currency})`, '22%', 'right', styles.headerCell),
              Cell(`${s2Name ?? 'S2'} (${currency})`, '22%', 'right', styles.headerCell),
              Cell('Diff', '11%', 'right', styles.headerCell)
            ),
            React.createElement(View, { style: styles.row },
              Cell('Local', '45%', 'left'),
              Cell(fmt(totalsLocal.s1), '22%', 'right'),
              Cell(fmt(totalsLocal.s2), '22%', 'right'),
              Cell(((totalsLocal.s1 - totalsLocal.s2) > 0 ? '+' : '') + fmt(totalsLocal.s1 - totalsLocal.s2), '11%', 'right')
            ),
            React.createElement(View, { style: [styles.row, styles.rowAlt] },
              Cell('DKK', '45%', 'left'),
              Cell(fmt(totalsDkk.s1), '22%', 'right'),
              Cell(fmt(totalsDkk.s2), '22%', 'right'),
              Cell(((totalsDkk.s1 - totalsDkk.s2) > 0 ? '+' : '') + fmt(totalsDkk.s1 - totalsDkk.s2), '11%', 'right')
            )
          );
          const pageEl = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
            React.createElement(Text, { style: styles.h1 }, `${sp.name}`),
            React.createElement(Text, { style: styles.small }, `${s1Name ?? 'S1'} vs ${s2Name ?? 'S2'}`),
            groupHeader,
            header,
            ...body,
            totalsView
          );
          const doc = React.createElement(Document, null, pageEl);
          const buf = await pdf(doc).toBuffer();
          const safeName = (sp.name || 'salesperson').replace(/[^a-z0-9_-]+/gi, '_');
          zip.file(`${safeName}.pdf`, buf);
          // Upload individual PDF
          try {
            const indivPath = `general/${job.id}/salesmen/${safeName}.pdf`;
            await supabase.storage.from('exports').upload(indivPath, buf as any, { contentType: 'application/pdf', upsert: true });
            let indivUrl: string | null = null;
            try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(indivPath); indivUrl = pub?.publicUrl ?? null; } catch {}
            filesList.push({ name: sp.name, path: indivPath, publicUrl: indivUrl });
          } catch {}
          // Accumulate for combined document
          pagesAll.push(pageEl);
        }
        const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
        const path = `general/${job.id}/salesmen.zip`;
        try { await supabase.storage.from('exports').upload(path, zipBuf as any, { contentType: 'application/zip', upsert: true }); } catch {}
        let publicUrl: string | null = null;
        try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
        // Combined all.pdf
        let allPath: string | null = null; let allUrl: string | null = null;
        try {
          const allDoc = React.createElement(Document, null, ...pagesAll);
          const allBuf = await pdf(allDoc).toBuffer();
          allPath = `general/${job.id}/salesmen/all.pdf`;
          await supabase.storage.from('exports').upload(allPath, allBuf as any, { contentType: 'application/pdf', upsert: true });
          try { const { data: pub2 } = supabase.storage.from('exports').getPublicUrl(allPath); allUrl = pub2?.publicUrl ?? null; } catch {}
        } catch {}
        try { await supabase.from('exports').insert({ kind: 'general_salesmen_zip', title: 'General · Salesmen', path, public_url: publicUrl, meta: { files: filesList, all: { path: allPath, publicUrl: allUrl } }, job_id: job.id }); } catch {}
        await saveResult(job.id, 'export_general_salesmen_zip', { file: { path, publicUrl } });
        await setJobSucceeded(job.id);
        await log(job.id, 'info', 'STEP:complete');
    return;
  }
      // Export Countries PDF via print route (no sidebar) when requested
      if ((job.payload as any)?.mode === 'countries_pdf') {
        const ctx = await browser!.newContext({ viewport: { width: 1200, height: 1600 } });
        const page = await ctx.newPage();
        const webBase = (process.env.WEB_ORIGIN || '').replace(/\/$/, '');
        const url = `${webBase}/statistics/countries/print`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
        await log(job.id, 'info', 'STEP:export_countries_print_nav', { url });
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        const path = `countries/${job.id}/countries.pdf`;
        try {
          await supabase.storage.from('exports').upload(path, pdf as any, { contentType: 'application/pdf', upsert: true });
        } catch {}
        let publicUrl: string | null = null;
        try { const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); publicUrl = pub?.publicUrl ?? null; } catch {}
        await ctx.close();
        await saveResult(job.id, 'export_countries_pdf', { file: { path, publicUrl } });
        try { await supabase.from('exports').insert({ kind: 'countries_pdf', title: 'Countries', path, public_url: publicUrl, meta: {}, job_id: job.id }); } catch {}
        await setJobSucceeded(job.id);
        return;
      }
      // Default: export Overview PDFs
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

  */
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
      function normDate(raw: string): string | null {
        const t = (raw || '').trim();
        if (!t) return null;
        // Accept formats like dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd
        const m1 = t.match(/^(\d{1,2})[\.\/-](\d{1,2})[\.\/-](\d{2,4})$/);
        if (m1) {
          const d = String(m1[1]).padStart(2, '0');
          const m = String(m1[2]).padStart(2, '0');
          let y = String(m1[3]);
          if (y.length === 2) y = '20' + y;
          return `${y}-${m}-${d}`;
        }
        const m2 = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m2) {
          const y = m2[1];
          const m = String(m2[2]).padStart(2, '0');
          const d = String(m2[3]).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
        return null;
      }
      const out: { spyId: string; label: string; parsed: { yy: number; name: string } | null; start?: string | null; end?: string | null }[] = [];
      for (const tr of Array.from(trs)) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
        const a = tds[1]?.querySelector('a[href*="season_id="]') as HTMLAnchorElement | null;
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/season_id=(\d+)/);
        const spyId: string = (m?.[1] ?? '') + '';
        const label = (a.textContent || '').trim();
        const startRaw = (tds[2]?.textContent || '').trim();
        const endRaw = (tds[3]?.textContent || '').trim();
        out.push({ spyId, label, parsed: parseSeason(label), start: normDate(startRaw), end: normDate(endRaw) });
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
        // Fallback: match by plain name + year (handles overridden names without year suffix)
        if (!existingId) {
          try {
            const baseName = String(r.parsed.name || '').trim();
            if (baseName && year) {
              const { data: byNameYear } = await supabase
                .from('seasons')
                .select('id')
                .ilike('name', baseName)
                .eq('year', year)
                .maybeSingle();
              existingId = (byNameYear?.id as string | undefined) || null;
            }
          } catch {}
        }
        // Fallback: match by source_name (scraped) either full display or base name + year
        if (!existingId) {
          try {
            const { data: bySourceFull } = await supabase.from('seasons').select('id').ilike('source_name', displayName).maybeSingle();
            existingId = (bySourceFull?.id as string | undefined) || null;
          } catch {}
        }
        if (!existingId) {
          try {
            const baseName = String(r.parsed.name || '').trim();
            if (baseName && year) {
              const { data: bySourceNameYear } = await supabase
                .from('seasons')
                .select('id')
                .ilike('source_name', baseName)
                .eq('year', year)
                .maybeSingle();
              existingId = (bySourceNameYear?.id as string | undefined) || null;
            }
          } catch {}
        }

        const start_date = (r as any).start || null;
        const end_date = (r as any).end || null;

        if (!existingId) {
          // Safety: do not create new season rows when we don't have a spy_season_id; just log and skip
          if (!spyIdNum) {
            await log(job.id, 'info', 'STEP:seasons_skip_insert_no_spy_id', { displayName, year });
          } else {
            const insertRow: Record<string, any> = { name: displayName, source_name: sourceName, year, spy_season_id: spyIdNum };
            if (start_date) insertRow.start_date = start_date;
            if (end_date) insertRow.end_date = end_date;
            const { error: insErr } = await supabase.from('seasons').insert(insertRow);
            if (insErr) throw insErr;
            upserted++;
          }
        } else {
          // Update spy_season_id if missing, and keep source_name up to date
          const updates: Record<string, any> = {};
          if (spyIdNum) updates.spy_season_id = spyIdNum;
          updates.source_name = sourceName;
          if (start_date) updates.start_date = start_date;
          if (end_date) updates.end_date = end_date;
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

    // Handle scrape_statistics job type (deep or shallow mode)
    if (job.type === 'scrape_statistics') {
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
            // Skip non-season buckets like PACKSHOTS or NOOS entirely (never create/match)
            const upperName = name.toUpperCase();
            const isNonSeason = upperName.includes('PACKSHOTS') || upperName === 'NOOS';
            if (isNonSeason) {
              await log(job.id, 'info', 'STEP:season_skip_nonseason', { label: seasonInfo.text, value: seasonInfo.value });
              return;
            }
            // Try to resolve season robustly without creating duplicates
            let resolvedId: string | null = null;
            // 1) spy_season_id from page value (preferred)
            if (spySeasonId) {
              try {
                const spyNum = Number(spySeasonId) || null;
                if (spyNum) {
                  const { data: bySpy } = await supabase.from('seasons').select('id').eq('spy_season_id', spyNum).maybeSingle();
                  resolvedId = (bySpy?.id as string | undefined) || null;
                }
              } catch {}
            }
            // 2) name ilike "NAME YEAR"
            if (!resolvedId) {
              try {
                const { data: byName } = await supabase.from('seasons').select('id').ilike('name', displayName).maybeSingle();
                resolvedId = (byName?.id as string | undefined) || null;
              } catch {}
            }
            // 3) name ilike "NAME" AND year=YYYY
            if (!resolvedId) {
              try {
                const { data: byNameYear } = await supabase.from('seasons').select('id').ilike('name', name).eq('year', year).maybeSingle();
                resolvedId = (byNameYear?.id as string | undefined) || null;
              } catch {}
            }
            // 4) source_name ilike "NAME YEAR"
            if (!resolvedId) {
              try {
                const { data: bySource } = await supabase.from('seasons').select('id').ilike('source_name', displayName).maybeSingle();
                resolvedId = (bySource?.id as string | undefined) || null;
              } catch {}
            }
            // 5) source_name ilike "NAME" AND year=YYYY
            if (!resolvedId) {
              try {
                const { data: bySourceYear } = await supabase.from('seasons').select('id').ilike('source_name', name).eq('year', year).maybeSingle();
                resolvedId = (bySourceYear?.id as string | undefined) || null;
              } catch {}
            }
            if (resolvedId) {
              targetSeasonId = resolvedId;
              // If we have a spySeasonId and the matched season lacks it, set it now to lock future matches
              try {
                if (spySeasonId && Number(spySeasonId)) {
                  const spyNum = Number(spySeasonId);
                  const { data: cur } = await supabase.from('seasons').select('spy_season_id, source_name').eq('id', resolvedId).maybeSingle();
                  const curSpy = (cur?.spy_season_id as number | null) ?? null;
                  if (!curSpy) {
                    const updates: Record<string, any> = { spy_season_id: spyNum };
                    updates.source_name = displayName;
                    await supabase.from('seasons').update(updates).eq('id', resolvedId);
                  }
                }
              } catch {}
            } else {
              // Only create if we have a spy_season_id to map uniquely; otherwise skip creation
              if (spySeasonId && Number(spySeasonId)) {
                const insertRow: any = { name: displayName, year, spy_season_id: Number(spySeasonId), source_name: displayName };
                // Mark BASIC seasons hidden by default when created
                if (/^BASIC\s*-/i.test(name)) insertRow.hidden = true;
                try {
                  const { data: ins, error: insErr } = await supabase.from('seasons').insert(insertRow).select('id').single();
                  if (!insErr) targetSeasonId = (ins as any)?.id as string;
                } catch {}
              }
            }
            await log(job.id, 'info', 'STEP:season_selected', { label: seasonInfo.text, seasonName: displayName, seasonId: targetSeasonId });
          }
        } catch {}
      }

      if (!targetSeasonId) throw new Error('seasonId could not be determined');

      // Check if the target season is frozen (marked complete) - skip all writes if so
      {
        const { data: seasonCheck } = await supabase
          .from('seasons')
          .select('is_frozen')
          .eq('id', targetSeasonId)
          .maybeSingle();
        if ((seasonCheck as any)?.is_frozen) {
          await log(job.id, 'info', 'STEP:skipped_frozen_season', { seasonId: targetSeasonId, reason: 'Season is marked as Complete. No writes performed.' });
          await saveResult(job.id, 'Skipped: season is frozen (marked complete)', { seasonId: targetSeasonId });
          await setJobSucceeded(job.id);
          return;
        }
      }

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
      const perSalespersonCounts: Array<{ salesperson: string; created: number; updated: number; unchanged: number }> = [];
      // Collect SPY customer IDs for style details bulk download (when enabled)
      const styleDetailsCustomerMap: Map<string, string> = new Map(); // spyCustomerId -> accountNo
      for (const sp of salespeople) {
        await ensureNotCancelled(job.id);
        processed++;
        await log(job.id, 'info', 'STEP:salesperson_start', { index: processed, total: salespeople.length, name: sp.name });
        const url = toAbs(sp.href);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await ensureNotCancelled(job.id);

        // Wait briefly for the single table and at least 1 row; skip quickly if none
        try { await page.waitForSelector('table', { timeout: 2000 }); } catch {}
        let hasRows = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          await ensureNotCancelled(job.id);
          try {
            const cnt = await page.$$eval('table tbody tr', (trs) => trs.length);
            if (cnt > 0) { hasRows = true; break; }
          } catch {}
          await page.waitForTimeout(1000);
        }
        if (!hasRows) {
          await log(job.id, 'error', 'STEP:salesperson_timeout', { name: sp.name, reason: 'no_rows_after_5s' });
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
          function extractSpyCustomerId(tr: HTMLTableRowElement, customerColIdx: number): string {
            // Try to extract SPY customer_id from the customer cell's anchor href
            const td = tr.querySelectorAll('td')[customerColIdx] as HTMLElement | undefined;
            if (!td) return '';
            const anchor = td.querySelector('a') as HTMLAnchorElement | null;
            if (!anchor) return '';
            const href = anchor.getAttribute('href') || '';
            const match = href.match(/customer_id=(\d+)/);
            return match && match[1] ? match[1] : '';
          }
          const out: { customer: string; account: string; country: string; qty: string; amount: string; salesperson: string; spyCustomerId: string }[] = [];
          for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
            out.push({
              customer: idx.customer >= 0 ? cellText(tr, idx.customer) : '',
              account: idx.account >= 0 ? cellText(tr, idx.account) : '',
              country: idx.country >= 0 ? cellText(tr, idx.country) : '',
              qty: idx.qty >= 0 ? cellText(tr, idx.qty) : '0',
              amount: idx.amountCus >= 0 ? cellText(tr, idx.amountCus) : '0',
              salesperson: idx.salesperson >= 0 ? cellText(tr, idx.salesperson) : '',
              spyCustomerId: idx.customer >= 0 ? extractSpyCustomerId(tr, idx.customer) : ''
            });
          }
          return out;
        }, idx as any);

        // Upsert rows into DB
        const salespersonId = await ensureSalespersonId(sp.name);
        let upsertedForSp = 0;
        let createdCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
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
          // Collect SPY customer ID for style details (when toggle enabled)
          if (r.spyCustomerId && accountNo) {
            styleDetailsCustomerMap.set(r.spyCustomerId, accountNo);
          }
          // Ensure customer exists
          const customerUuid = await ensureCustomerIdByAccount(accountNo, { company: customerName || null, country: country || null, salesperson_id: salespersonId });
          // Determine existing state for comparison
          let existingRow: { id: string; qty: number; price: number; currency: string | null; frozen?: boolean } | null = null;
          try {
            const { data: existing } = await supabase
              .from('sales_stats')
              .select('id, qty, price, currency, frozen')
              .eq('season_id', targetSeasonId)
              .eq('account_no', accountNo)
              .maybeSingle();
            existingRow = (existing as any) || null;
          } catch {}
          // Skip updates when row is frozen
          if (existingRow && (existingRow as any).frozen) { unchangedCount++; continue; }
          const hasChange = !existingRow || (Number(existingRow.qty || 0) !== qty) || (Number(existingRow.price || 0) !== price) || ((existingRow.currency || null) !== (currency || null));
          if (!hasChange) {
            unchangedCount++;
            continue;
          }
          if (existingRow) {
            const { error: updErr } = await supabase
              .from('sales_stats')
              .update({ qty, price, currency: currency || null, customer_id: customerUuid, customer_name: customerName || null, salesperson_id: salespersonId, salesperson_name: sp.name })
              .eq('id', (existingRow as any).id);
            if (updErr) throw updErr;
            updatedCount++;
            upsertedForSp++;
            if (upsertedRowsForLog.length < 10) {
              upsertedRowsForLog.push({ account: accountNo, customer: customerName, qty, price, currency: currency || null, op: 'updated' });
            }
          } else {
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
            const { error: insErr } = await supabase.from('sales_stats').insert(insertRow);
            if (insErr) throw insErr;
            createdCount++;
          upsertedForSp++;
          if (upsertedRowsForLog.length < 10) {
              upsertedRowsForLog.push({ account: accountNo, customer: customerName, qty, price, currency: currency || null, op: 'created' });
            }
          }
          // If customer has sales data (qty or price > 0), remove nulled flag
          if ((qty > 0 || price > 0) && customerUuid && accountNo) {
            try {
              const { data: customer } = await supabase.from('customers').select('nulled, customer_id').eq('id', customerUuid).maybeSingle();
              let wasNulled = false;
              
              // Un-null in customers table if nulled
              if (customer?.nulled) {
                await supabase.from('customers').update({ nulled: false }).eq('id', customerUuid);
                wasNulled = true;
                await log(job.id, 'info', 'STEP:customer_unnulled', { account: accountNo, customer: customerName });
              }
              
              // Also remove from seasonal overrides nulled list if present (even if not nulled in customers table)
              if (targetSeasonId) {
                try {
                  const key = `season_overrides:${targetSeasonId}`;
                  const { data: seasonOverrides } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
                  if (seasonOverrides) {
                    const val = (seasonOverrides.value as any) || {};
                    const existingNulled: string[] = Array.isArray(val.nulled) ? val.nulled : [];
                    const hidden: string[] = Array.isArray(val.hidden) ? val.hidden : [];
                    // Remove this account from the nulled list
                    const updatedNulled = existingNulled.filter((acc: string) => acc !== accountNo);
                    if (updatedNulled.length !== existingNulled.length) {
                      const next = { nulled: updatedNulled, hidden };
                      await supabase.from('app_settings').update({ value: next }).eq('id', seasonOverrides.id as any);
                      await log(job.id, 'info', 'STEP:customer_removed_from_seasonal_nulled', { account: accountNo, customer: customerName, wasNulledInTable: wasNulled });
                    }
                  }
                } catch (e) {
                  // Non-critical, just log
                  await log(job.id, 'info', 'STEP:seasonal_unnull_failed', { account: accountNo, error: String(e) });
                }
              }
            } catch (e) {
              // Non-critical, just log
              await log(job.id, 'info', 'STEP:unnull_failed', { account: accountNo, error: String(e) });
            }
          }
        }
        totalRowsUpserted += upsertedForSp;
        await log(job.id, 'info', 'STEP:salesperson_done', { index: processed, total: salespeople.length, upserted: upsertedForSp, name: sp.name, rows: upsertedRowsForLog });
        perSalespersonCounts.push({ salesperson: sp.name, created: createdCount, updated: updatedCount, unchanged: unchangedCount });
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
        // Always force season and set UTM source (iSearchID) to the season number we check
        const base = spySeasonIdParam && spySeasonIdParam.trim().length > 0
          ? `?controller=Sale%5CInvoiced&action=List&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BbForceSearch%5D=true&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BiSeasonID%5D=${encodeURIComponent(spySeasonIdParam)}&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BiSearchID%5D=${encodeURIComponent(spySeasonIdParam)}&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BstrOrderType%5D=pre`
          : `?controller=Sale%5CInvoiced&action=List&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BbForceSearch%5D=true&Spy%5CModel%5CSale%5CInvoiced%5CInvoicedReportSearch%5BstrOrderType%5D=pre`;
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
            await page!.evaluate((label: string | null) => {
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

        // Wait for the results table; skip gracefully if none within ~5s
        {
          let found = false;
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              const cnt = await page!.$$eval('table.standardList tbody tr', (trs) => trs.length);
              if (cnt > 0) { found = true; break; }
            } catch {}
            await page!.waitForTimeout(1000);
          }
          if (!found) {
            await log(job.id, 'error', 'STEP:invoiced_no_rows_skip');
            return [];
          }
        await log(job.id, 'info', 'STEP:invoiced_ready');
        }

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
      let invoicedLines: Array<{ customerName: string; qty: number; userCurrencyAmount: { amount: number; currency: string | null } | null; customerCurrencyAmount: { amount: number; currency: string | null } | null; invoiceNo?: string; invoiceDate?: string; matchedCustomerId?: string | null; matchedAccount?: string | null; salespersonName?: string | null; }>= [];
      if (!spySeasonId) {
        await log(job.id, 'info', 'STEP:invoiced_skipped_no_spy_id', { targetSeasonId });
      } else {
        invoicedLines = await scrapeInvoicedLines(targetSeasonId, spySeasonId);
      }

      // Persist invoices idempotently: UPDATE existing unless frozen, else INSERT; add detailed logging
      try {
        const t0 = Date.now();
        const scraped = invoicedLines
          .map((inv) => {
          const accountNo = (inv.matchedAccount || '').trim();
            const invoiceNo = (inv.invoiceNo || '').trim();
          // Prefer customer currency (local) over user currency (DKK)
          const pick = inv.customerCurrencyAmount || inv.userCurrencyAmount;
            const qty = Number(inv.qty || 0) || 0;
          const amount = Number(pick?.amount || 0) || 0;
            const currency = pick?.currency || null;
            if (!accountNo || !invoiceNo) return null;
            return { accountNo, invoiceNo, qty, amount, currency, customerName: inv.customerName || null, invoiceDate: inv.invoiceDate || null };
          })
          .filter(Boolean) as Array<{ accountNo: string; invoiceNo: string; qty: number; amount: number; currency: string | null; customerName: string | null; invoiceDate: string | null }>;
        await log(job.id, 'info', 'STEP:invoiced_normalized', { total: scraped.length });

        // Prefetch existing for season to avoid N queries
        const { data: existingAll, error: exErr } = await supabase
            .from('sales_invoices')
          .select('id, account_no, invoice_no, qty, amount, currency, manual_edited')
          .eq('season_id', targetSeasonId)
          .limit(100000);
        if (exErr) throw exErr;
        const existingMap = new Map<string, { id: string; qty: number; amount: number; currency: string | null; manual_edited: boolean }>();
        for (const r of (existingAll ?? []) as any[]) {
          existingMap.set(`${r.account_no}|${r.invoice_no}`, { id: r.id as string, qty: Number(r.qty || 0) || 0, amount: Number(r.amount || 0) || 0, currency: r.currency || null, manual_edited: Boolean(r.manual_edited) });
        }

        const toInsert: any[] = [];
        const toUpdate: Array<{ id: string; values: { qty: number; amount: number; currency: string | null; customer_name: string | null; invoice_date: string | null } }> = [];
        let skippedFrozen = 0;
        let unchanged = 0;
        for (const inv of scraped) {
          const key = `${inv.accountNo}|${inv.invoiceNo}`;
          const existing = existingMap.get(key) || null;
          if (existing) {
            if (existing.manual_edited) {
              skippedFrozen++;
              continue;
            }
            const needsUpdate = existing.qty !== inv.qty || existing.amount !== inv.amount || (existing.currency || null) !== (inv.currency || null);
            if (needsUpdate) {
              toUpdate.push({ id: existing.id, values: { qty: inv.qty, amount: inv.amount, currency: inv.currency, customer_name: inv.customerName, invoice_date: inv.invoiceDate } });
          } else {
              unchanged++;
            }
          } else {
            toInsert.push({
              season_id: targetSeasonId,
              account_no: inv.accountNo,
              customer_name: inv.customerName,
              qty: inv.qty,
              amount: inv.amount,
              currency: inv.currency,
              invoice_no: inv.invoiceNo,
              invoice_date: inv.invoiceDate
            });
          }
        }

        // Bulk insert
        if (toInsert.length) {
          const { error: insErr } = await supabase.from('sales_invoices').insert(toInsert);
            if (insErr) throw insErr;
          }
        // Apply updates (per-id)
        for (const u of toUpdate) {
          const { error: updErr } = await supabase.from('sales_invoices').update(u.values).eq('id', u.id);
          if (updErr) throw updErr;
        }
        const dt = Date.now() - t0;
        await log(job.id, 'info', 'STEP:invoiced_rows_persisted', {
          inserted: toInsert.length,
          updated: toUpdate.length,
          skippedFrozen,
          unchanged,
          ms: dt,
          sampleInsert: toInsert[0] || null,
          sampleUpdate: toUpdate[0] || null
        });
      } catch (e: any) {
        await log(job.id, 'error', 'STEP:invoiced_rows_persist_error', { error: e?.message || String(e) });
      }

      // Do not adjust TopSeller (sales_stats) with invoice deltas; keep separate sources
      try { await log(job.id, 'info', 'STEP:invoiced_adjustments_skipped'); } catch {}

      // ========== STYLE DETAILS SCRAPE (opt-in via toggles.style_details) ==========
      const styleDetailsEnabled = Boolean((job.payload as any)?.toggles?.style_details);
      if (styleDetailsEnabled && styleDetailsCustomerMap.size > 0 && spySeasonId) {
        await log(job.id, 'info', 'STEP:style_details_begin', { customerCount: styleDetailsCustomerMap.size, spySeasonId });
        try {
          // Get list of already-scraped customers for this season
          const { data: alreadyScrapedData } = await supabase
            .from('sales_style_details_scraped')
            .select('account_no, force_rescrape')
            .eq('season_id', targetSeasonId);
          
          const alreadyScraped = new Map<string, boolean>();
          for (const row of (alreadyScrapedData ?? []) as any[]) {
            alreadyScraped.set(row.account_no, row.force_rescrape === true);
          }

          // Filter: only scrape customers that are new OR have force_rescrape = true
          const allSpyCustomerIds: string[] = [];
          const accountNosToScrape: string[] = [];
          for (const [spyId, accountNo] of styleDetailsCustomerMap.entries()) {
            const wasScraped = alreadyScraped.has(accountNo);
            const forceRescrape = alreadyScraped.get(accountNo) === true;
            if (!wasScraped || forceRescrape) {
              allSpyCustomerIds.push(spyId);
              accountNosToScrape.push(accountNo);
            }
          }

          await log(job.id, 'info', 'STEP:style_details_filter', { 
            total: styleDetailsCustomerMap.size, 
            alreadyScraped: alreadyScraped.size,
            toScrape: allSpyCustomerIds.length,
            forceRescrape: Array.from(alreadyScraped.values()).filter(v => v).length
          });

          if (allSpyCustomerIds.length === 0) {
            await log(job.id, 'info', 'STEP:style_details_skip_all_scraped', { reason: 'All customers already scraped' });
          } else {
            // Delete existing style details for customers we're about to re-scrape
            for (const accountNo of accountNosToScrape) {
              await supabase
                .from('sales_style_details_rows')
                .delete()
                .eq('season_id', targetSeasonId)
                .eq('account_no', accountNo);
            }
          const chunkSize = 100;
          const chunks: string[][] = [];
          for (let i = 0; i < allSpyCustomerIds.length; i += chunkSize) {
            chunks.push(allSpyCustomerIds.slice(i, i + chunkSize));
          }
          await log(job.id, 'info', 'STEP:style_details_chunks', { totalCustomers: allSpyCustomerIds.length, chunks: chunks.length });

          let totalStyleRows = 0;
          for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            await ensureNotCancelled(job.id);
            const chunk = chunks[chunkIdx];
            if (!chunk || chunk.length === 0) continue;
            const customerIdsParam = chunk.join(',');
            // Build the download URL (prefer CSV for fast parsing)
            const downloadUrl = new URL(`modules/s_orders.add/download_styles_details.php`, SPY_BASE_URL);
            downloadUrl.searchParams.set('type', 'csv');
            downloadUrl.searchParams.set('customer_ids', customerIdsParam);
            downloadUrl.searchParams.set('season_id', spySeasonId);
            downloadUrl.searchParams.set('delivery_id', '0');

            await log(job.id, 'info', 'STEP:style_details_chunk_download', { chunkIdx: chunkIdx + 1, totalChunks: chunks.length, customers: chunk.length });

            try {
              // Fetch CSV content via page context (authenticated session)
              const csvContent = await page.evaluate(async (url: string) => {
                const resp = await fetch(url, { credentials: 'include' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return await resp.text();
              }, downloadUrl.toString());

              if (!csvContent || csvContent.trim().length === 0) {
                await log(job.id, 'info', 'STEP:style_details_chunk_empty', { chunkIdx: chunkIdx + 1 });
                continue;
              }

              // Parse CSV (simple split - assumes no embedded commas/quotes in data)
              const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
              if (lines.length < 2) {
                await log(job.id, 'info', 'STEP:style_details_chunk_no_data', { chunkIdx: chunkIdx + 1, lines: lines.length });
                continue;
              }

              // Parse header to find column indices
              const headerLine = lines[0];
              if (!headerLine) continue;
              // Helper to strip surrounding quotes from CSV values
              const stripQuotes = (s: string): string => {
                const trimmed = s.trim();
                if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
                  return trimmed.slice(1, -1).trim();
                }
                return trimmed;
              };
              const headers = headerLine.split(';').map((h) => stripQuotes(h).toLowerCase());
              const colIdx = {
                accountNo: headers.findIndex((h) => h.includes('account') || h.includes('konto')),
                styleNo: headers.findIndex((h) => h === 'style no' || h === 'style_no' || h === 'styleno' || h.includes('style no')),
                styleName: headers.findIndex((h) => h === 'style name' || h === 'style_name' || h === 'stylename' || h.includes('style name')),
                quality: headers.findIndex((h) => h === 'quality' || h.includes('quality')),
                color: headers.findIndex((h) => h === 'color' || h === 'colour' || h.includes('color')),
                size: headers.findIndex((h) => h === 'size' || h.includes('size')),
                qty: headers.findIndex((h) => h === 'qty' || h === 'quantity' || h.includes('qty')),
                barcode: headers.findIndex((h) => h === 'barcode' || h === 'ean' || h.includes('barcode'))
              };

              await log(job.id, 'info', 'STEP:style_details_headers', { headers: headers.slice(0, 15), colIdx });

              // Parse data rows
              const rowsToInsert: Array<{
                season_id: string;
                account_no: string;
                style_no: string;
                style_name: string | null;
                quality: string | null;
                color: string | null;
                size: string | null;
                qty: number;
                barcode: string | null;
                scraped_at: string;
              }> = [];

              for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                // Parse cells and strip quotes from each value
                const cells = line.split(';').map((c) => stripQuotes(c));
                const styleNo = colIdx.styleNo >= 0 ? cells[colIdx.styleNo] || '' : '';
                if (!styleNo) continue; // Skip rows without style number

                // Try to find account_no from CSV or fall back to mapping
                let accountNo = colIdx.accountNo >= 0 ? cells[colIdx.accountNo] || '' : '';
                // If CSV doesn't have account column, we can't reliably map back
                // For now, log and skip if we can't determine account
                if (!accountNo) {
                  // This shouldn't happen if the CSV includes customer info
                  continue;
                }

                rowsToInsert.push({
                  season_id: targetSeasonId,
                  account_no: accountNo,
                  style_no: styleNo,
                  style_name: colIdx.styleName >= 0 ? cells[colIdx.styleName] || null : null,
                  quality: colIdx.quality >= 0 ? cells[colIdx.quality] || null : null,
                  color: colIdx.color >= 0 ? cells[colIdx.color] || null : null,
                  size: colIdx.size >= 0 ? cells[colIdx.size] || null : null,
                  qty: colIdx.qty >= 0 ? (Number((cells[colIdx.qty] || '0').replace(/[^0-9.\-]/g, '')) || 0) : 0,
                  barcode: colIdx.barcode >= 0 ? cells[colIdx.barcode] || null : null,
                  scraped_at: new Date().toISOString()
                });
              }

              // Batch insert (1000 at a time)
              for (let bi = 0; bi < rowsToInsert.length; bi += 1000) {
                const batch = rowsToInsert.slice(bi, bi + 1000);
                const { error: insErr } = await supabase.from('sales_style_details_rows').insert(batch as any);
                if (insErr) {
                  await log(job.id, 'error', 'STEP:style_details_insert_error', { error: insErr.message, batchStart: bi });
                }
              }

              totalStyleRows += rowsToInsert.length;
              // Log sample account_no values for debugging
              const sampleAccounts = Array.from(new Set(rowsToInsert.slice(0, 10).map(r => r.account_no)));
              await log(job.id, 'info', 'STEP:style_details_chunk_done', { chunkIdx: chunkIdx + 1, rowsInserted: rowsToInsert.length, sampleAccounts });
            } catch (e: any) {
              await log(job.id, 'error', 'STEP:style_details_chunk_error', { chunkIdx: chunkIdx + 1, error: e?.message || String(e) });
            }
          }

          await log(job.id, 'info', 'STEP:style_details_complete', { totalRows: totalStyleRows });

            // Record which customers were scraped (upsert to preserve first_scraped_at)
            for (const accountNo of accountNosToScrape) {
              const { data: existing } = await supabase
                .from('sales_style_details_scraped')
                .select('id')
                .eq('season_id', targetSeasonId)
                .eq('account_no', accountNo)
                .maybeSingle();
              
              if (existing) {
                // Already exists - just reset force_rescrape flag
                await supabase
                  .from('sales_style_details_scraped')
                  .update({ force_rescrape: false })
                  .eq('id', existing.id);
              } else {
                // New record - insert with first_scraped_at
                await supabase
                  .from('sales_style_details_scraped')
                  .insert({
                    season_id: targetSeasonId,
                    account_no: accountNo,
                    first_scraped_at: new Date().toISOString(),
                    force_rescrape: false
                  });
              }
            }
            await log(job.id, 'info', 'STEP:style_details_tracking_saved', { customersTracked: accountNosToScrape.length });
          }
        } catch (e: any) {
          await log(job.id, 'error', 'STEP:style_details_error', { error: e?.message || String(e) });
        }
      } else if (styleDetailsEnabled) {
        await log(job.id, 'info', 'STEP:style_details_skipped', { reason: styleDetailsCustomerMap.size === 0 ? 'no_customers' : 'no_spy_season_id' });
      }
      // ========== END STYLE DETAILS SCRAPE ==========

      await saveResult(job.id, 'Deep scrape completed', {
        seasonId: targetSeasonId,
        salespersons: salespeople.length,
        rowsUpserted: totalRowsUpserted,
        samples: resultSamples,
        parsed: { topseller: topsellerDump, invoiced: { count: invoicedLines.length, lines: invoicedLines } },
        perSalesperson: perSalespersonCounts
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
      return; // scrape_statistics handled successfully
    }

    // If we reach here, the job type was not handled (browser-less jobs are handled earlier)
    throw new Error(`Unknown or unhandled job type: ${job.type}`);
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
  console.log('[worker] started v2.9 - auto-detect out_of_collection from SPY stats', new Date().toISOString());
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

    // eslint-disable-next-line no-console
    console.log(`[worker] Leased job ${job.id}`, {
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      scheduled_for: (job as any).scheduled_for || null,
      payload: job.payload
    });

    const heartbeat = setInterval(() => updateJobHeartbeat(job.id).catch(() => {}), 45_000);
    try {
      await runJob(job);
    // Check if job was cancelled during run; if so, avoid marking as succeeded
    if (await isJobCancelled(job.id)) {
      await log(job.id, 'info', 'Job cancelled (post-run check)');
    } else {
      // Check if job already updated itself (e.g., pipeline jobs manage their own status)
      const { data: currentJob } = await supabase.from('jobs').select('status').eq('id', job.id).single();
      if (currentJob?.status === 'running') {
        // Only set succeeded if job is still running (hasn't self-managed its status)
        await setJobSucceeded(job.id);
      }
    }
    } catch (err: any) {
      const message = err?.message ?? String(err);
    if (err?.name === 'CancelledError' || message === 'JOB_CANCELLED') {
      await log(job.id, 'info', 'Job cancelled by request');
      await setJobCancelled(job.id, 'Stopped by staff');
    } else if (message.startsWith('WAITING_')) {
      // Silent requeue for pipeline waits - no error logging
      await setJobFailedOrRequeue(job, message);
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

// deploy bump 2025-11-18
// redeploy bump 2025-11-18T2
// redeploy bump 2025-12-01 - customer scrape with detailed logging
// redeploy bump 2025-12-01T2 - extensive step-by-step debugging logs
// redeploy bump 2025-12-19 - fix scrape_statistics infinite retry loop (missing return)

