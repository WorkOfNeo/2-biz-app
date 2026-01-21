import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, startDate, endDate, referenceMonth, months } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    // Collect date ranges to query (for multi-month support)
    let dateRanges: Array<{ start: string; end: string }> = [];
    let periodDisplay = '';

    // Support new format: months[] array (e.g. ['2024-01', '2024-03'])
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
      
      if (dateRanges.length === 0) {
        return NextResponse.json({ error: 'Invalid months format. Use YYYY-MM' }, { status: 400 });
      }
      
      periodDisplay = months.map(m => {
        const [y, mo] = m.split('-').map(Number);
        return new Date(y!, mo! - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }).join(', ');
    }
    // Support startDate/endDate format
    else if (startDate && endDate && typeof startDate === 'string' && typeof endDate === 'string') {
      dateRanges.push({ start: startDate, end: endDate });
      periodDisplay = `${startDate} to ${endDate}`;
    }
    // Legacy: referenceMonth
    else if (referenceMonth) {
      const [year, month] = referenceMonth.split('-').map(Number);
      if (!year || !month || month < 1 || month > 12) {
        return NextResponse.json({ error: 'Invalid referenceMonth format. Use YYYY-MM' }, { status: 400 });
      }
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      const startStr = start.toISOString().split('T')[0] as string;
      const endStr = end.toISOString().split('T')[0] as string;
      dateRanges.push({ start: startStr, end: endStr });
      periodDisplay = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    else {
      return NextResponse.json({ error: 'Either months[], startDate/endDate or referenceMonth is required' }, { status: 400 });
    }

    // For backwards compatibility, derive startDateStr/endDateStr from the overall range
    const allStarts = dateRanges.map(r => r.start).sort();
    const allEnds = dateRanges.map(r => r.end).sort();
    const startDateStr = allStarts[0] || '';
    const endDateStr = allEnds[allEnds.length - 1] || '';

    // Validate dates
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
    }

    // Extract unique style numbers and colors
    const styleNos = Array.from(new Set(selections.map((s: any) => s.style_no)));
    const colors = Array.from(new Set(selections.map((s: any) => s.color)));

    // Fetch historical sales data for all date ranges
    // For multi-month, we fetch the overall range and filter in-memory
    let historicalData: any[] = [];
    let totalCount = 0;
    
    const { data: rawData, error, count } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity, date', { count: 'exact' })
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', startDateStr)
      .lte('date', endDateStr)
      .limit(50000);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    totalCount = count || 0;

    // For multi-month: filter to only include rows within specified month ranges
    if (Array.isArray(months) && months.length > 0 && rawData) {
      const monthSet = new Set(months);
      historicalData = rawData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7); // 'YYYY-MM'
        return monthSet.has(rowMonth);
      });
    } else {
      historicalData = rawData || [];
    }

    // Helper to normalize size strings: "44.00" -> "44", "44.0" -> "44"
    const normalizeSize = (size: string): string => {
      const trimmed = String(size).trim();
      // If it looks like a decimal number, try to convert and normalize
      const num = parseFloat(trimmed);
      if (!isNaN(num) && trimmed.includes('.')) {
        // Check if it's a whole number (e.g., 44.00)
        if (Number.isInteger(num)) {
          return String(Math.floor(num));
        }
      }
      return trimmed;
    };

    // Group by style_no|color and aggregate by size
    type AggregateMap = Map<string, Map<string, number>>;
    const aggregates: AggregateMap = new Map();

    for (const row of historicalData || []) {
      const key = `${row.style_no}|${row.color}`.toLowerCase();
      if (!aggregates.has(key)) {
        aggregates.set(key, new Map());
      }
      const sizeMap = aggregates.get(key)!;
      const normalizedSize = normalizeSize(row.size);
      const current = sizeMap.get(normalizedSize) || 0;
      sizeMap.set(normalizedSize, current + row.quantity);
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

    // Calculate total days across selected months/ranges
    let daysInPeriod = 0;
    for (const range of dateRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      daysInPeriod += Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }
    
    return NextResponse.json({ 
      data: result, 
      startDate: startDateStr,
      endDate: endDateStr,
      months: Array.isArray(months) ? months : undefined,
      periodDisplay,
      daysInPeriod,
      rowsLoaded: historicalData.length,
      totalRows: totalCount
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

