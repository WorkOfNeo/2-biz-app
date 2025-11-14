export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(req: Request) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
    if (!url || !serviceKey) {
      return new Response('Missing Supabase env', { status: 500 });
    }
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const id = String(body?.id || '').trim();
    const styleNo = String(body?.style_no || '').trim();
    const dg = body?.dg ?? null;
    if (!id || !styleNo) {
      return new Response('id and style_no are required', { status: 400 });
    }
    // Update top_styles.dg
    {
      const { error } = await supabase.from('top_styles').update({ dg }).eq('id', id);
      if (error) return new Response(error.message, { status: 500 });
    }
    // Best-effort update styles.dg as well
    {
      const { error } = await supabase.from('styles').update({ dg }).eq('style_no', styleNo);
      if (error) {
        // Do not fail entire request; just return success with note
        return new Response(JSON.stringify({ ok: true, note: 'Saved DG on top_styles; styles update failed' }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(e?.message || 'Server error', { status: 500 });
  }
}


