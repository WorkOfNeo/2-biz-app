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
    // Emails
    let emails: Record<string, string> = {};
    try {
      const { data: em } = await admin.from('app_settings').select('value').eq('key', 'user_emails').maybeSingle();
      emails = ((em as any)?.value as Record<string, string> | undefined) || {};
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


