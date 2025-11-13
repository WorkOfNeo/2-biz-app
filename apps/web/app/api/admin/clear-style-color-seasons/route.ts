export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase env' }), { status: 500 });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Optional: require a simple confirmation header to avoid accidents
  const confirm = new URL(req.url).searchParams.get('confirm');
  if (confirm !== '1') {
    return new Response(JSON.stringify({ error: 'Pass ?confirm=1 to clear seasons' }), { status: 400 });
  }
  const { error } = await supabase.from('style_color_seasons').delete().neq('style_color_id', ''); // delete all rows
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


