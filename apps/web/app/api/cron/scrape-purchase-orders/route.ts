export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const force = urlObj.searchParams.get('force') === '1';

  // Supabase (service role) to bypass RLS for job insert
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey) };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Dedupe: if a scrape_purchase_orders job is queued or running, skip
  const { data: existing, error: existErr } = await supabase
    .from('jobs')
    .select('id,status')
    .in('status', ['queued', 'running'])
    .eq('type', 'scrape_purchase_orders')
    .limit(1);
  if (existErr) {
    const errRes = { error: 'dedupe query failed', detail: existErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  if (existing && existing.length > 0 && !force) {
    const res = { skipped: true, reason: 'already queued or running' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200 });
  }

  const insertBody = {
    type: 'scrape_purchase_orders',
    payload: { requestedBy: 'cron' },
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
  await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron (daily PO scrape)', data: {} });

  const res = { jobId, enqueued: 'scrape_purchase_orders' };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) {
  try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron enqueue error' }), { status: 500 }); }
}

export async function GET(req: Request) {
  try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron enqueue error' }), { status: 500 }); }
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }



