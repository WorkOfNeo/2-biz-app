export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  // Use Supabase service key to bypass RLS for job reads/inserts
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey) };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Determine today's 15:00 CET boundary
  const tz = 'Europe/Copenhagen';
  const now = new Date();
  const todayCET = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const boundary = new Date(todayCET);
  boundary.setHours(15, 0, 0, 0);

  // Find the most recent deep scrape job started after 15:00 CET today
  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id,status,created_at,started_at,finished_at,payload')
    .eq('type', 'scrape_statistics')
    .gte('created_at', boundary.toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  if (jobsErr) {
    const errRes = { error: 'query jobs failed', detail: jobsErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const job = (jobs ?? [])[0] as any | undefined;
  if (!job) {
    const res = { skipped: true, reason: 'no deep scrape job after 15:00 CET found' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (job.status !== 'succeeded') {
    const res = { skipped: true, reason: `deep scrape not succeeded yet (${job.status})`, jobId: job.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Dedupe: if we already enqueued exports after this boundary today, skip
  const { data: existingExports } = await supabase
    .from('jobs')
    .select('id, type, payload, created_at')
    .gte('created_at', boundary.toISOString())
    .in('type', ['export_overview', 'export_top_styles']);
  const alreadyRan = (existingExports ?? []).some((j: any) => j?.payload?.requestedBy === 'cron_after_deep');
  if (alreadyRan) {
    const res = { skipped: true, reason: 'exports already enqueued today after deep', count: (existingExports ?? []).length };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue exports (do not block; queue sequential jobs, worker handles execution)
  const inserts = [
    { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: 'cron_after_deep' }, status: 'queued' as const, max_attempts: 3 },
    { type: 'export_overview', payload: { mode: 'overview_react_pdf', requestedBy: 'cron_after_deep' }, status: 'queued' as const, max_attempts: 3 },
    { type: 'export_overview', payload: { mode: 'countries_react_pdf', requestedBy: 'cron_after_deep' }, status: 'queued' as const, max_attempts: 3 },
    { type: 'export_top_styles', payload: { requestedBy: 'cron_after_deep' }, status: 'queued' as const, max_attempts: 3 },
  ];
  const { error: insErr } = await supabase.from('jobs').insert(inserts as any);
  if (insErr) {
    const errRes = { error: 'enqueue exports failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const res = { enqueued: inserts.length, afterJobId: job.id };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron exports-after-deep error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron exports-after-deep error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


