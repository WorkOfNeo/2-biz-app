// AI Analysis after 07:00 style-details scrape completes
// Runs frequently to check for completed 07:00 scrape, then triggers daily AI analysis
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

  // Only run between 07:15 and 12:00 Copenhagen time (after 07:00 scrape could complete)
  if (cph.hour < 7 || (cph.hour === 7 && cph.minute < 15) || cph.hour >= 12) {
    const res = { skipped: true, reason: 'outside window (07:15-12:00)', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Find the most recent succeeded 07:00 scrape_statistics job from today (with style_details)
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id,status,created_at,started_at,finished_at,payload')
    .eq('type', 'scrape_statistics')
    .eq('status', 'succeeded')
    .gte('finished_at', threeHoursAgo.toISOString())
    .order('finished_at', { ascending: false })
    .limit(5);

  if (jobsErr) {
    const errRes = { error: 'query jobs failed', detail: jobsErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  // Find a 07:00 run (cronHour === 7) with style_details
  const job = (jobs ?? []).find((j: any) => {
    const payload = j.payload as any;
    return payload?.cronHour === 7 && payload?.toggles?.style_details === true;
  });
  
  if (!job) {
    const res = { skipped: true, reason: 'no succeeded 07:00 style-details scrape in last 3 hours' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `ai_after_style_details:${cph.isoDate}`;

  // Dedupe: check if we already enqueued AI analysis for today's 07:00 run
  const { data: existingAi } = await supabase
    .from('jobs')
    .select('id, payload, created_at')
    .eq('type', 'run_ai_analysis')
    .gte('created_at', (job as any).finished_at);
  
  const alreadyRan = (existingAi ?? []).some((j: any) => 
    j?.payload?.requestedBy === 'cron_ai_after_style_details' && j?.payload?.runKey === runKey
  );
  
  if (alreadyRan) {
    const res = { skipped: true, reason: 'AI analysis already enqueued for this 07:00 scrape', scrapeJobId: (job as any).id, runKey };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Get season settings
  const { data: setting } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'season_compare')
    .maybeSingle();
  
  const seasonId = (setting?.value as any)?.s1;
  const comparisonSeasonId = (setting?.value as any)?.s2;

  if (!seasonId) {
    const res = { skipped: true, reason: 'No season configured in season_compare settings' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if season is frozen
  const { data: seasonRow } = await supabase
    .from('seasons')
    .select('is_frozen, name, year')
    .eq('id', seasonId)
    .maybeSingle();

  if ((seasonRow as any)?.is_frozen) {
    const res = { skipped: true, reason: 'Season is frozen', seasonId };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue AI analysis job
  const { data: aiJob, error: insErr } = await supabase
    .from('jobs')
    .insert({
      type: 'run_ai_analysis',
      payload: {
        requestedBy: 'cron_ai_after_style_details',
        runKey,
        afterScrapeJobId: (job as any).id,
        analysisType: 'daily',
        seasonId,
        comparisonSeasonId,
        sendEmail: true,
      },
      status: 'queued',
      max_attempts: 3,
    } as any)
    .select('id')
    .single();

  if (insErr) {
    const errRes = { error: 'enqueue run_ai_analysis failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const jobId = (aiJob as any)?.id as string;
  await supabase
    .from('job_logs')
    .insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron after 07:00 style-details', data: { runKey, afterScrapeJobId: (job as any).id } });

  const res = { enqueued: true, jobId, runKey, afterScrapeJobId: (job as any).id, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron ai-after-style-details error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron ai-after-style-details error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
