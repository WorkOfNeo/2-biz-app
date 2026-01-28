import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = String(key || '').trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  if (!year || year < 2000 || year > 2100) return null;
  if (!month || month < 1 || month > 12) return null;
  return { year, month };
}

export async function GET() {
  try {
    const supabase = createRouteHandlerClient({ cookies });

    const { data, error } = await supabase
      .from('finance_customs_monthly_frafoersler')
      .select('id, created_at, year, month, toldref')
      .order('year', { ascending: false })
      .order('month', { ascending: false });

    if (error) {
      console.error('[MonthlyFrafoersler API] List error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 149?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ items: data ?? [] });
  } catch (error: any) {
    console.error('[MonthlyFrafoersler API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { monthKey, toldref, year, month } = body as {
      monthKey?: string;
      year?: number;
      month?: number;
      toldref: string;
    };

    const t = String(toldref || '').trim();
    if (!t) return NextResponse.json({ error: 'toldref is required' }, { status: 400 });

    let ym: { year: number; month: number } | null = null;
    if (typeof year === 'number' && typeof month === 'number') {
      ym = { year, month };
    } else if (monthKey) {
      ym = parseMonthKey(monthKey);
    }

    if (!ym) return NextResponse.json({ error: 'monthKey (YYYY-MM) is required' }, { status: 400 });

    const { data, error } = await supabase
      .from('finance_customs_monthly_frafoersler')
      .upsert({ year: ym.year, month: ym.month, toldref: t }, { onConflict: 'year,month' })
      .select('id, created_at, year, month, toldref')
      .single();

    if (error) {
      console.error('[MonthlyFrafoersler API] Upsert error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 149?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ item: data });
  } catch (error: any) {
    console.error('[MonthlyFrafoersler API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

