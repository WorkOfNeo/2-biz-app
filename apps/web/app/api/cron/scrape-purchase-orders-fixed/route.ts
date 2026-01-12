// DST-safe scrape_purchase_orders cron (Europe/Copenhagen)
// Schedule: 07:00, 12:00, 15:00 Copenhagen time
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
  const force = urlObj.searchParams.get('force') === '1';
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

  // Target hours: 07:00, 12:00, 15:00 Copenhagen time (window: first 10 minutes)
  const targetHours = [7, 12, 15];
  const isInWindow = targetHours.includes(cph.hour) && cph.minute >= 0 && cph.minute <= 9;

  if (!isInWindow && !force) {
    const res = { skipped: true, reason: 'outside scheduled window (07:00/12:00/15:00)', cph };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const runKey = `scrape_po:${cph.isoDate}-${String(cph.hour).padStart(2, '0')}:00`;

  // Dedupe: if we already enqueued this runKey, do nothing
  const { data: existing } = await supabase
    .from('jobs')
    .select('id,status')
    .eq('type', 'scrape_purchase_orders')
    .contains('payload', { requestedBy: 'cron_scrape_po_fixed', runKey })
    .order('created_at', { ascending: false })
    .limit(1);

  if ((existing ?? []).length > 0 && !force) {
    const res = { skipped: true, reason: 'already enqueued', runKey, existingJobId: (existing as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if a scrape_purchase_orders is already running
  const { data: running } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', 'scrape_purchase_orders')
    .in('status', ['queued', 'running'])
    .limit(1);

  if ((running ?? []).length > 0 && !force) {
    const res = { skipped: true, reason: 'scrape_purchase_orders already queued/running', existingJobId: (running as any)[0]?.id };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Enqueue scrape_purchase_orders job
  const { data: job, error: insErr } = await supabase
    .from('jobs')
    .insert({
      type: 'scrape_purchase_orders',
      payload: {
        requestedBy: 'cron_scrape_po_fixed',
        runKey,
      },
      status: 'queued',
      max_attempts: 3,
    } as any)
    .select('id')
    .single();

  if (insErr) {
    const errRes = { error: 'enqueue scrape_purchase_orders failed', detail: insErr.message };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }

  const jobId = (job as any)?.id as string;
  await supabase
    .from('job_logs')
    .insert({ job_id: jobId, level: 'info', msg: 'Enqueued via DST-safe cron', data: { runKey, cph } });

  const res = { enqueued: true, jobId, runKey, cph };
  return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-purchase-orders-fixed error' }), { status: 500 }); } }
export async function GET(req: Request) { try { return await handle(req); } catch (err: any) { return new Response(JSON.stringify({ error: err?.message || 'Cron scrape-purchase-orders-fixed error' }), { status: 500 }); } }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
