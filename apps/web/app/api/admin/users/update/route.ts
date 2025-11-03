import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { user_id, name, email } = body as { user_id: string; name?: string; email?: string };
    if (!user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 });
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Upsert name
    if (name !== undefined) {
      const { data: prof } = await admin.from('app_settings').select('id, value').eq('key', 'user_profiles').maybeSingle();
      const current = ((prof as any)?.value as Record<string, string> | undefined) || {};
      current[user_id] = name;
      if (prof) {
        await admin.from('app_settings').update({ value: current }).eq('id', (prof as any).id);
      } else {
        await admin.from('app_settings').insert({ key: 'user_profiles', value: current });
      }
    }
    // Upsert email
    if (email !== undefined) {
      const { data: em } = await admin.from('app_settings').select('id, value').eq('key', 'user_emails').maybeSingle();
      const currentE = ((em as any)?.value as Record<string, string> | undefined) || {};
      currentE[user_id] = email;
      if (em) {
        await admin.from('app_settings').update({ value: currentE }).eq('id', (em as any).id);
      } else {
        await admin.from('app_settings').insert({ key: 'user_emails', value: currentE });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


