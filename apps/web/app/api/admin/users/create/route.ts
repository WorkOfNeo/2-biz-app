export const runtime = 'nodejs';
import { NextResponse } from 'next/server'; // admin create user
import { createClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
    const { name, email, password, role } = await request.json();
    if (!email || !password || !role) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      const missing = [!SUPABASE_URL ? 'SUPABASE_URL' : null, !SUPABASE_SERVICE_ROLE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY' : null].filter(Boolean);
      return NextResponse.json({ error: 'Server not configured', missing }, { status: 500 });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: name || '' },
      app_metadata: { provider: 'admin_create' }
    });
    if (error || !data?.user) {
      return NextResponse.json({ error: error?.message || 'Create failed' }, { status: 500 });
    }
    const uid = data.user.id;
    // Assign role in public.user_roles
    const { error: roleErr } = await admin.from('user_roles').insert({ user_id: uid, role });
    if (roleErr) {
      return NextResponse.json({ error: roleErr.message }, { status: 500 });
    }
    // Optionally upsert user name mapping into app_settings.user_profiles
    try {
      const { data: prof } = await admin.from('app_settings').select('id, value').eq('key', 'user_profiles').maybeSingle();
      const id = (prof as any)?.id as string | null;
      const value = ((prof as any)?.value as Record<string, string> | undefined) || {};
      const next = { ...value, [uid]: name || email } as Record<string, string>;
      if (id) await admin.from('app_settings').update({ value: next }).eq('id', id as any);
      else await admin.from('app_settings').insert({ key: 'user_profiles', value: next } as any);
    } catch {}
    // Upsert user email mapping into app_settings.user_emails for UI listing
    try {
      const { data: em } = await admin.from('app_settings').select('id, value').eq('key', 'user_emails').maybeSingle();
      const id = (em as any)?.id as string | null;
      const value = ((em as any)?.value as Record<string, string> | undefined) || {};
      const next = { ...value, [uid]: email } as Record<string, string>;
      if (id) await admin.from('app_settings').update({ value: next }).eq('id', id as any);
      else await admin.from('app_settings').insert({ key: 'user_emails', value: next } as any);
    } catch {}
    // Send EmailJS notification if configured
    try {
      const serviceId = process.env.EMAILJS_SERVICE_ID;
      const templateId = process.env.EMAILJS_TEMPLATE_ID;
      const publicKey = process.env.EMAILJS_PUBLIC_KEY;
      if (serviceId && templateId && publicKey) {
        await fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_id: serviceId,
            template_id: templateId,
            user_id: publicKey,
            template_params: {
              to_email: email,
              to_name: name || email,
              user_email: email,
              user_password: password
            }
          })
        }).catch(()=>{});
      }
    } catch {}
    return NextResponse.json({ ok: true, user_id: uid });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}


