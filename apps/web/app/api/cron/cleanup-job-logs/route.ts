export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();

  if (!url || !serviceKey) {
    const errRes = {
      error: 'Supabase env missing',
      urlPresent: Boolean(url),
      serviceKeyPresent: Boolean(serviceKey),
      tried: ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVER_ROLE_KEY']
    };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { error, count } = await supabase
    .from('job_logs')
    .delete()
    .neq('level', 'error')
    .select('id', { count: 'exact' });

  if (error) {
    const errRes = { error: 'job_logs cleanup failed', detail: error.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const res = { deleted: count ?? 0 };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Cron cleanup-job-logs error' }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Cron cleanup-job-logs error' }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

