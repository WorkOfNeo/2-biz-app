export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const force = urlObj.searchParams.get('force') === '1';
  const diag: Record<string, any> = { stage: 'start' };
  // Authorization disabled to ensure Vercel cron runs reliably.
  // The endpoint is time-gated by CET hours below and performs idempotent enqueue with dedupe.

  // Compute current hour in Europe/Copenhagen
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Copenhagen' });
  const hour = Number(fmt.format(now));
  const allowed = new Set([7, 9, 10, 12, 13, 14, 15]);
  if (!allowed.has(hour) && !force) {
    const res = { skipped: true, reason: 'outside allowed CET hours', hour };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200 });
  }

  // Supabase (service role) to bypass RLS for job insert
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey), tried: ['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVER_ROLE_KEY'] };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  diag.stage = 'client_created';

  // Dedupe: if a scrape job is queued or running, skip
  const { data: existing, error: existErr } = await supabase
    .from('jobs')
    .select('id,status')
    .in('status', ['queued', 'running'])
    .eq('type', 'scrape_statistics')
    .limit(1);
  if (existErr) {
    const errRes = { error: 'dedupe query failed', detail: existErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  if (existing && existing.length > 0) {
    const res = { skipped: true, reason: 'already queued or running' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200 });
  }

  // Load configured season comparison (use s1 as target season)
  const { data: setting, error: settingErr } = await supabase
    .from('app_settings')
    .select('id, value')
    .eq('key', 'season_compare')
    .maybeSingle();
  if (settingErr) {
    const errRes = { error: 'load season_compare failed', detail: settingErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const seasonId = (setting?.value as any)?.s1 as string | undefined;

  const insertBody = {
    type: 'scrape_statistics',
    payload: { toggles: { deep: true }, requestedBy: 'cron', seasonId },
    status: 'queued' as const,
    max_attempts: 3
  };
  const { data: job, error } = await supabase.from('jobs').insert(insertBody).select('id').single();
  if (error) {
    const errRes = { error: 'job insert failed', detail: error.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const jobId = (job as any)?.id as string;
  // Initial log entry for visibility
  const { error: logErr } = await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { hourCET: hour } });
  if (logErr) {
    const errRes = { warning: 'job log insert failed', detail: logErr.message, jobId };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 200 });
  }

  const res = { jobId };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) {
  try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron enqueue error' }), { status: 500 }); }
}

export async function GET(req: Request) {
  try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron enqueue error' }), { status: 500 }); }
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }


