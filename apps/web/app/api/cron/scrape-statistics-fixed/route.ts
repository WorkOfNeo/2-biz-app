// DST-safe scrape_statistics cron (Europe/Copenhagen)
// Schedule: 07:00, 09:00, 11:00, 13:00, 15:00
// At 07:00 and 15:00: deep + style_details
// At 09:00, 11:00, 13:00: deep only (no style_details)
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

  // Target hours and their configurations
  const scheduleConfig: Record<number, { styleDetails: boolean }> = {
    7: { styleDetails: true },   // 07:00 - with style details
    9: { styleDetails: false },  // 09:00 - deep only
    11: { styleDetails: false }, // 11:00 - deep only
    13: { styleDetails: false }, // 13:00 - deep only
    15: { styleDetails: true },  // 15:00 - with style details
  };

  const config = scheduleConfig[cph.hour];
  const isInWindow = config !== undefined && cph.minute >= 0 && cph.minute <= 9;

  if (!isInWindow) {
    const res = { skipped: true, reason: 'outside scheduled window', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `scrape_statistics:${cph.isoDate}-${String(cph.hour).padStart(2, '0')}:00`;

  // Dedupe: if we already enqueued this runKey today, do nothing
  const { data: existing } = await supabase
    .from('jobs')
    .select('id,status')
    .eq('type', 'scrape_statistics')
    .contains('payload', { requestedBy: 'cron_scrape_statistics', runKey })
    .order('created_at', { ascending: false })
    .limit(1);

  if ((existing ?? []).length > 0) {
    const res = { skipped: true, reason: 'already enqueued', runKey, existingJobId: (existing as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if a scrape_statistics is already running
  const { data: running } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', 'scrape_statistics')
    .in('status', ['queued', 'running'])
    .limit(1);

  if ((running ?? []).length > 0) {
    const res = { skipped: true, reason: 'scrape_statistics already queued/running', existingJobId: (running as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Get season_compare.s1 if configured
  let seasonId: string | undefined = undefined;
  try {
    const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'season_compare').maybeSingle();
    seasonId = (setting?.value as any)?.s1 as string | undefined;
  } catch {}

  // Check if the target season is frozen
  if (seasonId) {
    try {
      const { data: seasonRow } = await supabase
        .from('seasons')
        .select('is_frozen')
        .eq('id', seasonId)
        .maybeSingle();
      if ((seasonRow as any)?.is_frozen) {
        const res = { skipped: true, reason: 'season is frozen', seasonId };
        return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch {}
  }

  // Build toggles based on schedule config
  const toggles: { deep: boolean; style_details?: boolean } = { deep: true };
  if (config!.styleDetails) {
    toggles.style_details = true;
  }

  // Enqueue scrape_statistics job
  const { data: job, error: insErr } = await supabase
    .from('jobs')
    .insert({
      type: 'scrape_statistics',
      payload: {
        requestedBy: 'cron_scrape_statistics',
        runKey,
        toggles,
        ...(seasonId ? { seasonId } : {}),
        cronHour: cph.hour, // Used by after-statistics-exports to identify 15:00 run
      },
      status: 'queued',
      max_attempts: 3,
    } as any)
    .select('id')
    .single();

  if (insErr) {
    const errRes = { error: 'enqueue scrape_statistics failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const jobId = (job as any)?.id as string;
  await supabase
    .from('job_logs')
    .insert({ job_id: jobId, level: 'info', msg: 'Enqueued via cron', data: { kind: 'scrape_statistics', runKey, toggles, seasonId } });

  const res = { enqueued: true, jobId, runKey, toggles, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-statistics-fixed error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-statistics-fixed error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
