// Fixed-time statistics export (Europe/Copenhagen), triggered by a frequent Vercel cron.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEZONE = 'Europe/Copenhagen';

function getCopenhagenParts(date: Date): { isoDate: string; hour: number; minute: number } {
  // We use formatToParts to avoid locale quirks and remain DST-safe.
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
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey), tried: ['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVER_ROLE_KEY'] };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const now = new Date();
  const cph = getCopenhagenParts(now);

  // Trigger window: within first 10 minutes of 07:00 and 15:00 Copenhagen time.
  const isTargetHour = cph.hour === 7 || cph.hour === 15;
  const inWindow = cph.minute >= 0 && cph.minute <= 9;
  if (!isTargetHour || !inWindow) {
    const res = { skipped: true, reason: 'outside scheduled window', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `${cph.isoDate}-${String(cph.hour).padStart(2, '0')}`; // once per target hour per day

  // Dedupe: if we already enqueued this runKey, do nothing.
  const { data: existing } = await supabase
    .from('jobs')
    .select('id,status')
    .eq('type', 'export_overview')
    .contains('payload', { requestedBy: 'cron_statistics_export', runKey })
    .order('created_at', { ascending: false })
    .limit(1);
  if ((existing ?? []).length > 0) {
    const res = { skipped: true, reason: 'already enqueued', runKey, existingJobId: (existing as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const inserts = [
    { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: 'cron_statistics_export', runKey }, status: 'queued' as const, max_attempts: 3 },
    { type: 'export_overview', payload: { mode: 'overview_react_pdf', requestedBy: 'cron_statistics_export', runKey }, status: 'queued' as const, max_attempts: 3 },
    { type: 'export_overview', payload: { mode: 'countries_react_pdf', requestedBy: 'cron_statistics_export', runKey }, status: 'queued' as const, max_attempts: 3 },
  ];
  const { error: insErr } = await supabase.from('jobs').insert(inserts as any);
  if (insErr) {
    const errRes = { error: 'enqueue exports failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const res = { enqueued: inserts.length, runKey, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron export-statistics-fixed error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron export-statistics-fixed error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }

