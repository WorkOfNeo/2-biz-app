import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const rawStyleNos: string[] = Array.isArray(body.style_nos)
      ? body.style_nos
      : Array.isArray(body.styleNos)
        ? body.styleNos
        : [];
    const style_nos = Array.from(
      new Set(
        rawStyleNos
          .map((s) => String(s || '').trim())
          .filter(Boolean)
      )
    );

    const rawColors: string[] = Array.isArray(body.colors)
      ? body.colors
      : body.color
        ? [body.color]
        : [];
    const colors = Array.from(
      new Set(
        rawColors
          .map((c) => String(c || '').trim())
          .filter(Boolean)
      )
    );

    const startDate: string | undefined = body.start_date || body.startDate || undefined;
    const endDate: string | undefined = body.end_date || body.endDate || undefined;
    const limit = Math.max(1, Math.min(1000, Number(body.limit || 500) || 500));

    if (style_nos.length === 0) {
      return NextResponse.json({ error: 'style_nos array is required' }, { status: 400 });
    }

    let query = supabase
      .from('historical_sales')
      .select('style_no, color, size, date, quantity', { count: 'exact' })
      .in('style_no', style_nos)
      .order('date', { ascending: false })
      .limit(limit);

    if (colors.length > 0) {
      query = query.in('color', colors);
    }
    if (startDate) {
      query = query.gte('date', startDate);
    }
    if (endDate) {
      query = query.lte('date', endDate);
    }

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, count });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

