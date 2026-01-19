// Weekly Style Refresh - Configurable day/time (Copenhagen)
// Reads schedule from scrape_schedules table (configurable via UI)
// Pipeline: scrape_styles → enrich_styles → deep_scrape_styles → scrape_eans → check_stock_fix (autoFix) → export_stock_list
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';
const SCHEDULE_KEY = 'weekly_style_refresh';

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

  // Fallback defaults: Sundays at 02:00
  const schedule = scheduleRow ?? { enabled: true, hours: [2], days_of_week: [0], config: {} };
  
  if (!schedule.enabled) {
    const res = { skipped: true, reason: 'schedule disabled' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const now = new Date();
  const cph = getCopenhagenParts(now);

  // Check day of week
  if (schedule.days_of_week !== null && !schedule.days_of_week.includes(cph.dayOfWeek)) {
    const res = { skipped: true, reason: 'not a scheduled day', cph, scheduledDays: schedule.days_of_week };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check hour and time window
  const isScheduledHour = schedule.hours.includes(cph.hour);
  const isInWindow = cph.minute >= 0 && cph.minute <= 9;

  if (!isScheduledHour || !isInWindow) {
    const res = { skipped: true, reason: 'outside scheduled window', cph, scheduledHours: schedule.hours };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `weekly_style_refresh:${cph.isoDate}`;

  // Dedupe: if we already enqueued this week's refresh, do nothing
  const { data: existing } = await supabase
    .from('jobs')
    .select('id,status')
    .eq('type', 'scrape_styles')
    .contains('payload', { requestedBy: 'cron_weekly_style_refresh', runKey })
    .order('created_at', { ascending: false })
    .limit(1);

  if ((existing ?? []).length > 0) {
    const res = { skipped: true, reason: 'already enqueued this week', runKey, existingJobId: (existing as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if any pipeline job is already running
  const { data: running } = await supabase
    .from('jobs')
    .select('id, type')
    .in('type', ['scrape_styles', 'enrich_styles', 'deep_scrape_styles', 'scrape_eans', 'check_stock_fix', 'update_style_stock'])
    .in('status', ['queued', 'running'])
    .limit(1);

  if ((running ?? []).length > 0) {
    const res = { skipped: true, reason: 'pipeline job already in progress', existingJob: (running as any)[0] };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue the full pipeline with run_after delays to sequence them
  const inserts = [
    // Step 1: scrape_styles (immediately)
    {
      type: 'scrape_styles',
      payload: { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 1 },
      status: 'queued',
      max_attempts: 3,
    },
    // Step 2: enrich_styles (after 15 min) - extracts style_type, cost_price, cost_price_currency
    {
      type: 'enrich_styles',
      payload: { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 2 },
      status: 'queued',
      max_attempts: 3,
      run_after: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    },
    // Step 3: deep_scrape_styles (after 30 min)
    {
      type: 'deep_scrape_styles',
      payload: { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 3 },
      status: 'queued',
      max_attempts: 3,
      run_after: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    },
    // Step 4: scrape_eans (after 2 hours)
    {
      type: 'scrape_eans',
      payload: { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 4 },
      status: 'queued',
      max_attempts: 3,
      queue: 'stock',
      run_after: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    },
    // Step 5: check_stock_fix with autoFix (after 4 hours)
    {
      type: 'check_stock_fix',
      payload: { requestedBy: 'cron_weekly_style_refresh', runKey, pipelineStep: 5, autoFix: true },
      status: 'queued',
      max_attempts: 3,
      run_after: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const { error: insErr } = await supabase.from('jobs').insert(inserts as any);
  if (insErr) {
    const errRes = { error: 'enqueue weekly refresh pipeline failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const res = { enqueued: inserts.length, runKey, pipeline: inserts.map(i => ({ type: i.type, step: (i.payload as any).pipelineStep })) };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron weekly-style-refresh error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron weekly-style-refresh error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
