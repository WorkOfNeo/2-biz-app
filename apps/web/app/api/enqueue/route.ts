export async function POST(req: Request) {
  try {
    const body = await req.text();
    const auth = req.headers.get('authorization') || '';
    const urlBase = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');
    if (!urlBase) return new Response(JSON.stringify({ error: 'ORCHESTRATOR URL missing' }), { status: 500 });
    const res = await fetch(urlBase + '/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Proxy error' }), { status: 500 });
  }
}


