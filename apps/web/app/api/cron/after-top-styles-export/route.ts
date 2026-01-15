// After-top-styles export cron: Triggers export_top_styles after 07:00 or 15:00 scrape_top_styles completes
// Runs frequently to check for recently-completed scrape_top_styles jobs.
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

function pickTargetHour(cph: { hour: number; minute: number }): 7 | 15 | null {
  // Morning window: 07:15–12:00
  if (cph.hour > 7 && cph.hour < 12) return 7;
  if (cph.hour === 7 && cph.minute >= 15) return 7;

  // Afternoon window: 15:15–18:00
  if (cph.hour > 15 && cph.hour < 18) return 15;
  if (cph.hour === 15 && cph.minute >= 15) return 15;

  return null;
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
  const targetHour = pickTargetHour(cph);

  if (!targetHour) {
    const res = { skipped: true, reason: 'outside window (07:15-12:00 or 15:15-18:00)', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const lookbackHours = targetHour === 7 ? 3 : 2;
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

  // Find the most recent succeeded scrape_top_styles job from the recent window
  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id,status,created_at,started_at,finished_at,payload')
    .eq('type', 'scrape_top_styles')
    .eq('status', 'succeeded')
    .gte('finished_at', since.toISOString())
    .order('finished_at', { ascending: false })
    .limit(10);

  if (jobsErr) {
    const errRes = { error: 'query jobs failed', detail: jobsErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const scrapeJob = (jobs ?? []).find((j: any) => (j.payload as any)?.cronHour === targetHour);
  if (!scrapeJob) {
    const res = { skipped: true, reason: `no succeeded ${targetHour}:00 scrape_top_styles in last ${lookbackHours} hours` };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `after_top_styles_${targetHour}:${cph.isoDate}`;
  const requestedBy = `cron_after_top_styles_${targetHour}`;

  // Dedupe: check if export already enqueued for this run after this scrape finished
  const { data: existingExports } = await supabase
    .from('jobs')
    .select('id, type, payload, created_at')
    .eq('type', 'export_top_styles')
    .gte('created_at', (scrapeJob as any).finished_at);

  const alreadyRan = (existingExports ?? []).some((j: any) => j?.payload?.requestedBy === requestedBy && j?.payload?.runKey === runKey);
  if (alreadyRan) {
    const res = { skipped: true, reason: 'export_top_styles already enqueued for this scrape', scrapeJobId: (scrapeJob as any).id, runKey };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue export_top_styles
  const { error: insErr } = await supabase.from('jobs').insert([
    {
      type: 'export_top_styles',
      payload: { requestedBy, runKey, afterScrapeJobId: (scrapeJob as any).id },
      status: 'queued' as const,
      max_attempts: 3,
    },
  ] as any);

  if (insErr) {
    const errRes = { error: 'enqueue export_top_styles failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const res = { enqueued: true, targetHour, runKey, afterScrapeJobId: (scrapeJob as any).id, jobFinishedAt: (scrapeJob as any).finished_at };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Cron after-top-styles-export error' }), { status: 500 });
  }
}
export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Cron after-top-styles-export error' }), { status: 500 });
  }
}
export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

