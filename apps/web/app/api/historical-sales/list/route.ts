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
    // Default to 10000, max 50000 to ensure we get all historical data
    const limit = Math.max(1, Math.min(50000, Number(body.limit || 10000) || 10000));

    if (style_nos.length === 0) {
      return NextResponse.json({ error: 'style_nos array is required' }, { status: 400 });
    }

    console.log('🔍 [DEBUG] historical-sales/list query:', {
      style_nos,
      colors,
      startDate,
      endDate,
      limit
    });

    const PAGE_SIZE = 1000;
    const allData: any[] = [];
    let from = 0;
    let totalCount: number | null = null;

    while (true) {
      let query = supabase
        .from('historical_sales')
        .select('style_no, color, size, date, quantity', { count: from === 0 ? 'exact' : undefined })
        .in('style_no', style_nos)
        .order('date', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

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
        console.error('🔍 [DEBUG] Query error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      if (from === 0 && count !== null) totalCount = count;
      const chunk = data || [];
      allData.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
      if (allData.length >= limit) break;
    }

    const data = allData.slice(0, limit);
    const count = totalCount;
    const totalQty = data.reduce((sum: number, row: any) => sum + (row.quantity || 0), 0);
    
    console.log('🔍 [DEBUG] historical-sales/list result:', {
      rowsReturned: data?.length || 0,
      totalCount: count,
      totalQuantity: totalQty,
      sampleRows: (data || []).slice(0, 3)
    });

    return NextResponse.json({ 
      data, 
      count,
      _debug: {
        queryParams: { style_nos, colors, startDate, endDate, limit },
        rowsReturned: data?.length || 0,
        totalCount: count,
        totalQuantity: totalQty
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

