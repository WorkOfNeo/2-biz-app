// Statistic Schedule Cron Job - queues pending sends for Railway worker
// Times are compared in Europe/Copenhagen timezone
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  time: string; // "HH:MM"
  days: number[]; // 0-6 (0=Sunday)
  emailBody: string;
  enabled: boolean;
  lastRun?: string;
}

interface ScheduleCheckResult {
  shouldRun: boolean;
  reason: string;
  currentTime: string;
  scheduledTime: string;
  currentDay: string;
  scheduledDays: string;
  lastRun: string | null;
  minutesUntilNext: number | null;
}

/**
 * Get current time in Copenhagen timezone
 */
function getCopenhagenTime(date: Date): { day: number; hour: number; minute: number; formatted: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[weekday] ?? 0;
  
  return { 
    day, 
    hour, 
    minute, 
    formatted: `${weekday} ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}` 
  };
}

/**
 * Check if a schedule should run now and return detailed info
 */
function checkSchedule(schedule: StatisticSchedule, now: Date): ScheduleCheckResult {
  const cph = getCopenhagenTime(now);
  const currentDay = cph.day;
  const currentHour = cph.hour;
  const currentMinute = cph.minute;

  // Parse scheduled time
  const timeParts = schedule.time.split(':').map(Number);
  const schedHour = timeParts[0] ?? 0;
  const schedMinute = timeParts[1] ?? 0;

  const scheduledDays = schedule.scheduleType === 'daily' 
    ? 'Every day' 
    : schedule.days.map(d => DAY_NAMES[d]).join(', ');

  const result: ScheduleCheckResult = {
    shouldRun: false,
    reason: '',
    currentTime: `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`,
    scheduledTime: schedule.time,
    currentDay: DAY_NAMES[currentDay] || '',
    scheduledDays,
    lastRun: schedule.lastRun || null,
    minutesUntilNext: null,
  };

  if (!schedule.enabled) {
    result.reason = 'Schedule is disabled';
    return result;
  }

  // Check day match
  if (schedule.scheduleType === 'weekly') {
    if (!schedule.days.includes(currentDay)) {
      result.reason = `Today (${DAY_NAMES[currentDay]}) not in scheduled days`;
      return result;
    }
  }

  // Check time match (within 10 minute window)
  const scheduledMinutes = schedHour * 60 + schedMinute;
  const currentMinutes = currentHour * 60 + currentMinute;
  const diff = currentMinutes - scheduledMinutes;
  const absDiff = Math.abs(diff);
  
  if (absDiff > 10 && absDiff < (24 * 60 - 10)) {
    if (diff < 0) {
      result.minutesUntilNext = -diff;
      result.reason = `${-diff} minutes until scheduled time`;
    } else {
      result.reason = `${diff} minutes past scheduled time (window closed)`;
    }
    return result;
  }

  // Check if already ran recently (within 50 minutes)
  if (schedule.lastRun) {
    const lastRunTime = new Date(schedule.lastRun).getTime();
    const fiftyMinutesAgo = now.getTime() - 50 * 60 * 1000;
    if (lastRunTime > fiftyMinutesAgo) {
      const minsAgo = Math.round((now.getTime() - lastRunTime) / 60000);
      result.reason = `Already ran ${minsAgo} minutes ago`;
      return result;
    }
  }

  result.shouldRun = true;
  result.reason = 'Ready to send';
  return result;
}

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const forceId = urlObj.searchParams.get('force');
  const testMode = urlObj.searchParams.get('test') === '1';

  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ 
      error: 'Supabase env missing',
      hint: 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    }), { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Load schedules - try new key first, fallback to old key
  let { data: settingsRow } = await supabase
    .from('app_settings')
    .select('id, value')
    .eq('key', 'statistic_schedules')
    .maybeSingle();

  if (!settingsRow) {
    const oldResult = await supabase
      .from('app_settings')
      .select('id, value')
      .eq('key', 'salesmen_schedules')
      .maybeSingle();
    settingsRow = oldResult.data;
  }

  const rawSchedules = (settingsRow?.value as any)?.schedules || [];
  // Migrate old format to new format
  const schedules: StatisticSchedule[] = rawSchedules.map((s: any) => ({
    ...s,
    additionalRecipients: s.additionalRecipients || [],
    includeGeneralCombined: s.includeGeneralCombined ?? false,
    includeCountries: s.includeCountries ?? true,
    includeTop15Salesmen: s.includeTop15Salesmen ?? s.includeTop15 ?? true,
    includeTop15Overall: s.includeTop15Overall ?? false,
    includeOverview: s.includeOverview ?? false,
  }));

  if (schedules.length === 0) {
    return new Response(JSON.stringify({ message: 'No statistic schedules configured', queued: 0 }), { status: 200 });
  }

  // Load salespersons
  const { data: salespersonsData } = await supabase
    .from('salespersons')
    .select('id, name, email')
    .order('sort_index', { ascending: true });

  const salespersons = (salespersonsData ?? []) as Array<{ id: string; name: string; email?: string | null }>;
  const salespersonById = new Map(salespersons.map(sp => [sp.id, sp]));

  // Load latest exports
  const { data: exportsData } = await supabase
    .from('exports')
    .select('id, kind, title, path, public_url, meta, created_at')
    .in('kind', ['general_salesmen_pdfs', 'top_styles_pdf_salesmen', 'top_styles_pdf_overall', 'countries_pdf', 'overview_pdf', 'stock_list_pdf'])
    .order('created_at', { ascending: false })
    .limit(100);

  // Build lookup maps
  let salesmenExport: any = null;
  let top15SalesmenExport: any = null;
  let top15OverallExport: any = null;
  let countriesExport: any = null;
  let overviewExport: any = null;
  const stockListByName = new Map<string, any>();

  for (const row of (exportsData ?? [])) {
    if (row.kind === 'general_salesmen_pdfs' && !salesmenExport) {
      salesmenExport = row;
    }
    if (row.kind === 'top_styles_pdf_salesmen' && !top15SalesmenExport) {
      top15SalesmenExport = row;
    }
    if (row.kind === 'top_styles_pdf_overall' && !top15OverallExport) {
      top15OverallExport = row;
    }
    if (row.kind === 'countries_pdf' && !countriesExport) {
      countriesExport = row;
    }
    if (row.kind === 'overview_pdf' && !overviewExport) {
      overviewExport = row;
    }
    if (row.kind === 'stock_list_pdf') {
      const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
      if (name && !stockListByName.has(name)) {
        stockListByName.set(name, row);
      }
    }
  }

  const salesmenFiles = (salesmenExport?.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
  const combinedPdfUrl = salesmenExport?.meta?.all?.publicUrl || null;

  const now = new Date();
  const cph = getCopenhagenTime(now);
  const results: Array<{ scheduleId: string; scheduleName: string; queued: number; error?: string; pipelineJobId?: string }> = [];
  const updatedSchedules: StatisticSchedule[] = [...schedules];

  // Check all schedules
  const scheduleChecks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    salespersonCount: number;
    additionalRecipientCount: number;
    check: ScheduleCheckResult;
    willRun: boolean;
  }> = [];

  for (const schedule of schedules) {
    const check = checkSchedule(schedule, now);
    const willRun = (testMode && schedule.enabled) || forceId === schedule.id || check.shouldRun;
    
    scheduleChecks.push({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      salespersonCount: schedule.salespersonIds.length,
      additionalRecipientCount: schedule.additionalRecipients?.length || 0,
      check,
      willRun,
    });

    if (!willRun) continue;

    // Enqueue a single pipeline job for this schedule
    // The pipeline handles: scrape statistics, scrape stock lists, export PDFs, send emails
    const { data: pipelineJob, error: insertError } = await supabase.from('jobs').insert({
      type: 'run_statistics_email_pipeline',
      payload: {
        scheduleId: schedule.id,
        requestedBy: 'cron',
      },
      status: 'queued',
      max_attempts: 180, // High retry count for waiter pattern
      queue: 'default',
      priority: 100,
    }).select('id').single();

    let queuedCount = 0;
    if (insertError) {
      console.error(`[cron:statistic-schedules] Failed to insert pipeline job for ${schedule.name}:`, insertError);
    } else {
      queuedCount = 1;
      if (debug) console.log(`[cron:statistic-schedules] Queued pipeline job ${pipelineJob?.id} for ${schedule.name}`);
      
      // Log initial enqueue for visibility
      await supabase.from('job_logs').insert({
        job_id: pipelineJob?.id,
        level: 'info',
        msg: 'Pipeline enqueued via cron',
        data: { scheduleId: schedule.id, scheduleName: schedule.name },
      });
    }

    // Update lastRun
    const idx = updatedSchedules.findIndex(s => s.id === schedule.id);
    const existingSchedule = updatedSchedules[idx];
    if (idx !== -1 && existingSchedule) {
      updatedSchedules[idx] = { ...existingSchedule, lastRun: now.toISOString() };
    }

    results.push({ scheduleId: schedule.id, scheduleName: schedule.name, queued: queuedCount, pipelineJobId: pipelineJob?.id });
  }

  // Save updated schedules - use new key
  if (results.length > 0) {
    const { data: existing } = await supabase
      .from('app_settings')
      .select('id')
      .eq('key', 'statistic_schedules')
      .maybeSingle();
    
    if (existing?.id) {
      await supabase
        .from('app_settings')
        .update({ value: { schedules: updatedSchedules } })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('app_settings')
        .insert({ key: 'statistic_schedules', value: { schedules: updatedSchedules } } as any);
    }
  }

  const totalQueued = results.reduce((sum, r) => sum + (r.queued || 0), 0);

  const response: Record<string, any> = {
    message: results.length > 0 
      ? `Queued ${totalQueued} job(s) for ${results.length} schedule(s)` 
      : 'No statistic schedules due to run',
    queued: totalQueued,
    testMode,
    serverTime: {
      utc: now.toISOString(),
      copenhagen: cph.formatted,
      timezone: TIMEZONE,
    },
  };

  if (debug) {
    response.schedules = scheduleChecks.map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      salespersonCount: s.salespersonCount,
      additionalRecipientCount: s.additionalRecipientCount,
      scheduledTime: s.check.scheduledTime,
      scheduledDays: s.check.scheduledDays,
      currentTime: s.check.currentTime,
      currentDay: s.check.currentDay,
      lastRun: s.check.lastRun,
      status: s.check.reason,
      willRun: s.willRun,
      minutesUntilNext: s.check.minutesUntilNext,
    }));
    response.queueResults = results;
    response.hasSalesmenExport = !!salesmenExport;
    response.hasCountriesExport = !!countriesExport;
    response.hasTop15SalesmenExport = !!top15SalesmenExport;
    response.hasTop15OverallExport = !!top15OverallExport;
    response.hasOverviewExport = !!overviewExport;
    response.hasCombinedPdf = !!combinedPdfUrl;
    response.salespersonCount = salespersons.length;
  }

  return new Response(JSON.stringify(response, null, debug ? 2 : 0), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-statistic-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-statistic-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
