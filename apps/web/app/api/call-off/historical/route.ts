import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, referenceMonth } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    if (!referenceMonth || typeof referenceMonth !== 'string') {
      return NextResponse.json({ error: 'referenceMonth is required (format: YYYY-MM)' }, { status: 400 });
    }

    // Parse the reference month to get start and end dates
    const [year, month] = referenceMonth.split('-').map(Number);
    if (!year || !month || month < 1 || month > 12) {
      return NextResponse.json({ error: 'Invalid referenceMonth format. Use YYYY-MM' }, { status: 400 });
    }

    // Get first and last day of the reference month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0); // Last day of the month
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Extract unique style numbers and colors
    const styleNos = Array.from(new Set(selections.map((s: any) => s.style_no)));
    const colors = Array.from(new Set(selections.map((s: any) => s.color)));

    // Fetch historical sales data for the reference month
    const { data: historicalData, error } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity, date')
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', startDateStr)
      .lte('date', endDateStr);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Group by style_no|color and aggregate by size
    type AggregateMap = Map<string, Map<string, number>>;
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

    return NextResponse.json({ 
      data: result, 
      referenceMonth,
      startDate: startDateStr,
      endDate: endDateStr,
      daysInMonth: endDate.getDate()
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

