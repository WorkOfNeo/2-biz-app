import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { user_id, role } = await req.json();
    if (!user_id || !role) return NextResponse.json({ error: 'user_id and role required' }, { status: 400 });
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    // Idempotent add: ignore duplicates on (user_id, role)
    const { error } = await admin
      .from('user_roles')
      .upsert({ user_id, role } as any, { onConflict: 'user_id,role', ignoreDuplicates: true } as any);
    if (error) return NextResponse.json({ error: error.message, hint: 'Failed to add role (duplicate or invalid?)' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


