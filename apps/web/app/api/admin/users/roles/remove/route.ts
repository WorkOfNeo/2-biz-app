import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { user_id, role } = await req.json();
    if (!user_id || !role) return NextResponse.json({ error: 'user_id and role required' }, { status: 400 });
    const targetNorm = String(role).trim().toLowerCase();
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    // Load roles to find exact stored variant matching normalized target
    const { data: rows, error: selErr } = await admin.from('user_roles').select('role').eq('user_id', user_id);
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 400 });
    const match = (rows || []).map((r:any)=> String(r.role)).find((x)=> x.trim().toLowerCase() === targetNorm);
    if (!match) return NextResponse.json({ ok: true, note: 'role not found' });
    const { error } = await admin.from('user_roles').delete().eq('user_id', user_id).eq('role', match);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


