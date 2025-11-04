import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: rolesRows, error: rolesErr } = await admin.from('user_roles').select('user_id, role');
    if (rolesErr) return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    // Build map
    const roleMap = new Map<string, Set<string>>();
    for (const r of (rolesRows ?? []) as any[]) {
      const set = roleMap.get(r.user_id) || new Set<string>();
      set.add(r.role);
      roleMap.set(r.user_id, set);
    }
    // Profiles
    let profiles: Record<string, string> = {};
    try {
      const { data: prof } = await admin.from('app_settings').select('value').eq('key', 'user_profiles').maybeSingle();
      profiles = ((prof as any)?.value as Record<string, string> | undefined) || {};
    } catch {}
    // Emails from app_settings fallback; enrich from auth admin when possible
    let emails: Record<string, string> = {};
    try {
      const { data: em } = await admin.from('app_settings').select('value').eq('key', 'user_emails').maybeSingle();
      emails = ((em as any)?.value as Record<string, string> | undefined) || {};
    } catch {}
    try {
      // Fetch auth users and map ids to emails
      const auth = (admin as any).auth?.admin;
      if (auth?.listUsers) {
        let page = 1; const perPage = 200; let done = false;
        const idSet = new Set<string>(Array.from(roleMap.keys()));
        while (!done) {
          const res = await auth.listUsers({ page, perPage });
          const users = (res?.data?.users || []) as any[];
          for (const u of users) {
            const id = u.id as string; const email = u.email as string | null;
            if (id && email && idSet.has(id)) emails[id] = email;
          }
          done = !users || users.length < perPage; page++;
        }
      }
    } catch {}
    const users = Array.from(roleMap.keys()).map((uid) => ({
      user_id: uid,
      name: profiles[uid] || '',
      email: emails[uid] || '',
      roles: Array.from(roleMap.get(uid) || new Set<string>())
    }));
    return NextResponse.json({ users });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


