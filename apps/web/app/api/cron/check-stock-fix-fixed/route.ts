// DST-safe check_stock_fix cron (Europe/Copenhagen)
// Reads schedule from scrape_schedules table (configurable via UI)
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';
const SCHEDULE_KEY = 'check_stock_fix';

function getCopenhagenParts(date: Date): { isoDate: string; hour: number; minute: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[weekday] ?? 1;
  return { isoDate: `${year}-${month}-${day}`, hour, minute, dayOfWeek };
}

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey) };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Fetch schedule config from database
  const { data: scheduleRow } = await supabase
    .from('scrape_schedules')
    .select('enabled, hours, days_of_week, config')
    .eq('key', SCHEDULE_KEY)
    .maybeSingle();

  // Fallback defaults if table doesn't exist or no row found
  const schedule = scheduleRow ?? { enabled: true, hours: [7, 12, 15], days_of_week: null, config: { minuteOffset: 30, autoFix: true } };
  
  if (!schedule.enabled) {
    const res = { skipped: true, reason: 'schedule disabled' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const now = new Date();
  const cph = getCopenhagenParts(now);
  const minuteOffset = (schedule.config as any)?.minuteOffset ?? 0;
  const autoFix = (schedule.config as any)?.autoFix ?? true;

  // Check day of week if specified
  if (schedule.days_of_week !== null && !schedule.days_of_week.includes(cph.dayOfWeek)) {
    const res = { skipped: true, reason: 'not a scheduled day', cph, scheduledDays: schedule.days_of_week };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if current hour is in scheduled hours and we're in the time window
  const isScheduledHour = schedule.hours.includes(cph.hour);
  const isInWindow = cph.minute >= minuteOffset && cph.minute <= minuteOffset + 9;
  
  if (!isScheduledHour || !isInWindow) {
    const res = { skipped: true, reason: 'outside scheduled window', cph, scheduledHours: schedule.hours, minuteOffset };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `check_stock_fix:${cph.isoDate}-${String(cph.hour).padStart(2, '0')}:${String(minuteOffset).padStart(2, '0')}`;

  // Dedupe: if we already enqueued this runKey today, do nothing
  const { data: existing } = await supabase
    .from('jobs')
    .select('id,status')
    .eq('type', 'check_stock_fix')
    .contains('payload', { requestedBy: 'cron_check_stock_fix', runKey })
    .order('created_at', { ascending: false })
    .limit(1);
  
  if ((existing ?? []).length > 0) {
    const res = { skipped: true, reason: 'already enqueued', runKey, existingJobId: (existing as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if a check_stock_fix is already running (avoid parallel runs)
  const { data: running } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', 'check_stock_fix')
    .in('status', ['queued', 'running'])
    .limit(1);
  
  if ((running ?? []).length > 0) {
    const res = { skipped: true, reason: 'check_stock_fix already queued/running', existingJobId: (running as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue check_stock_fix
  const { data: job, error: insErr } = await supabase
    .from('jobs')
    .insert({
      type: 'check_stock_fix',
      payload: {
        requestedBy: 'cron_check_stock_fix',
        runKey,
        autoFix,
      },
      status: 'queued',
      max_attempts: 3,
      queue: 'default',
      priority: 150,
    } as any)
    .select('id')
    .single();
  
  if (insErr) {
    const errRes = { error: 'enqueue check_stock_fix failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const jobId = (job as any)?.id as string;
  await supabase
    .from('job_logs')
    .insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { kind: 'check_stock_fix', runKey, autoFix } });

  const res = { enqueued: true, jobId, runKey, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron check-stock-fix-fixed error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron check-stock-fix-fixed error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
