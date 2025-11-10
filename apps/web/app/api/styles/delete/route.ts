export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { styleNo } = await req.json();
    if (!styleNo || typeof styleNo !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing styleNo' }), { status: 400 });
    }
    const auth = req.headers.get('authorization') || '';
    // Verify user is admin using anon client with caller's JWT (RLS enforced)
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
    if (!url || !anonKey || !svcKey) {
      return new Response(JSON.stringify({ error: 'Supabase env missing' }), { status: 500 });
    }
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: auth ? { Authorization: auth } : {} }
    });
    const { data: roles } = await anon.from('user_roles').select('role');
    const isAdmin = (roles ?? []).some((r: any) => String(r.role || '') === 'admin');
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }
    // Service role client for deletion (bypass RLS)
    const svc = createClient(url, svcKey, { auth: { persistSession: false, autoRefreshToken: false } });
    // Look up style id
    const { data: style } = await svc.from('styles').select('id, style_no').eq('style_no', styleNo).maybeSingle();
    const styleId = (style as any)?.id as string | undefined;
    // 1) Movements by style_no
    await svc.from('style_stock_movements').delete().eq('style_no', styleNo);
    // 2) style_stock legacy by style_no (FK-cascade will handle linked ones anyway)
    await svc.from('style_stock').delete().eq('style_no', styleNo);
    // 3) style_colors for style id (cascades to color seasons and stock via FKs)
    if (styleId) {
      await svc.from('style_colors').delete().eq('style_id', styleId);
    }
    // 4) Delete style
    await svc.from('styles').delete().eq('style_no', styleNo);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Delete error' }), { status: 500 });
  }
}


