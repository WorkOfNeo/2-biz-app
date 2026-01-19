/**
 * Statistics Email Pipeline
 * 
 * Chained job that:
 * 1. Refreshes statistics (scrape_statistics deep) + selected stock list styles (update_style_stock)
 * 2. Waits for both to complete
 * 3. Enqueues required export jobs (overview, countries, top styles, stock lists)
 * 4. Waits for exports to complete
 * 5. Sends emails in two modes:
 *    - Salespersons: individual emails with personal PDF
 *    - Overall: single email to comma-separated recipients with combined PDFs only
 * 
 * Uses a phase-based state machine with delayed requeues to avoid log spam.
 */

import type { JobRow } from '@shared/types';

// Schedule interface matching app_settings.statistic_schedules
interface StatisticSchedule {
  id: string;
  name: string;
  salespersonIds: string[];
  additionalRecipients: string[];
  includeGeneralCombined: boolean;
  includeCountries: boolean;
  includeTop15Salesmen: boolean;
  includeTop15Overall: boolean;
  includeOverview: boolean;
  stockLists: string[];
  scheduleType: 'daily' | 'weekly';
  time: string;
  days: number[];
  emailBody: string;
  enabled: boolean;
  lastRun?: string;
  sendToSalespersons?: boolean;
  sendToOverall?: boolean;
  overallRecipientsCsv?: string;
}

