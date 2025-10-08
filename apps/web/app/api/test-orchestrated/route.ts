import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const ORCH_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || process.env.ORCHESTRATOR_URL;
  const CRON_TOKEN = process.env.CRON_TOKEN;
  if (!ORCH_URL || !CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: 'Missing ORCHESTRATOR_URL/CRON_TOKEN' }, { status: 500 });
  }

  const res = await fetch(`${ORCH_URL}/cron/enqueue`, {
    method: 'POST',
    headers: { 'x-cron-token': CRON_TOKEN }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json({ ok: false, error: json?.error ?? 'Failed' }, { status: 500 });
  return NextResponse.json({ ok: true, jobId: json.jobId });
}


