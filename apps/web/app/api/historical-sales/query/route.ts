import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, days = 90 } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    // Build query to fetch historical data for multiple style+color combinations
    // selections format: [{ style_no: '1007952', color: 'CAPTAINS BLUE' }, ...]
    
    const styleNos = Array.from(new Set(selections.map((s: any) => s.style_no)));
    const colors = Array.from(new Set(selections.map((s: any) => s.color)));

    // Fetch data for last N days
    const { data: historicalData, error } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity, date')
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', `now() - interval '${days} days'`);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Group by style_no|color and aggregate by size
    type AggregateMap = Map<string, Map<string, number>>; // key -> size -> total_qty
    const aggregates: AggregateMap = new Map();

    for (const row of historicalData || []) {
      const key = `${row.style_no}|${row.color}`.toLowerCase();
      if (!aggregates.has(key)) {
        aggregates.set(key, new Map());
      }
      const sizeMap = aggregates.get(key)!;
      const current = sizeMap.get(row.size) || 0;
      sizeMap.set(row.size, current + row.quantity);
    }

    // Convert to response format: { "style_no|color": { "34": 10, "36": 20, ... } }
    const result: Record<string, Record<string, number>> = {};
    for (const [key, sizeMap] of aggregates.entries()) {
      const sizeObj: Record<string, number> = {};
      for (const [size, qty] of sizeMap.entries()) {
        sizeObj[size] = qty;
      }
      result[key] = sizeObj;
    }

    return NextResponse.json({ data: result, days });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