type LogFn = (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
type SaveResultFn = (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
type SetJobSucceededFn = (jobId: string) => Promise<void>;
type SetJobFailedOrRequeueFn = (job: JobRow, errorMsg: string) => Promise<void>;

// Pipeline phases
type PipelinePhase = 
  | 'init'                    // Initial state - enqueue scrape jobs
  | 'waiting_scrapes'         // Waiting for scrape_statistics + update_style_stock
  | 'enqueue_exports'         // Enqueue PDF export jobs
  | 'waiting_exports'         // Waiting for exports to complete
  | 'send_emails'             // Send emails
  | 'done';                   // Completed

const POLL_DELAY_MS = 30_000; // 30 seconds between polls

export async function runStatisticsEmailPipeline(
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
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const payload = job.payload as any;
  const pipelineRootJobId = job.id;
  const scheduleId = payload?.scheduleId as string | undefined;
  const currentPhase = (payload?.phase as PipelinePhase) || 'init';

  if (!scheduleId) {
    await setJobFailedOrRequeue(job, 'Missing scheduleId in payload');
    return;
  }

  // Helper: schedule this job to run again after a delay
  async function requeueWithDelay(nextPhase: PipelinePhase, reason: string) {
    const scheduledFor = new Date(Date.now() + POLL_DELAY_MS).toISOString();
    await supabase.from('jobs').update({
      status: 'queued',
      lease_until: null,
      scheduled_for: scheduledFor,
      payload: { ...payload, phase: nextPhase }
    }).eq('id', job.id);
    // Don't throw - just return to exit cleanly
  }

  // ========== STEP 1: Load schedule ==========
  const { data: settingsRow, error: settingsErr } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'statistic_schedules')
    .maybeSingle();

  if (settingsErr) {
    await setJobFailedOrRequeue(job, `Failed to load statistic_schedules: ${settingsErr.message}`);
    return;
  }

  const allSchedules = ((settingsRow?.value as any)?.schedules ?? []) as StatisticSchedule[];
  const schedule = allSchedules.find((s) => s.id === scheduleId);

  if (!schedule) {
    await setJobFailedOrRequeue(job, `Schedule not found: ${scheduleId}`);
    return;
  }

  // ========== PHASE: init ==========
  if (currentPhase === 'init') {
    await log(job.id, 'info', 'PIPELINE:init', { scheduleName: schedule.name, stockLists: schedule.stockLists?.length || 0 });
    
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
    if (schedule.stockLists && schedule.stockLists.length > 0) {
      const { data: lists } = await supabase
        .from('stock_lists')
        .select('id, name')
        .in('name', schedule.stockLists);
      
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
        requestedBy: 'statistics_email_pipeline', 
        pipelineRootJobId,
        seasonId 
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
          requestedBy: 'statistics_email_pipeline', 
          pipelineRootJobId,
          mode: 'selected' 
        },
        status: 'queued',
        max_attempts: 3,
        queue: 'stock',
        priority: 200,
      });
    }

    await log(job.id, 'info', 'PIPELINE:scrapes_enqueued', { statsEnqueued: true, stockStylesCount: styleNos.length });
    
    // Update payload with derived data and move to next phase
    await supabase.from('jobs').update({
      payload: { ...payload, phase: 'waiting_scrapes', styleNos, seasonId }
    }).eq('id', job.id);
    
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
    const styleNos = payload?.styleNos as string[] || [];
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

    await log(job.id, 'info', 'PIPELINE:scrapes_complete', {});
    await requeueWithDelay('enqueue_exports', 'Moving to export phase');
    return;
  }

  // ========== PHASE: enqueue_exports ==========
  if (currentPhase === 'enqueue_exports') {
    await log(job.id, 'info', 'PIPELINE:enqueue_exports', {});

    // Enqueue export_overview for general salesmen PDFs
    if (schedule.includeGeneralCombined || schedule.salespersonIds.length > 0) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: { 
          mode: 'general_salesmen_react_pdf', 
          requestedBy: 'statistics_email_pipeline', 
          pipelineRootJobId 
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Countries PDF
    if (schedule.includeCountries) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: { 
          mode: 'countries_react_pdf', 
          requestedBy: 'statistics_email_pipeline', 
          pipelineRootJobId 
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Overview PDF
    if (schedule.includeOverview) {
      await supabase.from('jobs').insert({
        type: 'export_overview',
        payload: { 
          mode: 'overview_react_pdf', 
          requestedBy: 'statistics_email_pipeline', 
          pipelineRootJobId 
        },
        status: 'queued',
        max_attempts: 3,
      });
    }

    // Top styles
    if (schedule.includeTop15Salesmen || schedule.includeTop15Overall) {
      await supabase.from('jobs').insert({
        type: 'scrape_top_styles',
        payload: { requestedBy: 'statistics_email_pipeline', pipelineRootJobId },
        status: 'queued',
        max_attempts: 3,
      });
      await supabase.from('jobs').insert({
        type: 'export_top_styles',
        payload: { requestedBy: 'statistics_email_pipeline', pipelineRootJobId },
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

    await log(job.id, 'info', 'PIPELINE:exports_complete', {});
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
      await log(job.id, 'info', 'PIPELINE:complete', { emailsAlreadySent: true, count: (existingEmails ?? []).length });
      await saveResult(job.id, 'Pipeline completed (emails already sent)', { scheduleId, emailCount: (existingEmails ?? []).length });
      await setJobSucceeded(job.id);
      return;
    }

    // Gather export URLs
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentExports } = await supabase
      .from('exports')
      .select('kind, public_url, meta')
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false });

    const latestByKind = new Map<string, any>();
    for (const exp of ((recentExports ?? []) as any[])) {
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
    for (const listName of (schedule.stockLists || [])) {
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
    for (const sp of ((salespersons ?? []) as any[])) {
      spById.set(sp.id, sp);
    }

    let emailCount = 0;
    const files = (generalSalesmenExport?.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
    const combinedUrl = generalSalesmenExport?.meta?.all?.publicUrl || null;

    // Build common template params
    const buildCommonParams = (): Record<string, string> => {
      const params: Record<string, string> = {};
      if (combinedUrl) params.all_salesmen_pdf_url = combinedUrl;
      if (schedule.includeCountries && countriesExport?.public_url) params.countries_pdf_url = countriesExport.public_url;
      if (schedule.includeTop15Salesmen && top15SalesmenExport?.public_url) params.top15_salesmen_pdf = top15SalesmenExport.public_url;
      if (schedule.includeTop15Overall && top15OverallExport?.public_url) params.top15_overall_pdf = top15OverallExport.public_url;
      if (schedule.includeOverview && overviewExport?.public_url) params.overview_pdf_url = overviewExport.public_url;
      let idx = 1;
      for (const sl of stockListExports) {
        params[`stock_list_${idx}_url`] = sl.url;
        params[`stock_list_${idx}_name`] = sl.name;
        idx++;
      }
      return params;
    };

    // Send to salespersons
    const sendToSalespersons = schedule.sendToSalespersons !== false;
    if (sendToSalespersons && schedule.salespersonIds.length > 0) {
      for (const spId of schedule.salespersonIds) {
        const sp = spById.get(spId);
        if (!sp || !sp.email) continue;

        const myFile = files.find((f) => f.salesperson_id === spId);
        const templateParams: Record<string, string> = {
          ...buildCommonParams(),
          salesman_pdf: myFile?.publicUrl || '',
        };

        const toTitleCase = (str: string) => str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        const firstName = sp.name ? toTitleCase(sp.name).split(' ')[0] : '';
        const hej = firstName ? `Hej ${firstName},` : 'Hej,';
        const bodyHtml = `${hej}\n\n${schedule.emailBody || 'Hermed statistik :)'}`;

        await supabase.from('jobs').insert({
          type: 'send_email',
          payload: {
            recipient: sp.email,
            subject: 'Din statistik',
            body: bodyHtml,
            context: 'salesmen_schedule',
            contextId: schedule.id,
            contextName: schedule.name,
            templateParams,
            pipelineRootJobId,
          },
          status: 'queued',
          queue: 'default',
        });
        emailCount++;
      }
    }

    // Send overall email
    const sendToOverall = schedule.sendToOverall === true;
    const overallRecipientsCsv = (schedule.overallRecipientsCsv || '').trim();
    
    if (sendToOverall && overallRecipientsCsv) {
      const overallEmails = overallRecipientsCsv
        .split(/[,;\s\n]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && e.includes('@'));

      if (overallEmails.length > 0) {
        const templateParams = buildCommonParams();
        const bodyHtml = `Hej,\n\n${schedule.emailBody || 'Hermed statistik :)'}`;

        await supabase.from('jobs').insert({
          type: 'send_email',
          payload: {
            recipient: overallEmails.join(', '),
            subject: 'Statistik',
            body: bodyHtml,
            context: 'salesmen_schedule',
            contextId: schedule.id,
            contextName: schedule.name,
            templateParams,
            pipelineRootJobId,
          },
          status: 'queued',
          queue: 'default',
        });
        emailCount++;
      }
    }

    await log(job.id, 'info', 'PIPELINE:complete', { emailCount, scheduleName: schedule.name });
    await saveResult(job.id, 'Statistics email pipeline completed', {
      scheduleId,
      scheduleName: schedule.name,
      emailCount,
      stockListExportsCount: stockListExports.length,
    });
    await setJobSucceeded(job.id);
    return;
  }

  // Unknown phase - fail
  await setJobFailedOrRequeue(job, `Unknown pipeline phase: ${currentPhase}`);
}
