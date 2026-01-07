// Stock List Schedule Cron Job - sends scheduled emails automatically
// Times are compared in Europe/Copenhagen timezone
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
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

  // Get EmailJS config (try both server-side and NEXT_PUBLIC_ variants)
  const serviceId = process.env.EMAILJS_SERVICE_ID || process.env.EMAILJS_SERVICE_KEY || process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID || process.env.NEXT_PUBLIC_EMAILJS_SERVICE_KEY || '';
  const templateId = process.env.EMAILJS_TEMPLATE_ID || process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID || '';
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY || '';
  // Private key is REQUIRED for server-side EmailJS calls
  const privateKey = process.env.EMAILJS_PRIVATE_KEY || '';
  const fromEmail = process.env.EMAILJS_FROM_EMAIL || process.env.NEXT_PUBLIC_EMAILJS_FROM_EMAIL || '';
  const fromName = process.env.EMAILJS_FROM_NAME || process.env.NEXT_PUBLIC_EMAILJS_FROM_NAME || '2-BIZ';

  if (!serviceId || !templateId || !publicKey || !privateKey) {
    return new Response(JSON.stringify({ 
      error: 'EmailJS env missing',
      missing: {
        serviceId: !serviceId,
        templateId: !templateId,
        publicKey: !publicKey,
        privateKey: !privateKey,
      },
      hint: 'For server-side EmailJS, you need EMAILJS_PRIVATE_KEY (from EmailJS dashboard > Account > API Keys > Private Key)'
    }), { status: 500 });
  }

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
  for (const row of (exportsData ?? [])) {
    const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
    if (name && !latestStockListByName.has(name)) {
      latestStockListByName.set(name, row);
    }
  }

  const now = new Date();
  const cph = getCopenhagenTime(now);
  const results: Array<{ scheduleId: string; scheduleName: string; sent: number; error?: string }> = [];
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
    const willRun = forceId === schedule.id || check.shouldRun;
    
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

    try {
      let sentCount = 0;

      for (const listName of schedule.stockLists) {
        const exp = latestStockListByName.get(listName);
        if (!exp?.public_url) {
          if (debug) console.log(`[cron:stock-list-schedules] No export for list "${listName}"`);
          continue;
        }

        const subject = `${listName} - Lagerliste`;
        const filename = `${listName} - Lagerliste.pdf`;

        // Send to all recipients (as BCC if multiple)
        // For server-side EmailJS, we need accessToken (private key)
        const payload = {
          service_id: serviceId,
          template_id: templateId,
          user_id: publicKey,
          accessToken: privateKey, // Required for server-side calls
          template_params: {
            to_email: schedule.recipients[0] || '',
            bcc_email: schedule.recipients.slice(1).join(','),
            subject,
            message_html: schedule.emailBody || 'Hermed lagerliste :)',
            from_name: fromName,
            from_email: fromEmail,
            stock_list_1_url: exp.public_url,
            stock_list_1_name: listName,
            stock_list_1_filename: filename,
          },
        };

        const res = await fetch(EMAILJS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          sentCount++;
          if (debug) console.log(`[cron:stock-list-schedules] Sent "${listName}" to ${schedule.recipients.length} recipients`);
        } else {
          const errText = await res.text();
          console.error(`[cron:stock-list-schedules] Failed to send "${listName}": ${errText}`);
        }
      }

      // Update lastRun
      const idx = updatedSchedules.findIndex(s => s.id === schedule.id);
      const existing = updatedSchedules[idx];
      if (idx !== -1 && existing) {
        updatedSchedules[idx] = { ...existing, lastRun: now.toISOString() };
      }

      results.push({ scheduleId: schedule.id, scheduleName: schedule.name, sent: sentCount });
    } catch (err: any) {
      results.push({ scheduleId: schedule.id, scheduleName: schedule.name, sent: 0, error: err?.message || String(err) });
    }
  }

  // Save updated schedules (with new lastRun times)
  if (results.length > 0 && settingsRow?.id) {
    await supabase
      .from('app_settings')
      .update({ value: { schedules: updatedSchedules } })
      .eq('id', settingsRow.id);
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0);

  // Build response
  const response: Record<string, any> = {
    message: results.length > 0 ? `Processed ${results.length} schedule(s)` : 'No schedules due to run',
    sent: totalSent,
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
    response.sendResults = results;
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

