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
    const allowed = new Set(['admin','purchase','finance','sales']);
    for (const r of (rolesRows ?? []) as any[]) {
      const set = roleMap.get(r.user_id) || new Set<string>();
      const normalized = String(r.role || '').trim().toLowerCase();
      if (!allowed.has(normalized)) {
        // Skip legacy or unknown roles (e.g., 'viewer')
        roleMap.set(r.user_id, set);
        continue;
      }
      set.add(normalized);
      roleMap.set(r.user_id, set);
    }
    // Profiles
    let profiles: Record<string, string> = {};
    try {
      const { data: prof } = await admin.from('app_settings').select('value').eq('key', 'user_profiles').maybeSingle();
      profiles = ((prof as any)?.value as Record<string, string> | undefined) || {};
    } catch {}
    // Fetch all auth users (paged) and enrich with roles, profiles
    const users: Array<{ user_id: string; name: string; email: string; roles: string[]; last_active: string | null }> = [];
    try {
      const auth = (admin as any).auth?.admin;
      if (auth?.listUsers) {
        let page = 1; const perPage = 200; let done = false;
        while (!done) {
          const res = await auth.listUsers({ page, perPage });
          const list = (res?.data?.users || []) as any[];
          for (const u of list) {
            const uid = String(u.id || '');
            if (!uid) continue;
            const email = String(u.email || '');
            const nameMeta = (u.user_metadata?.name as string | undefined) || '';
            const lastActive = (u.last_sign_in_at as string | null) || (u.updated_at as string | null) || null;
            users.push({
              user_id: uid,
              name: profiles[uid] || nameMeta || '',
              email,
              roles: Array.from(roleMap.get(uid) || new Set<string>()),
              last_active: lastActive
            });
          }
          done = !list || list.length < perPage; page++;
        }
      }
    } catch {
      // Fallback to role map only (older environments)
      for (const uid of Array.from(roleMap.keys())) {
        users.push({
          user_id: uid,
          name: profiles[uid] || '',
          email: '',
          roles: Array.from(roleMap.get(uid) || new Set<string>()),
          last_active: null
        });
      }
    }
    return NextResponse.json({ users });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


