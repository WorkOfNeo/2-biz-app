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
 */

import type { SupabaseClient } from '@supabase/supabase-js';
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
  // New fields for pipeline
  sendToSalespersons?: boolean;
  sendToOverall?: boolean;
  overallRecipientsCsv?: string;
}

type LogFn = (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
type SaveResultFn = (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
type SetJobSucceededFn = (jobId: string) => Promise<void>;
type SetJobFailedOrRequeueFn = (job: JobRow, errorMsg: string) => Promise<void>;

export async function runStatisticsEmailPipeline(
  job: JobRow,
  log: LogFn,
  saveResult: SaveResultFn,
  setJobSucceeded: SetJobSucceededFn,
  setJobFailedOrRequeue: SetJobFailedOrRequeueFn
): Promise<void> {
  // Import supabase dynamically to match worker pattern
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

  const pipelineRootJobId = job.id;
  const scheduleId = (job.payload as any)?.scheduleId as string | undefined;
  const requestedBy = (job.payload as any)?.requestedBy as string | undefined;

  if (!scheduleId) {
    await setJobFailedOrRequeue(job, 'Missing scheduleId in payload');
    return;
  }

  await log(job.id, 'info', 'PIPELINE:start', { scheduleId, requestedBy });

  // ========== STEP 1: Load schedule from app_settings ==========
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

  await log(job.id, 'info', 'PIPELINE:schedule_loaded', { 
    name: schedule.name, 
    stockLists: schedule.stockLists,
    salespersonCount: schedule.salespersonIds.length,
    sendToSalespersons: schedule.sendToSalespersons,
    sendToOverall: schedule.sendToOverall
  });

  // ========== STEP 2: Determine season ID ==========
  let seasonId: string | null = null;
  try {
    const { data: seasonCompare } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'season_compare')
      .maybeSingle();
    seasonId = (seasonCompare?.value as any)?.s1 as string | null;
  } catch {}

  // ========== STEP 3: Derive styleNos from stock lists ==========
  let styleNos: string[] = [];
  if (schedule.stockLists && schedule.stockLists.length > 0) {
    // Get list IDs from names
    const { data: lists } = await supabase
      .from('stock_lists')
      .select('id, name')
      .in('name', schedule.stockLists);
    
    const listIds = ((lists ?? []) as any[]).map((l) => l.id);
    
    if (listIds.length > 0) {
      // Get style IDs from stock_list_styles
      const { data: listStyles } = await supabase
        .from('stock_list_styles')
        .select('style_id')
        .in('list_id', listIds);
      
      const styleIds = ((listStyles ?? []) as any[]).map((s) => s.style_id).filter(Boolean);
      
      if (styleIds.length > 0) {
        // Get style_no from styles
        const { data: styles } = await supabase
          .from('styles')
          .select('style_no')
          .in('id', styleIds);
        
        styleNos = ((styles ?? []) as any[]).map((s) => s.style_no).filter(Boolean);
      }
    }
    
    await log(job.id, 'info', 'PIPELINE:stock_lists_resolved', { 
      listNames: schedule.stockLists, 
      listIds, 
      styleNosCount: styleNos.length 
    });
  }

  // ========== STEP 4: Enqueue parallel jobs (dedupe) ==========
  // Check if we already enqueued the sub-jobs for this pipeline
  const { data: existingSubJobs } = await supabase
    .from('jobs')
    .select('id, type, status')
    .contains('payload', { pipelineRootJobId });

  const existingTypes = new Set(((existingSubJobs ?? []) as any[]).map((j) => j.type));
  const pendingSubJobs = ((existingSubJobs ?? []) as any[]).filter(
    (j) => j.status === 'queued' || j.status === 'running'
  );

  // Enqueue scrape_statistics if not already
  if (!existingTypes.has('scrape_statistics')) {
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
    await log(job.id, 'info', 'PIPELINE:enqueued_scrape_statistics', { seasonId });
  }

  // Enqueue update_style_stock if we have stock lists
  if (styleNos.length > 0 && !existingTypes.has('update_style_stock')) {
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
    await log(job.id, 'info', 'PIPELINE:enqueued_update_style_stock', { styleNosCount: styleNos.length });
  }

  // ========== STEP 5: Wait for scrape_statistics to complete ==========
  const { data: statsJobs } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('type', 'scrape_statistics')
    .contains('payload', { pipelineRootJobId });

  const statsJob = (statsJobs ?? [])[0] as any | undefined;
  if (!statsJob) {
    // Sub-job may not be visible yet, wait
    throw new Error('WAITING_FOR_SCRAPE_STATISTICS_ENQUEUE');
  }

  if (statsJob.status === 'queued' || statsJob.status === 'running') {
    await log(job.id, 'info', 'PIPELINE:waiting_scrape_statistics', { statsJobId: statsJob.id, status: statsJob.status });
    throw new Error('WAITING_FOR_SCRAPE_STATISTICS');
  }

  if (statsJob.status === 'failed' || statsJob.status === 'cancelled') {
    await setJobFailedOrRequeue(job, `scrape_statistics failed: ${statsJob.status}`);
    return;
  }

  // ========== STEP 6: Wait for update_style_stock to complete (if applicable) ==========
  if (styleNos.length > 0) {
    // Check for the root update_style_stock and all its fan-out batches
    const { data: stockJobs } = await supabase
      .from('jobs')
      .select('id, status, payload')
      .eq('type', 'update_style_stock')
      .contains('payload', { pipelineRootJobId });

    const stockRootJob = (stockJobs ?? [])[0] as any | undefined;
    
    if (!stockRootJob) {
      throw new Error('WAITING_FOR_UPDATE_STYLE_STOCK_ENQUEUE');
    }

    // Also check for fan-out batches (they have rootId pointing to the first job)
    const stockRootId = stockRootJob.id;
    const { data: allStockBatches } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'update_style_stock')
      .or(`id.eq.${stockRootId},payload->>rootId.eq.${stockRootId}`);

    const pendingStock = ((allStockBatches ?? []) as any[]).filter(
      (j) => j.status === 'queued' || j.status === 'running'
    );

    if (pendingStock.length > 0) {
      await log(job.id, 'info', 'PIPELINE:waiting_update_style_stock', { pending: pendingStock.length });
      throw new Error('WAITING_FOR_UPDATE_STYLE_STOCK');
    }

    // Check if export_stock_list has been enqueued and completed
    const { data: stockExportJobs } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'export_stock_list')
      .contains('payload', { triggerJobId: stockRootId });

    const stockExportJob = (stockExportJobs ?? [])[0] as any | undefined;
    
    if (!stockExportJob) {
      // The waiter job export_stock_list_after_update_stock should enqueue this
      await log(job.id, 'info', 'PIPELINE:waiting_export_stock_list', { stockRootId });
      throw new Error('WAITING_FOR_EXPORT_STOCK_LIST');
    }

    if (stockExportJob.status === 'queued' || stockExportJob.status === 'running') {
      await log(job.id, 'info', 'PIPELINE:waiting_export_stock_list_running', { exportJobId: stockExportJob.id });
      throw new Error('WAITING_FOR_EXPORT_STOCK_LIST');
    }
  }

  // ========== STEP 7: Enqueue export jobs (dedupe) ==========
  // Note: export_stock_list is already handled by the update_style_stock waiter
  
  // Enqueue export_overview for general salesmen PDFs if needed
  if ((schedule.includeGeneralCombined || schedule.salespersonIds.length > 0) && !existingTypes.has('export_overview')) {
    const exportModes: string[] = [];
    
    // General salesmen PDFs (produces per-salesperson + combined)
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
    exportModes.push('general_salesmen_react_pdf');

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
      exportModes.push('countries_react_pdf');
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
      exportModes.push('overview_react_pdf');
    }

    await log(job.id, 'info', 'PIPELINE:enqueued_exports', { exportModes });
  }

  // Enqueue top styles scrape + export if needed
  if ((schedule.includeTop15Salesmen || schedule.includeTop15Overall) && !existingTypes.has('scrape_top_styles')) {
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
    await log(job.id, 'info', 'PIPELINE:enqueued_top_styles', {});
  }

  // ========== STEP 8: Wait for export jobs to complete ==========
  // Refresh sub-jobs list
  const { data: refreshedSubJobs } = await supabase
    .from('jobs')
    .select('id, type, status')
    .contains('payload', { pipelineRootJobId });

  const exportJobTypes = ['export_overview', 'scrape_top_styles', 'export_top_styles'];
  const pendingExports = ((refreshedSubJobs ?? []) as any[]).filter(
    (j) => exportJobTypes.includes(j.type) && (j.status === 'queued' || j.status === 'running')
  );

  if (pendingExports.length > 0) {
    await log(job.id, 'info', 'PIPELINE:waiting_exports', { pending: pendingExports.length, types: pendingExports.map((j: any) => j.type) });
    throw new Error('WAITING_FOR_EXPORTS');
  }

  // ========== STEP 9: Gather export URLs from exports table ==========
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

  await log(job.id, 'info', 'PIPELINE:exports_gathered', {
    hasGeneralSalesmen: !!generalSalesmenExport,
    hasCountries: !!countriesExport,
    hasOverview: !!overviewExport,
    hasTop15Salesmen: !!top15SalesmenExport,
    hasTop15Overall: !!top15OverallExport,
    stockListCount: stockListExports.length,
  });

  // ========== STEP 10: Check for already-sent emails (dedupe) ==========
  const { data: existingEmails } = await supabase
    .from('jobs')
    .select('id, type, status')
    .eq('type', 'send_email')
    .contains('payload', { pipelineRootJobId });

  if ((existingEmails ?? []).length > 0) {
    await log(job.id, 'info', 'PIPELINE:emails_already_sent', { count: (existingEmails ?? []).length });
    await saveResult(job.id, 'Pipeline completed (emails already sent)', { 
      scheduleId, 
      emailCount: (existingEmails ?? []).length 
    });
    await setJobSucceeded(job.id);
    return;
  }

  // ========== STEP 11: Load salespersons ==========
  const { data: salespersons } = await supabase
    .from('salespersons')
    .select('id, name, email')
    .order('sort_index', { ascending: true });

  const spById = new Map<string, any>();
  for (const sp of ((salespersons ?? []) as any[])) {
    spById.set(sp.id, sp);
  }

  // ========== STEP 12: Send emails ==========
  let emailCount = 0;
  const files = (generalSalesmenExport?.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
  const combinedUrl = generalSalesmenExport?.meta?.all?.publicUrl || null;

  // Build common template params (combined PDFs only, no personal PDFs)
  const buildCommonParams = (): Record<string, string> => {
    const params: Record<string, string> = {};
    if (combinedUrl) params.all_salesmen_pdf_url = combinedUrl;
    if (schedule.includeCountries && countriesExport?.public_url) params.countries_pdf_url = countriesExport.public_url;
    if (schedule.includeTop15Salesmen && top15SalesmenExport?.public_url) params.top15_salesmen_pdf = top15SalesmenExport.public_url;
    if (schedule.includeTop15Overall && top15OverallExport?.public_url) params.top15_overall_pdf = top15OverallExport.public_url;
    if (schedule.includeOverview && overviewExport?.public_url) params.overview_pdf_url = overviewExport.public_url;
    // Add stock lists
    let idx = 1;
    for (const sl of stockListExports) {
      params[`stock_list_${idx}_url`] = sl.url;
      params[`stock_list_${idx}_name`] = sl.name;
      idx++;
    }
    return params;
  };

  // Salespersons mode: individual emails
  const sendToSalespersons = schedule.sendToSalespersons !== false; // Default true for backwards compatibility
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
    await log(job.id, 'info', 'PIPELINE:salesperson_emails_queued', { count: emailCount });
  }

  // Overall mode: single email to comma-separated list
  const sendToOverall = schedule.sendToOverall === true;
  const overallRecipientsCsv = (schedule.overallRecipientsCsv || '').trim();
  
  if (sendToOverall && overallRecipientsCsv) {
    // Parse and normalize email list
    const overallEmails = overallRecipientsCsv
      .split(/[,;\s\n]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && e.includes('@'));

    if (overallEmails.length > 0) {
      // Single email with multiple recipients in To-field (EmailJS template_params.to_email can be comma-separated)
      const templateParams = buildCommonParams();
      // No salesman_pdf for overall
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
      await log(job.id, 'info', 'PIPELINE:overall_email_queued', { recipientCount: overallEmails.length });
    }
  }

  // ========== STEP 13: Done ==========
  await saveResult(job.id, 'Statistics email pipeline completed', {
    scheduleId,
    scheduleName: schedule.name,
    emailCount,
    stockListExportsCount: stockListExports.length,
  });
  await setJobSucceeded(job.id);
}
