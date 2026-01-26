import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });

    const { data, error } = await supabase
      .from('finance_customs_country_aliases')
      .select('id, created_at, name, code')
      .order('name', { ascending: true });

    if (error) {
      console.error('[CustomsCountries API] List error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 148?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ countries: data ?? [] });
  } catch (error: any) {
    console.error('[CustomsCountries API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { name, code } = body as { name: string; code: string };
    const n = String(name || '').trim();
    const c = String(code || '').trim().toUpperCase();

    if (!n) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    if (!c || c.length < 2 || c.length > 3) return NextResponse.json({ error: 'code must be 2-3 letters' }, { status: 400 });

    const { data, error } = await supabase
      .from('finance_customs_country_aliases')
      .upsert({ name: n, code: c }, { onConflict: 'name_norm' })
      .select('id, created_at, name, code')
      .single();

    if (error) {
      console.error('[CustomsCountries API] Upsert error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 148?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ country: data });
  } catch (error: any) {
    console.error('[CustomsCountries API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

