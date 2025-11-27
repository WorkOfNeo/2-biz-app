export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    // Get request body
    const { po_id, spy_po_no } = await req.json();
    
    if (!po_id || !spy_po_no) {
      return new Response(
        JSON.stringify({ error: 'Missing po_id or spy_po_no' }), 
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Get auth header
    const auth = req.headers.get('authorization');
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Get Supabase credentials
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    
    if (!url || !anonKey) {
      throw new Error('Missing Supabase environment variables');
    }
    
    // Use anon key with the caller's JWT so RLS sees an authenticated user
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: auth ? { Authorization: auth } : {} }
    });
    
    // Enqueue job
    const insertBody = {
      type: 'sync_app_po_from_spy' as const,
      payload: { po_id, spy_po_no },
      status: 'queued' as const,
      priority: 100
    } as any;
    
    const { data, error } = await supabase
      .from('jobs')
      .insert(insertBody)
      .select('id')
      .single();
    
    if (error || !data) {
      throw new Error(`Failed to enqueue job: ${error?.message || 'Unknown error'}`);
    }
    
    return new Response(
      JSON.stringify({ jobId: data.id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error syncing APP PO:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to sync APP PO' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

