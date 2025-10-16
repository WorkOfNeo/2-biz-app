export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const token = req.headers.get('x-cron-token') || new URL(req.url).searchParams.get('token') || '';
    const vercelCron = req.headers.get('x-vercel-cron');
    const expected = (process.env.CRON_TOKEN || '').trim();
    // Allow either matching CRON_TOKEN or Vercel Cron header
    if (!((expected && token === expected) || vercelCron)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    // Compute current hour in Europe/Copenhagen
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Copenhagen' });
    const hour = Number(fmt.format(now));
    const allowed = new Set([7, 9, 10, 12, 13, 14, 15]);
    if (!allowed.has(hour)) {
      return new Response(JSON.stringify({ skipped: true, reason: 'outside allowed CET hours', hour }), { status: 200 });
    }

    // Supabase (service role) to bypass RLS for job insert
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Supabase env missing' }), { status: 500 });
    }
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Dedupe: if a scrape job is queued or running, skip
    const { data: existing, error: existErr } = await supabase
      .from('jobs')
      .select('id,status')
      .in('status', ['queued', 'running'])
      .eq('type', 'scrape_statistics')
      .limit(1);
    if (!existErr && existing && existing.length > 0) {
      return new Response(JSON.stringify({ skipped: true, reason: 'already queued or running' }), { status: 200 });
    }

    // Load configured season comparison (use s1 as target season)
    const { data: setting } = await supabase
      .from('app_settings')
      .select('id, value')
      .eq('key', 'season_compare')
      .maybeSingle();
    const seasonId = (setting?.value as any)?.s1 as string | undefined;

    const insertBody = {
      type: 'scrape_statistics',
      payload: { toggles: { deep: true }, requestedBy: 'cron', seasonId },
      status: 'queued' as const,
      max_attempts: 3
    };
    const { data: job, error } = await supabase.from('jobs').insert(insertBody).select('id').single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    const jobId = (job as any)?.id as string;
    // Initial log entry for visibility
    await supabase.from('job_logs').insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { hourCET: hour } });

    return new Response(JSON.stringify({ jobId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Cron enqueue error' }), { status: 500 });
  }
}


