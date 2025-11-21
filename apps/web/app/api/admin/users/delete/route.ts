import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { user_id } = await req.json();
    if (!user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 });
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    // Remove user_roles
    await admin.from('user_roles').delete().eq('user_id', user_id);
    // Cleanup optional app_settings maps
    try {
      const { data: prof } = await admin.from('app_settings').select('id,value').eq('key', 'user_profiles').maybeSingle();
      if (prof?.id) {
        const map = ((prof.value as any) || {}) as Record<string, string>;
        if (map[user_id]) { delete map[user_id]; await admin.from('app_settings').update({ value: map }).eq('id', prof.id); }
      }
    } catch {}
    try {
      const { data: emails } = await admin.from('app_settings').select('id,value').eq('key', 'user_emails').maybeSingle();
      if (emails?.id) {
        const map = ((emails.value as any) || {}) as Record<string, string>;
        // Remove any entry with this user id as key or value
        let changed = false;
        if (map[user_id]) { delete map[user_id]; changed = true; }
        for (const k of Object.keys(map)) { if (map[k] === user_id) { delete map[k]; changed = true; } }
        if (changed) await admin.from('app_settings').update({ value: map }).eq('id', emails.id);
      }
    } catch {}
    // Delete auth user
    const resp: any = (admin as any).auth?.admin;
    if (resp?.deleteUser) {
      const { error } = await resp.deleteUser(user_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


