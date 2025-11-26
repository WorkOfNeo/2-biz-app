export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { po_id, season_id } = await req.json();
    
    if (!po_id || !season_id) {
      return new Response(
        JSON.stringify({ error: 'Missing po_id or season_id' }), 
        { status: 400 }
      );
    }
    
    const auth = req.headers.get('authorization') || '';
    const type = 'push_app_po_to_spy';
    const payload = { po_id, season_id };
    
    const urlBase = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');
    
    // Try orchestrator first
    if (urlBase) {
      try {
        const res = await fetch(urlBase + '/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ type, payload })
        });
        
        if (res.ok) {
          const text = await res.text();
          return new Response(text, { 
            status: res.status, 
            headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } 
          });
        }
        
        // Log non-OK responses
        try {
          const errText = await res.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.error('[push-app-po] orchestrator non-ok', res.status, errText);
        } catch {}
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[push-app-po] orchestrator fetch failed', e?.message || e);
      }
    }
    
    // Fallback: enqueue directly in Supabase
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    
    if (!url || !anonKey) {
      return new Response(
        JSON.stringify({ error: 'Supabase URL/anon key missing' }), 
        { status: 500 }
      );
    }
    
    // Use anon key with the caller's JWT so RLS sees an authenticated user
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: auth ? { Authorization: auth } : {} }
    });
    
    const insertBody = {
      type,
      payload,
      status: 'queued',
      max_attempts: 3,
      queue: 'default',
      priority: 100
    } as any;
    
    const { data, error } = await supabase
      .from('jobs')
      .insert(insertBody)
      .select('id')
      .single();
    
    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }), 
        { status: 500 }
      );
    }
    
    return new Response(
      JSON.stringify({ jobId: (data as any)?.id }), 
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'API error' }), 
      { status: 500 }
    );
  }
}

