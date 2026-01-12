// After-statistics exports cron: Triggers PDF exports and top styles after 15:00 scrape_statistics completes
// Runs frequently to check for recently-completed 15:00 scrape jobs
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

  // Only run between 15:15 and 18:00 Copenhagen time (after 15:00 scrape could complete)
  if (cph.hour < 15 || (cph.hour === 15 && cph.minute < 15) || cph.hour >= 18) {
    const res = { skipped: true, reason: 'outside window (15:15-18:00)', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Find the most recent succeeded 15:00 scrape_statistics job from today
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id,status,created_at,started_at,finished_at,payload')
    .eq('type', 'scrape_statistics')
    .eq('status', 'succeeded')
    .gte('finished_at', twoHoursAgo.toISOString())
    .order('finished_at', { ascending: false })
    .limit(5);

  if (jobsErr) {
    const errRes = { error: 'query jobs failed', detail: jobsErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  // Find a 15:00 run (cronHour === 15)
  const job = (jobs ?? []).find((j: any) => (j.payload as any)?.cronHour === 15);
  if (!job) {
    const res = { skipped: true, reason: 'no succeeded 15:00 scrape in last 2 hours' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `after_stats_15:${cph.isoDate}`;

  // Dedupe: check if we already enqueued exports for this day's 15:00 run
  const { data: existingExports } = await supabase
    .from('jobs')
    .select('id, type, payload, created_at')
    .in('type', ['export_overview', 'scrape_top_styles', 'export_top_styles'])
    .gte('created_at', (job as any).finished_at);
  
  const alreadyRan = (existingExports ?? []).some((j: any) => 
    j?.payload?.requestedBy === 'cron_after_stats_15' && j?.payload?.runKey === runKey
  );
  
  if (alreadyRan) {
    const res = { skipped: true, reason: 'exports already enqueued for this 15:00 scrape', scrapeJobId: (job as any).id, runKey };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue all required exports:
  // - General per salesperson (+ combined ZIP)
  // - Overview
  // - Countries
  // - Top styles scrape + export
  const inserts = [
    // Salesmen PDFs (general_salesmen_react_pdf produces per-salesperson PDFs + combined)
    { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: 'cron_after_stats_15', runKey, afterScrapeJobId: (job as any).id }, status: 'queued' as const, max_attempts: 3 },
    // Overview PDF
    { type: 'export_overview', payload: { mode: 'overview_react_pdf', requestedBy: 'cron_after_stats_15', runKey, afterScrapeJobId: (job as any).id }, status: 'queued' as const, max_attempts: 3 },
    // Countries PDF
    { type: 'export_overview', payload: { mode: 'countries_react_pdf', requestedBy: 'cron_after_stats_15', runKey, afterScrapeJobId: (job as any).id }, status: 'queued' as const, max_attempts: 3 },
    // Top styles scrape (which includes both top 15 salesmen and top 15 overall)
    { type: 'scrape_top_styles', payload: { requestedBy: 'cron_after_stats_15', runKey, afterScrapeJobId: (job as any).id }, status: 'queued' as const, max_attempts: 3 },
    // Export top styles PDF
    { type: 'export_top_styles', payload: { requestedBy: 'cron_after_stats_15', runKey, afterScrapeJobId: (job as any).id }, status: 'queued' as const, max_attempts: 3 },
  ];

  const { error: insErr } = await supabase.from('jobs').insert(inserts as any);
  if (insErr) {
    const errRes = { error: 'enqueue exports failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const res = { enqueued: inserts.length, afterJobId: (job as any).id, runKey, jobFinishedAt: (job as any).finished_at };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron after-statistics-exports error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron after-statistics-exports error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
