// Stock List Schedule Cron Job - queues pending sends for browser-based delivery
// Times are compared in Europe/Copenhagen timezone
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface StockListSchedule {
  id: string;
  name: string;
  stockLists: string[];
  recipients: string[];
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
function checkSchedule(schedule: StockListSchedule, now: Date): ScheduleCheckResult {
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
  const forceId = urlObj.searchParams.get('force'); // Force run a specific schedule by ID
  const testMode = urlObj.searchParams.get('test') === '1'; // Bypass all timing checks

  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ 
      error: 'Supabase env missing',
      missing: {
        url: !supabaseUrl,
        serviceKey: !serviceKey,
      },
      hint: 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel env vars'
    }), { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Load schedules
  const { data: settingsRow } = await supabase
    .from('app_settings')
    .select('id, value')
    .eq('key', 'stock_list_schedules')
    .maybeSingle();

  const schedules: StockListSchedule[] = (settingsRow?.value as any)?.schedules || [];

  if (schedules.length === 0) {
    return new Response(JSON.stringify({ message: 'No schedules configured', sent: 0 }), { status: 200 });
  }

  // Load latest stock list exports
  const { data: exportsData } = await supabase
    .from('exports')
    .select('id, kind, title, path, public_url, meta, created_at')
    .eq('kind', 'stock_list_pdf')
    .order('created_at', { ascending: false })
    .limit(50);

  const latestStockListByName = new Map<string, any>();
  const exportDebugInfo: Array<{ name: string; hasUrl: boolean; meta: any }> = [];
  for (const row of (exportsData ?? [])) {
    const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
    exportDebugInfo.push({ 
      name, 
      hasUrl: !!row?.public_url,
      meta: row?.meta 
    });
    if (name && !latestStockListByName.has(name)) {
      latestStockListByName.set(name, row);
    }
  }

  const now = new Date();
  const cph = getCopenhagenTime(now);
  const results: Array<{ scheduleId: string; scheduleName: string; queued: number; error?: string }> = [];
  const updatedSchedules: StockListSchedule[] = [...schedules];

  // Check all schedules and collect debug info
  const scheduleChecks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    stockLists: string[];
    recipients: number;
    check: ScheduleCheckResult;
    willRun: boolean;
  }> = [];

  for (const schedule of schedules) {
    const check = checkSchedule(schedule, now);
    // testMode: run all enabled schedules regardless of timing
    // forceId: run a specific schedule by ID
    const willRun = (testMode && schedule.enabled) || forceId === schedule.id || check.shouldRun;
    
    scheduleChecks.push({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      stockLists: schedule.stockLists,
      recipients: schedule.recipients.length,
      check,
      willRun,
    });

    if (!willRun) continue;

    // Queue jobs for Railway worker to send emails
    let queuedCount = 0;
    for (const listName of schedule.stockLists) {
      const exp = latestStockListByName.get(listName);
      if (!exp?.public_url) {
        if (debug) console.log(`[cron:stock-list-schedules] No export for list "${listName}"`);
        continue;
      }

      // Insert job for the Railway worker
      const jobPayload = {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        listName,
        listUrl: exp.public_url,
        recipients: schedule.recipients,
        emailBody: schedule.emailBody || 'Hermed lagerliste :)',
      };

      const { error: insertError, data: insertedJob } = await supabase.from('jobs').insert({
        type: 'send_stock_list_email',
        payload: jobPayload,
        status: 'pending',
        queue: 'default',
      }).select('id');

      if (insertError) {
        console.error(`[cron:stock-list-schedules] Failed to insert job for ${listName}:`, insertError);
        // Store error to include in results
        (schedule as any)._insertError = `${listName}: ${insertError.message}`;
      } else {
        queuedCount++;
        if (debug) console.log(`[cron:stock-list-schedules] Inserted job ${insertedJob?.[0]?.id} for ${listName}`);
      }
    }

    // Update lastRun
    const idx = updatedSchedules.findIndex(s => s.id === schedule.id);
    const existingSchedule = updatedSchedules[idx];
    if (idx !== -1 && existingSchedule) {
      updatedSchedules[idx] = { ...existingSchedule, lastRun: now.toISOString() };
    }

    const insertError = (schedule as any)._insertError;
    results.push({ 
      scheduleId: schedule.id, 
      scheduleName: schedule.name, 
      queued: queuedCount,
      ...(insertError ? { error: insertError } : {})
    });
  }

  // Save updated schedules (with new lastRun times)
  if (results.length > 0 && settingsRow?.id) {
    await supabase
      .from('app_settings')
      .update({ value: { schedules: updatedSchedules } })
      .eq('id', settingsRow.id);
  }

  const totalQueued = results.reduce((sum, r) => sum + (r.queued || 0), 0);

  // Build response
  const response: Record<string, any> = {
    message: results.length > 0 
      ? `Queued ${totalQueued} job(s) for Railway worker from ${results.length} schedule(s)` 
      : 'No schedules due to run',
    queued: totalQueued,
    testMode,
    serverTime: {
      utc: now.toISOString(),
      copenhagen: cph.formatted,
      timezone: TIMEZONE,
    },
  };

  // Always include schedule summary in debug mode
  if (debug) {
    response.schedules = scheduleChecks.map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      stockLists: s.stockLists,
      recipients: s.recipients,
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
    response.availableExports = Array.from(latestStockListByName.keys());
    response.exportDebug = exportDebugInfo.slice(0, 10); // First 10 exports for debugging
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
    console.error('[cron:send-stock-list-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-stock-list-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

