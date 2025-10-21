export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  // Supabase (service role) to bypass RLS for job insert
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey), tried: ['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVER_ROLE_KEY'] };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const insertBody = {
    type: 'update_style_stock',
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
  await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { daily: true } });
  const res = { jobId };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron styles error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron styles error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


