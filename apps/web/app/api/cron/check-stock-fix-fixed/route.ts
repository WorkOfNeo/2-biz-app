// DST-safe check_stock_fix cron (Europe/Copenhagen): 07:30, 12:30, 15:30
// Runs via frequent Vercel cron and checks Copenhagen time window before enqueuing.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';

function getCopenhagenParts(date: Date): { isoDate: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return { isoDate: `${year}-${month}-${day}`, hour, minute };
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

  const now = new Date();
  const cph = getCopenhagenParts(now);

  // Trigger windows: 07:30-07:39, 12:30-12:39, 15:30-15:39 Copenhagen time
  const targetSlots = [
    { hour: 7, minute: 30 },
    { hour: 12, minute: 30 },
    { hour: 15, minute: 30 },
  ];
  
  const isInWindow = targetSlots.some(slot => 
    cph.hour === slot.hour && cph.minute >= slot.minute && cph.minute <= slot.minute + 9
  );
  
  if (!isInWindow) {
    const res = { skipped: true, reason: 'outside scheduled window', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `check_stock_fix:${cph.isoDate}-${String(cph.hour).padStart(2, '0')}:30`;

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

  // Enqueue check_stock_fix with autoFix enabled
  const { data: job, error: insErr } = await supabase
    .from('jobs')
    .insert({
      type: 'check_stock_fix',
      payload: {
        requestedBy: 'cron_check_stock_fix',
        runKey,
        autoFix: true, // Auto-enqueue update_style_stock for mismatches
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
    .insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { kind: 'check_stock_fix', runKey, autoFix: true } });

  const res = { enqueued: true, jobId, runKey, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron check-stock-fix-fixed error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron check-stock-fix-fixed error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
