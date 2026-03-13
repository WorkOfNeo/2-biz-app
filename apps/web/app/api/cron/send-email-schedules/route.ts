// Email Send Schedule Cron Job - queues pending sends for Railway worker
// Times are compared in Europe/Copenhagen timezone
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface EmailSendSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  time: string;
  scrapeFirst: boolean;
  recipientType: 'salespersons' | 'email_list';
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
  lastRun?: string;
  createdAt: string;
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

function checkSchedule(schedule: EmailSendSchedule, now: Date): ScheduleCheckResult {
  const cph = getCopenhagenTime(now);
  const currentDay = cph.day;
  const currentHour = cph.hour;
  const currentMinute = cph.minute;

  const timeParts = schedule.time.split(':').map(Number);
  const schedHour = timeParts[0] ?? 0;
  const schedMinute = timeParts[1] ?? 0;

  const scheduledDays = schedule.days.length === 7
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

  if (!schedule.days.includes(currentDay)) {
    result.reason = `Today (${DAY_NAMES[currentDay]}) not in scheduled days`;
    return result;
  }

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

  const { data: settingsRow } = await supabase
    .from('app_settings')
    .select('id, value')
    .eq('key', 'email_send_schedules')
    .maybeSingle();

  const schedules: EmailSendSchedule[] = (settingsRow?.value as any)?.schedules || [];

  if (schedules.length === 0) {
    return new Response(JSON.stringify({ message: 'No email send schedules configured', queued: 0 }), { status: 200 });
  }

  const now = new Date();
  const cph = getCopenhagenTime(now);
  const results: Array<{ scheduleId: string; scheduleName: string; queued: number; error?: string; pipelineJobId?: string }> = [];
  const updatedSchedules: EmailSendSchedule[] = [...schedules];

  const scheduleChecks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    recipientType: string;
    recipientCount: number;
    check: ScheduleCheckResult;
    willRun: boolean;
  }> = [];

  for (const schedule of schedules) {
    const check = checkSchedule(schedule, now);
    const willRun = (testMode && schedule.enabled) || forceId === schedule.id || check.shouldRun;
    
    const recipientCount = schedule.recipientType === 'salespersons' 
      ? schedule.salespersonIds.length 
      : schedule.emails.length;

    scheduleChecks.push({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      recipientType: schedule.recipientType,
      recipientCount,
      check,
      willRun,
    });

    if (!willRun) continue;

    if (schedule.scrapeFirst) {
      // Enqueue pipeline job (scrape -> export -> send)
      const { data: pipelineJob, error: insertError } = await supabase.from('jobs').insert({
        type: 'run_manual_sendout_pipeline',
        payload: {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          scrapeFirst: true,
          salespersonIds: schedule.recipientType === 'salespersons' ? schedule.salespersonIds : undefined,
          emails: schedule.recipientType === 'email_list' ? schedule.emails : undefined,
          include: schedule.include,
          stockLists: schedule.stockLists,
          requestedBy: 'email_schedule_cron',
        },
        status: 'queued',
        max_attempts: 180,
        queue: 'default',
        priority: 100,
      }).select('id').single();

      if (insertError) {
        console.error(`[cron:email-schedules] Failed to insert pipeline job for ${schedule.name}:`, insertError);
        results.push({ scheduleId: schedule.id, scheduleName: schedule.name, queued: 0, error: insertError.message });
      } else {
        if (debug) console.log(`[cron:email-schedules] Queued pipeline job ${pipelineJob?.id} for ${schedule.name}`);
        results.push({ scheduleId: schedule.id, scheduleName: schedule.name, queued: 1, pipelineJobId: pipelineJob?.id });
        
        await supabase.from('job_logs').insert({
          job_id: pipelineJob?.id,
          level: 'info',
          msg: 'Pipeline enqueued via email schedule cron',
          data: { scheduleId: schedule.id, scheduleName: schedule.name },
        });
      }
    } else {
      // Send directly using latest exports
      const { data: salespersonsData } = await supabase
        .from('salespersons')
        .select('id, name, email')
        .order('sort_index', { ascending: true });
      
      const salespersons = (salespersonsData ?? []) as Array<{ id: string; name: string; email?: string | null }>;
      const salespersonById = new Map(salespersons.map(sp => [sp.id, sp]));

      const { data: exportsData } = await supabase
        .from('exports')
        .select('id, kind, title, path, public_url, meta, created_at')
        .in('kind', ['general_salesmen_pdfs', 'top_styles_pdf_salesmen', 'top_styles_pdf_overall', 'countries_pdf', 'overview_pdf', 'stock_list_pdf'])
        .order('created_at', { ascending: false })
        .limit(100);

      let salesmenExport: any = null;
      let top15SalesmenExport: any = null;
      let top15OverallExport: any = null;
      let countriesExport: any = null;
      let overviewExport: any = null;
      const stockListByName = new Map<string, any>();

      for (const row of (exportsData ?? [])) {
        if (row.kind === 'general_salesmen_pdfs' && !salesmenExport) salesmenExport = row;
        if (row.kind === 'top_styles_pdf_salesmen' && !top15SalesmenExport) top15SalesmenExport = row;
        if (row.kind === 'top_styles_pdf_overall' && !top15OverallExport) top15OverallExport = row;
        if (row.kind === 'countries_pdf' && !countriesExport) countriesExport = row;
        if (row.kind === 'overview_pdf' && !overviewExport) overviewExport = row;
        if (row.kind === 'stock_list_pdf') {
          const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
          if (name && !stockListByName.has(name)) stockListByName.set(name, row);
        }
      }

      const salesmenFiles = (salesmenExport?.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
      const combinedPdfUrl = salesmenExport?.meta?.all?.publicUrl || null;

      let queuedCount = 0;
      let errors: string[] = [];

      if (schedule.recipientType === 'salespersons') {
        for (const spId of schedule.salespersonIds) {
          const sp = salespersonById.get(spId);
          if (!sp?.email) {
            errors.push(`Salesperson ${sp?.name || spId} has no email`);
            continue;
          }

          const personalPdf = salesmenFiles.find(f => f.salesperson_id === spId);
          const templateParams: Record<string, string> = {};
          
          if (schedule.include.countries && countriesExport?.public_url) {
            templateParams.countries_url = countriesExport.public_url;
          }
          if (schedule.include.top15Salesmen && top15SalesmenExport?.public_url) {
            templateParams.top_15_salesmen_url = top15SalesmenExport.public_url;
          }
          if (schedule.include.top15Overall && top15OverallExport?.public_url) {
            templateParams.top_15_overall_url = top15OverallExport.public_url;
          }
          if (schedule.include.overview && overviewExport?.public_url) {
            templateParams.overview_url = overviewExport.public_url;
          }
          if (schedule.include.generalCombined && combinedPdfUrl) {
            templateParams.general_combined_url = combinedPdfUrl;
          }
          if (personalPdf?.publicUrl) {
            templateParams.salesman_pdf_url = personalPdf.publicUrl;
            templateParams.salesman_pdf_name = personalPdf.name || 'statistik.pdf';
          }

          // Add stock lists
          let stockIdx = 1;
          for (const listName of schedule.stockLists) {
            const exp = stockListByName.get(listName);
            if (exp?.public_url) {
              templateParams[`stock_list_${stockIdx}_url`] = exp.public_url;
              templateParams[`stock_list_${stockIdx}_name`] = listName;
              templateParams[`stock_list_${stockIdx}_filename`] = `${listName} - Lagerliste.pdf`;
              stockIdx++;
            }
          }

          const { error: insertError } = await supabase.from('jobs').insert({
            type: 'send_email',
            payload: {
              recipient: sp.email,
              subject: 'Din statistik',
              body: `Hej ${sp.name}, hermed din statistik`,
              context: 'email_schedule',
              contextId: schedule.id,
              contextName: schedule.name,
              templateParams,
            },
            status: 'queued',
            queue: 'default',
          });

          if (insertError) {
            errors.push(`Failed to queue for ${sp.name}: ${insertError.message}`);
          } else {
            queuedCount++;
          }
        }
      } else {
        // Email list recipient type
        for (const email of schedule.emails) {
          const templateParams: Record<string, string> = {};
          
          if (schedule.include.countries && countriesExport?.public_url) {
            templateParams.countries_url = countriesExport.public_url;
          }
          if (schedule.include.top15Salesmen && top15SalesmenExport?.public_url) {
            templateParams.top_15_salesmen_url = top15SalesmenExport.public_url;
          }
          if (schedule.include.top15Overall && top15OverallExport?.public_url) {
            templateParams.top_15_overall_url = top15OverallExport.public_url;
          }
          if (schedule.include.overview && overviewExport?.public_url) {
            templateParams.overview_url = overviewExport.public_url;
          }
          if (schedule.include.generalCombined && combinedPdfUrl) {
            templateParams.general_combined_url = combinedPdfUrl;
          }

          // Add stock lists
          let stockIdx = 1;
          for (const listName of schedule.stockLists) {
            const exp = stockListByName.get(listName);
            if (exp?.public_url) {
              templateParams[`stock_list_${stockIdx}_url`] = exp.public_url;
              templateParams[`stock_list_${stockIdx}_name`] = listName;
              templateParams[`stock_list_${stockIdx}_filename`] = `${listName} - Lagerliste.pdf`;
              stockIdx++;
            }
          }

          const { error: insertError } = await supabase.from('jobs').insert({
            type: 'send_email',
            payload: {
              recipient: email,
              subject: 'Statistik',
              body: 'Hermed statistik',
              context: 'email_schedule',
              contextId: schedule.id,
              contextName: schedule.name,
              templateParams,
            },
            status: 'queued',
            queue: 'default',
          });

          if (insertError) {
            errors.push(`Failed to queue for ${email}: ${insertError.message}`);
          } else {
            queuedCount++;
          }
        }
      }

      results.push({ 
        scheduleId: schedule.id, 
        scheduleName: schedule.name, 
        queued: queuedCount,
        ...(errors.length > 0 ? { error: errors.join('; ') } : {})
      });
    }

    // Update lastRun
    const idx = updatedSchedules.findIndex(s => s.id === schedule.id);
    const existingSchedule = updatedSchedules[idx];
    if (idx !== -1 && existingSchedule) {
      updatedSchedules[idx] = { ...existingSchedule, lastRun: now.toISOString() };
    }
  }

  // Save updated schedules
  if (results.length > 0 && settingsRow?.id) {
    await supabase
      .from('app_settings')
      .update({ value: { schedules: updatedSchedules } })
      .eq('id', settingsRow.id);
  }

  const totalQueued = results.reduce((sum, r) => sum + (r.queued || 0), 0);

  const response: Record<string, any> = {
    message: results.length > 0 
      ? `Queued ${totalQueued} job(s) for ${results.length} schedule(s)` 
      : 'No schedules due to run',
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
      recipientType: s.recipientType,
      recipientCount: s.recipientCount,
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
    console.error('[cron:send-email-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-email-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
