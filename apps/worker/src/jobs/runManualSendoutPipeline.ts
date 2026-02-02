/**
 * Manual Send-Out Pipeline
 * 
 * Triggered from the dashboard's "Send out" section.
 * 
 * If scrapeFirst=true:
 *   1. Enqueues scrape_statistics + update_style_stock
 *   2. Waits for scrapes to complete
 *   3. Enqueues export jobs
 *   4. Waits for exports to complete
 *   5. Sends emails
 * 
 * If scrapeFirst=false:
 *   - Skips directly to sending emails using latest exports
 * 
 * Always sends TWO types of emails:
 *   - Statistics emails (personal PDF for salespersons, global PDFs for all)
 *   - Stock list emails (separate email, can be heavy)
 */

import type { JobRow } from '@shared/types';

interface SendOutPayload {
  scrapeFirst: boolean;
  salespersonIds: string[];
  emails: string[];
  include: {
    countries: boolean;
    top15Salesmen: boolean;
    top15Overall: boolean;
    overview: boolean;
    generalCombined: boolean;
  };
  stockLists: string[];
  requestedBy?: string;
  // Internal state
  phase?: SendOutPhase;
  styleNos?: string[];
  seasonId?: string | null;
}

type LogFn = (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
type SaveResultFn = (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
type SetJobSucceededFn = (jobId: string) => Promise<void>;
type SetJobFailedOrRequeueFn = (job: JobRow, errorMsg: string) => Promise<void>;

type SendOutPhase =
  | 'init'
  | 'waiting_scrapes'
  | 'enqueue_exports'
  | 'waiting_exports'
  | 'send_emails'
  | 'done';

const POLL_DELAY_MS = 30_000; // 30 seconds between polls

export async function runManualSendoutPipeline(
  job: JobRow,
  log: LogFn,
  saveResult: SaveResultFn,
  setJobSucceeded: SetJobSucceededFn,
  setJobFailedOrRequeue: SetJobFailedOrRequeueFn
): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    await setJobFailedOrRequeue(job, 'Missing Supabase environment variables');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const payload = job.payload as SendOutPayload;
  const pipelineRootJobId = job.id;
  const currentPhase = payload.phase || 'init';

  // Helper: schedule this job to run again after a delay
  async function requeueWithDelay(nextPhase: SendOutPhase, reason: string) {
    const scheduledFor = new Date(Date.now() + POLL_DELAY_MS).toISOString();
    await supabase
      .from('jobs')
      .update({
        status: 'queued',
        lease_until: null,
        scheduled_for: scheduledFor,
        payload: { ...payload, phase: nextPhase },
      })
      .eq('id', job.id);
  }

  // ========== PHASE: init ==========
  if (currentPhase === 'init') {
    await log(job.id, 'info', 'SENDOUT:init', {
      scrapeFirst: payload.scrapeFirst,
      salespersonCount: payload.salespersonIds.length,
      extraEmailCount: payload.emails.length,
      stockListCount: payload.stockLists.length,
      include: payload.include,
    });

    // If not scraping first, skip directly to send_emails
    if (!payload.scrapeFirst) {
      await supabase
        .from('jobs')
        .update({ payload: { ...payload, phase: 'send_emails' } })
        .eq('id', job.id);
      await requeueWithDelay('send_emails', 'Skipping scrape, going to send');
      return;
    }

    // Determine season ID
    let seasonId: string | null = null;
    try {
      const { data: seasonCompare } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'season_compare')
        .maybeSingle();
      seasonId = (seasonCompare?.value as any)?.s1 as string | null;
    } catch {}

    // Derive styleNos from stock lists
    let styleNos: string[] = [];
    if (payload.stockLists && payload.stockLists.length > 0) {
      const { data: lists } = await supabase
        .from('stock_lists')
        .select('id, name')
        .in('name', payload.stockLists);

      const listIds = ((lists ?? []) as any[]).map((l) => l.id);

      if (listIds.length > 0) {
        const { data: listStyles } = await supabase
          .from('stock_list_styles')
          .select('style_id')
          .in('list_id', listIds);

        const styleIds = ((listStyles ?? []) as any[]).map((s) => s.style_id).filter(Boolean);

        if (styleIds.length > 0) {
          const { data: styles } = await supabase
            .from('styles')
            .select('style_no')
            .in('id', styleIds);

          styleNos = ((styles ?? []) as any[]).map((s) => s.style_no).filter(Boolean);
        }
      }
    }

    // Enqueue scrape_statistics
    await supabase.from('jobs').insert({
      type: 'scrape_statistics',
      payload: {
        toggles: { deep: true },
        requestedBy: 'manual_sendout_pipeline',
        pipelineRootJobId,
        seasonId,
      },
      status: 'queued',
      max_attempts: 3,
      queue: 'default',
      priority: 100,
    });

    // Enqueue update_style_stock if we have stock lists
    if (styleNos.length > 0) {
      await supabase.from('jobs').insert({
        type: 'update_style_stock',
        payload: {
          styleNos,
          requestedBy: 'manual_sendout_pipeline',
          pipelineRootJobId,
          mode: 'selected',
        },
        status: 'queued',
        max_attempts: 3,
        queue: 'stock',
        priority: 200,
      });
    }

    await log(job.id, 'info', 'SENDOUT:scrapes_enqueued', {
      statsEnqueued: true,
      stockStylesCount: styleNos.length,
    });

    // Update payload with derived data and move to next phase
    await supabase
      .from('jobs')
      .update({
        payload: { ...payload, phase: 'waiting_scrapes', styleNos, seasonId },
      })
      .eq('id', job.id);

    await requeueWithDelay('waiting_scrapes', 'Waiting for scrapes to complete');
    return;
  }

  // ========== PHASE: waiting_scrapes ==========
  if (currentPhase === 'waiting_scrapes') {
    // Check scrape_statistics
    const { data: statsJobs } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'scrape_statistics')
      .contains('payload', { pipelineRootJobId });

    const statsJob = (statsJobs ?? [])[0] as any | undefined;

    if (!statsJob || statsJob.status === 'queued' || statsJob.status === 'running') {
      await requeueWithDelay('waiting_scrapes', 'scrape_statistics still running');
      return;
    }

    if (statsJob.status === 'failed' || statsJob.status === 'cancelled') {
      await setJobFailedOrRequeue(job, `scrape_statistics failed: ${statsJob.status}`);
      return;
    }

    // Check update_style_stock if applicable
    const styleNos = payload.styleNos || [];
    if (styleNos.length > 0) {
      const { data: stockJobs } = await supabase
        .from('jobs')
        .select('id, status')
        .eq('type', 'update_style_stock')
        .contains('payload', { pipelineRootJobId });

      const stockRootJob = (stockJobs ?? [])[0] as any | undefined;

      if (!stockRootJob) {
        await requeueWithDelay('waiting_scrapes', 'update_style_stock not found yet');
        return;
      }

      // Check for fan-out batches
      const { data: allStockBatches } = await supabase
        .from('jobs')
        .select('id, status')
        .eq('type', 'update_style_stock')
        .or(`id.eq.${stockRootJob.id},payload->>rootId.eq.${stockRootJob.id}`);

      const pendingStock = ((allStockBatches ?? []) as any[]).filter(
        (j) => j.status === 'queued' || j.status === 'running'
      );

      if (pendingStock.length > 0) {
        await requeueWithDelay('waiting_scrapes', `update_style_stock batches pending: ${pendingStock.length}`);
        return;
      }

      // Check if export_stock_list has been triggered and completed
      const { data: stockExportJobs } = await supabase
        .from('jobs')
        .select('id, status')
        .eq('type', 'export_stock_list')
        .contains('payload', { triggerJobId: stockRootJob.id });

      const stockExportJob = (stockExportJobs ?? [])[0] as any | undefined;

      if (!stockExportJob || stockExportJob.status === 'queued' || stockExportJob.status === 'running') {
        await requeueWithDelay('waiting_scrapes', 'export_stock_list still running');
        return;
      }
    }

    await log(job.id, 'info', 'SENDOUT:scrapes_complete', {});
    await requeueWithDelay('enqueue_exports', 'Moving to export phase');
    return;
  }

  // ========== PHASE: enqueue_exports ==========
  if (currentPhase === 'enqueue_exports') {
    await log(job.id, 'info', 'SENDOUT:enqueue_exports', {});

    // Enqueue export_overview for general salesmen PDFs (needed for personal PDFs)
    if (payload.include.generalCombined || payload.salespersonIds.length > 0) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: {
          mode: 'general_salesmen_react_pdf',
          requestedBy: 'manual_sendout_pipeline',
          pipelineRootJobId,
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Countries PDF
    if (payload.include.countries) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: {
          mode: 'countries_react_pdf',
          requestedBy: 'manual_sendout_pipeline',
          pipelineRootJobId,
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Overview PDF
    if (payload.include.overview) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: {
          mode: 'overview_react_pdf',
          requestedBy: 'manual_sendout_pipeline',
          pipelineRootJobId,
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Top styles
    if (payload.include.top15Salesmen || payload.include.top15Overall) {
      await supabase.from('jobs').insert({
        type: 'scrape_top_styles',
        payload: { requestedBy: 'manual_sendout_pipeline', pipelineRootJobId },
        status: 'queued',
        max_attempts: 3,
      });
      await supabase.from('jobs').insert({
        type: 'export_top_styles',
        payload: { requestedBy: 'manual_sendout_pipeline', pipelineRootJobId },
        status: 'queued',
        max_attempts: 3,
      });
    }

    await requeueWithDelay('waiting_exports', 'Exports enqueued');
    return;
  }

  // ========== PHASE: waiting_exports ==========
  if (currentPhase === 'waiting_exports') {
    const { data: subJobs } = await supabase
      .from('jobs')
      .select('id, type, status')
      .contains('payload', { pipelineRootJobId });

    const exportJobTypes = ['export_overview', 'scrape_top_styles', 'export_top_styles'];
    const pendingExports = ((subJobs ?? []) as any[]).filter(
      (j) => exportJobTypes.includes(j.type) && (j.status === 'queued' || j.status === 'running')
    );

    if (pendingExports.length > 0) {
      await requeueWithDelay('waiting_exports', `Waiting for ${pendingExports.length} exports`);
      return;
    }

    await log(job.id, 'info', 'SENDOUT:exports_complete', {});
    await requeueWithDelay('send_emails', 'Moving to email phase');
    return;
  }

  // ========== PHASE: send_emails ==========
  if (currentPhase === 'send_emails') {
    // Check if emails already sent
    const { data: existingEmails } = await supabase
      .from('jobs')
      .select('id')
      .eq('type', 'send_email')
      .contains('payload', { pipelineRootJobId });

    if ((existingEmails ?? []).length > 0) {
      await log(job.id, 'info', 'SENDOUT:complete', {
        emailsAlreadySent: true,
        count: (existingEmails ?? []).length,
      });
      await saveResult(job.id, 'Send out completed (emails already sent)', {
        emailCount: (existingEmails ?? []).length,
      });
      await setJobSucceeded(job.id);
      return;
    }

    // Gather export URLs - look at recent exports (1 hour if scraped, otherwise look broader)
    const lookbackMs = payload.scrapeFirst ? 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000; // 1 hour or 7 days
    const lookbackTime = new Date(Date.now() - lookbackMs).toISOString();
    
    const { data: recentExports } = await supabase
      .from('exports')
      .select('kind, public_url, meta')
      .gte('created_at', lookbackTime)
      .order('created_at', { ascending: false });

    const latestByKind = new Map<string, any>();
    for (const exp of (recentExports ?? []) as any[]) {
      if (!latestByKind.has(exp.kind)) {
        latestByKind.set(exp.kind, exp);
      }
    }

    const generalSalesmenExport = latestByKind.get('general_salesmen_pdfs');
    const countriesExport = latestByKind.get('countries_pdf');
    const overviewExport = latestByKind.get('overview_pdf');
    const top15SalesmenExport = latestByKind.get('top_styles_pdf_salesmen');
    const top15OverallExport = latestByKind.get('top_styles_pdf_overall');

    // Get stock list exports
    const stockListExports: Array<{ name: string; url: string }> = [];
    for (const listName of payload.stockLists || []) {
      const stockExp = ((recentExports ?? []) as any[]).find(
        (e) => e.kind === 'stock_list_pdf' && e.meta?.list === listName
      );
      if (stockExp?.public_url) {
        stockListExports.push({ name: listName, url: stockExp.public_url });
      }
    }

    // Load salespersons
    const { data: salespersons } = await supabase
      .from('salespersons')
      .select('id, name, email')
      .order('sort_index', { ascending: true });

    const spById = new Map<string, any>();
    for (const sp of (salespersons ?? []) as any[]) {
      spById.set(sp.id, sp);
    }

    let statsEmailCount = 0;
    let stockListEmailCount = 0;
    const files =
      (generalSalesmenExport?.meta?.files as Array<{
        name: string;
        path: string;
        publicUrl?: string | null;
        salesperson_id?: string;
      }>) || [];
    const combinedUrl = generalSalesmenExport?.meta?.all?.publicUrl || null;

    // Build common template params for statistics email
    const buildStatsParams = (): Record<string, string> => {
      const params: Record<string, string> = {};
      if (payload.include.generalCombined && combinedUrl) {
        params.all_salesmen_pdf_url = combinedUrl;
      }
      if (payload.include.countries && countriesExport?.public_url) {
        params.countries_pdf_url = countriesExport.public_url;
      }
      if (payload.include.top15Salesmen && top15SalesmenExport?.public_url) {
        params.top15_salesmen_pdf = top15SalesmenExport.public_url;
      }
      if (payload.include.top15Overall && top15OverallExport?.public_url) {
        params.top15_overall_pdf = top15OverallExport.public_url;
      }
      if (payload.include.overview && overviewExport?.public_url) {
        params.overview_pdf_url = overviewExport.public_url;
      }
      return params;
    };

    const toTitleCase = (str: string) =>
      str
        .toLowerCase()
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    // ========== STATISTICS EMAILS ==========
    // Check if we have any stats to send
    const statsParams = buildStatsParams();
    const hasStatsToSend =
      Object.keys(statsParams).length > 0 || payload.salespersonIds.length > 0;

    if (hasStatsToSend) {
      // Send to salespersons (each gets their personal PDF)
      for (const spId of payload.salespersonIds) {
        const sp = spById.get(spId);
        if (!sp || !sp.email) continue;

        const myFile = files.find((f) => f.salesperson_id === spId);
        const templateParams: Record<string, string> = {
          ...statsParams,
          salesman_pdf: myFile?.publicUrl || '',
        };

        const firstName = sp.name ? toTitleCase(sp.name).split(' ')[0] : '';
        const hej = firstName ? `Hej ${firstName},` : 'Hej,';
        const bodyHtml = `${hej}\n\nHermed statistik :)`;

        await supabase.from('jobs').insert({
          type: 'send_email',
          payload: {
            recipient: sp.email,
            subject: 'Din statistik',
            body: bodyHtml,
            context: 'manual_sendout',
            contextId: job.id,
            contextName: 'Manual Send Out',
            templateParams,
            pipelineRootJobId,
          },
          status: 'queued',
          queue: 'default',
        });
        statsEmailCount++;
      }

      // Email list group: send ONE email to all recipients (same attachments)
      if (payload.salespersonIds.length === 0 && (payload.emails?.length || 0) > 0) {
        const templateParams = statsParams;
        const bodyHtml = `Hej,\n\nHermed statistik :)`;
        await supabase.from('jobs').insert({
          type: 'send_email',
          payload: {
            recipients: payload.emails,
            subject: 'Statistik',
            body: bodyHtml,
            context: 'manual_sendout',
            contextId: job.id,
            contextName: 'Manual Send Out',
            templateParams,
            pipelineRootJobId,
          },
          status: 'queued',
          queue: 'default',
        });
        statsEmailCount++;
      }
    }

    // ========== STOCK LIST EMAILS (separate) ==========
    if (stockListExports.length > 0) {
      // Choose exactly one recipient group (attachments differ)
      const recipientEmails: string[] = [];
      if (payload.salespersonIds.length > 0) {
        for (const spId of payload.salespersonIds) {
          const sp = spById.get(spId);
          if (sp?.email) recipientEmails.push(sp.email.toLowerCase());
        }
      } else {
        for (const email of payload.emails) {
          if (email) recipientEmails.push(email.toLowerCase());
        }
      }
      const uniqueRecipients = [...new Set(recipientEmails)];

      // Build stock list template params
      const stockListParams: Record<string, string> = {};
      let idx = 1;
      for (const sl of stockListExports) {
        stockListParams[`stock_list_${idx}_url`] = sl.url;
        stockListParams[`stock_list_${idx}_name`] = sl.name;
        stockListParams[`stock_list_${idx}_filename`] = `${sl.name} - Lagerliste.pdf`;
        idx++;
      }

      const bodyHtml = `Hej,\n\nHermed lagerliste :)`;
      const subject =
        stockListExports.length === 1
          ? `${stockListExports[0]!.name} - Lagerliste`
          : 'Lagerliste';

      // Email list group: send ONE email to all recipients
      if (payload.salespersonIds.length === 0) {
        await supabase.from('jobs').insert({
          type: 'send_email',
          payload: {
            recipients: uniqueRecipients,
            subject,
            body: bodyHtml,
            context: 'manual_sendout_stocklist',
            contextId: job.id,
            contextName: 'Manual Send Out - Stock List',
            templateParams: stockListParams,
            pipelineRootJobId,
          },
          status: 'queued',
          queue: 'default',
        });
        stockListEmailCount++;
      } else {
        // Salespersons: keep individual emails
        for (const recipient of uniqueRecipients) {
          await supabase.from('jobs').insert({
            type: 'send_email',
            payload: {
              recipient,
              subject,
              body: bodyHtml,
              context: 'manual_sendout_stocklist',
              contextId: job.id,
              contextName: 'Manual Send Out - Stock List',
              templateParams: stockListParams,
              pipelineRootJobId,
            },
            status: 'queued',
            queue: 'default',
          });
          stockListEmailCount++;
        }
      }
    }

    const totalEmails = statsEmailCount + stockListEmailCount;

    await log(job.id, 'info', 'SENDOUT:complete', {
      statsEmailCount,
      stockListEmailCount,
      totalEmails,
      stockListExportsFound: stockListExports.length,
    });

    await saveResult(job.id, 'Manual send out completed', {
      statsEmailCount,
      stockListEmailCount,
      totalEmails,
      salespersonIds: payload.salespersonIds.length,
      extraEmails: payload.emails.length,
      stockLists: payload.stockLists.length,
      stockListExportsFound: stockListExports.length,
      scrapeFirst: payload.scrapeFirst,
    });

    await setJobSucceeded(job.id);
    return;
  }

  // Unknown phase - fail
  await setJobFailedOrRequeue(job, `Unknown pipeline phase: ${currentPhase}`);
}
