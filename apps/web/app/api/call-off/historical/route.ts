import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, startDate, endDate, referenceMonth } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    let startDateStr: string;
    let endDateStr: string;

    // Support both new format (startDate/endDate) and legacy format (referenceMonth)
    if (startDate && endDate && typeof startDate === 'string' && typeof endDate === 'string') {
      startDateStr = startDate;
      endDateStr = endDate;
    } else if (referenceMonth) {
      // Legacy support: parse referenceMonth
      const [year, month] = referenceMonth.split('-').map(Number);
      if (!year || !month || month < 1 || month > 12) {
        return NextResponse.json({ error: 'Invalid referenceMonth format. Use YYYY-MM' }, { status: 400 });
      }
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      startDateStr = start.toISOString().split('T')[0] as string;
      endDateStr = end.toISOString().split('T')[0] as string;
    } else {
      return NextResponse.json({ error: 'Either startDate/endDate or referenceMonth is required' }, { status: 400 });
    }

    // Validate dates
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
    }
    if (start > end) {
      return NextResponse.json({ error: 'Start date must be before end date' }, { status: 400 });
    }

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

    const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    
    return NextResponse.json({ 
      data: result, 
      startDate: startDateStr,
      endDate: endDateStr,
      daysInPeriod: daysDiff
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

