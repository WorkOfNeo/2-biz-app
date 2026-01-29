import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET /api/historical-sales/timeseries
 * Returns daily sales data for a style, optionally filtered by colors
 * 
 * Body: {
 *   style_no: string,
 *   startDate?: string (YYYY-MM-DD),
 *   endDate?: string (YYYY-MM-DD),
 *   months?: string[] (e.g., ['2024-01', '2024-03']),
 *   colors?: string[]
 * }
 * 
 * Response: {
 *   points: [{ date: 'YYYY-MM-DD', total: number, byColor: { [color]: number } }],
 *   colors: string[],
 *   totalUnits: number,
 *   daysInPeriod: number
 * }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { style_no, startDate, endDate, months, colors } = body;
    
    if (!style_no) {
      return NextResponse.json({ error: 'style_no is required' }, { status: 400 });
    }

    // Build date ranges from months[] or startDate/endDate
    let dateRanges: Array<{ start: string; end: string }> = [];
    
    if (Array.isArray(months) && months.length > 0) {
      for (const month of months) {
        const parts = month.split('-');
        if (parts.length !== 2) continue;
        const year = Number(parts[0]);
        const m = Number(parts[1]);
        if (isNaN(year) || isNaN(m) || m < 1 || m > 12) continue;
        
        const start = new Date(year, m - 1, 1);
        const end = new Date(year, m, 0);
        const startStr = start.toISOString().split('T')[0] as string;
        const endStr = end.toISOString().split('T')[0] as string;
        dateRanges.push({ start: startStr, end: endStr });
      }
    } else if (startDate && endDate) {
      dateRanges.push({ start: startDate, end: endDate });
    } else {
      // Default to last 90 days
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 90);
      dateRanges.push({ 
        start: start.toISOString().split('T')[0] as string, 
        end: end.toISOString().split('T')[0] as string 
      });
    }

    // Get overall range
    const allStarts = dateRanges.map(r => r.start).sort();
    const allEnds = dateRanges.map(r => r.end).sort();
    const startDateStr = allStarts[0] || '';
    const endDateStr = allEnds[allEnds.length - 1] || '';

    // Fetch data
    let query = supabase
      .from('historical_sales')
      .select('date, color, quantity')
      .eq('style_no', style_no)
      .gte('date', startDateStr)
      .lte('date', endDateStr)
      .limit(50000);

    if (Array.isArray(colors) && colors.length > 0) {
      query = query.in('color', colors);
    }

    const { data: rawData, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Filter to only include rows within specified month ranges (if months[] provided)
    let historicalData = rawData || [];
    if (Array.isArray(months) && months.length > 0) {
      const monthSet = new Set(months);
      historicalData = historicalData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7);
        return monthSet.has(rowMonth);
      });
    }

    // Aggregate by date and color
    const byDate = new Map<string, Map<string, number>>();
    const allColors = new Set<string>();

    for (const row of historicalData) {
      if (!row.date) continue;
      allColors.add(row.color);
      
      if (!byDate.has(row.date)) {
        byDate.set(row.date, new Map());
      }
      const colorMap = byDate.get(row.date)!;
      const current = colorMap.get(row.color) || 0;
      colorMap.set(row.color, current + (row.quantity || 0));
    }

    // Build response points sorted by date
    const sortedDates = Array.from(byDate.keys()).sort();
    const points = sortedDates.map(date => {
      const colorMap = byDate.get(date)!;
      const byColor: Record<string, number> = {};
      let total = 0;
      
      for (const [color, qty] of colorMap.entries()) {
        byColor[color] = qty;
        total += qty;
      }
      
      return { date, total, byColor };
    });

    // Calculate totals
    const totalUnits = points.reduce((sum, p) => sum + p.total, 0);
    
    // Calculate days in period
    let daysInPeriod = 0;
    for (const range of dateRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      daysInPeriod += Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }

    return NextResponse.json({
      points,
      colors: Array.from(allColors).sort(),
      totalUnits,
      daysInPeriod,
      avgPerDay: daysInPeriod > 0 ? Math.round((totalUnits / daysInPeriod) * 100) / 100 : 0
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
