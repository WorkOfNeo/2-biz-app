export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 });
    const auth = req.headers.get('authorization') || '';
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!url || !anonKey) return new Response(JSON.stringify({ error: 'Supabase env missing' }), { status: 500 });
    const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: auth ? { Authorization: auth } : {} } });
    // Mark job cancelled with reason; worker will observe and stop
    const { error } = await supabase
      .from('jobs')
      .update({ status: 'cancelled', error: 'Stopped by staff', finished_at: new Date().toISOString(), lease_until: null })
      .eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    try { await supabase.from('job_logs').insert({ job_id: id, level: 'info', msg: 'Stopped by staff' }); } catch {}
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Stop failed' }), { status: 500 });
  }
}


