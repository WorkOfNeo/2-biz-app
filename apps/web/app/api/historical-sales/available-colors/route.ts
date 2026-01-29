import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/historical-sales/available-colors
 * Returns distinct colors that have data in historical_sales for the given style(s) and date range.
 *
 * Body: {
 *   style_nos: string[],
 *   startDate: string (YYYY-MM-DD),
 *   endDate: string (YYYY-MM-DD)
 * }
 *
 * Response: {
 *   colors: string[],
 *   byStyle: { [style_no]: string[] }
 * }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { style_nos, startDate, endDate } = body;

    if (!Array.isArray(style_nos) || style_nos.length === 0) {
      return NextResponse.json({ error: 'style_nos array is required' }, { status: 400 });
    }
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
    }

    const byStyle: Record<string, string[]> = {};
    const allColors = new Set<string>();

    for (const style_no of style_nos) {
      const { data, error } = await supabase
        .from('historical_sales')
        .select('color')
        .eq('style_no', style_no)
        .gte('date', startDate)
        .lte('date', endDate);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const colors = Array.from(new Set((data || []).map((r: { color: string }) => r.color).filter(Boolean))).sort();
      byStyle[style_no] = colors;
      colors.forEach((c) => allColors.add(c));
    }

    return NextResponse.json({
      colors: Array.from(allColors).sort(),
      byStyle,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
