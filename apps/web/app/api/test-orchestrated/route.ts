import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const ORCH_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || process.env.ORCHESTRATOR_URL;
  const CRON_TOKEN = process.env.CRON_TOKEN;
  if (!ORCH_URL || !CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: 'Missing ORCHESTRATOR_URL/CRON_TOKEN' }, { status: 500 });
  }

  try {
    const base = ORCH_URL.startsWith('http://') || ORCH_URL.startsWith('https://') ? ORCH_URL : `https://${ORCH_URL}`;
    const target = new URL('/cron/enqueue', base).toString();
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'x-cron-token': CRON_TOKEN }
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const message = (json && (json.error || json.message)) || text || `HTTP ${res.status}`;
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
    const jobId = json?.jobId ?? null;
    return NextResponse.json({ ok: true, jobId, raw: json ?? text });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
}


