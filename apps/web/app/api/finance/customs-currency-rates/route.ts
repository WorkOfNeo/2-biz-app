import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = String(key || '').trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  if (!year || month < 1 || month > 12) return null;
  return { year, month };
}

export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const url = new URL(req.url);
    const currency = (url.searchParams.get('currency') || 'USD').toUpperCase();
    const monthsParam = url.searchParams.get('months'); // comma-separated YYYY-MM

    let query = supabase
      .from('finance_customs_currency_rates')
      .select('id, created_at, currency_code, year, month, rate_dkk')
      .eq('currency_code', currency)
      .order('year', { ascending: false })
      .order('month', { ascending: false });

    if (monthsParam) {
      const monthKeys = monthsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const parsed = monthKeys.map(parseMonthKey).filter(Boolean) as { year: number; month: number }[];
      if (parsed.length > 0) {
        // Build OR filter: (year.eq.Y1.and.month.eq.M1),(year.eq.Y2.and.month.eq.M2),...
        const orParts = parsed.map((p) => `and(year.eq.${p.year},month.eq.${p.month})`);
        query = query.or(orParts.join(','));
      }
    } else {
      query = query.limit(36);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[CustomsCurrencyRates API] List error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 146?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ rates: data ?? [] });
  } catch (error: any) {
    console.error('[CustomsCurrencyRates API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { currencyCode, year, month, rateDkk } = body as {
      currencyCode: string;
      year: number;
      month: number;
      rateDkk: number;
    };

    const currency = String(currencyCode || '').trim().toUpperCase();
    if (!currency) return NextResponse.json({ error: 'currencyCode is required' }, { status: 400 });
    if (!year || year < 2000 || year > 2100) return NextResponse.json({ error: 'year is invalid' }, { status: 400 });
    if (!month || month < 1 || month > 12) return NextResponse.json({ error: 'month is invalid' }, { status: 400 });
    const rate = Number(rateDkk);
    if (!isFinite(rate) || rate <= 0) return NextResponse.json({ error: 'rateDkk is invalid' }, { status: 400 });

    const { data, error } = await supabase
      .from('finance_customs_currency_rates')
      .upsert(
        {
          currency_code: currency,
          year,
          month,
          rate_dkk: rate,
        },
        { onConflict: 'currency_code,year,month' }
      )
      .select('id, created_at, currency_code, year, month, rate_dkk')
      .single();

    if (error) {
      console.error('[CustomsCurrencyRates API] Upsert error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 146?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ rate: data });
  } catch (error: any) {
    console.error('[CustomsCurrencyRates API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

