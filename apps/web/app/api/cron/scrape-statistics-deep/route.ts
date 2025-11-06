export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey), tried: ['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVER_ROLE_KEY'] };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Dedupe: skip if a scrape_statistics job is already queued or running
  {
    const { data: existing, error: existErr } = await supabase
      .from('jobs')
      .select('id,status')
      .in('status', ['queued','running'])
      .eq('type', 'scrape_statistics')
      .limit(1);
    if (!existErr && existing && existing.length > 0) {
      const res = { skipped: true, reason: 'already queued or running' };
      return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  // Prefer configured season_compare.s1 if present
  let seasonId: string | undefined = undefined;
  try {
    const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle();
    seasonId = (setting?.value as any)?.s1 as string | undefined;
  } catch {}
  const insertBody = {
    type: 'scrape_statistics',
    payload: { requestedBy: 'cron', toggles: { deep: true }, ...(seasonId ? { seasonId } : {}) },
    status: 'queued' as const,
    max_attempts: 3
  };
  const { data: job, error } = await supabase.from('jobs').insert(insertBody).select('id').single();
  if (error) {
    const errRes = { error: 'job insert failed', detail: error.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const jobId = (job as any)?.id as string;
  await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { kind: 'scrape_statistics_deep' } });
  const res = { jobId };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-statistics-deep error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-statistics-deep error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


