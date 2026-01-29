import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/historical-sales/matrix
 * Returns a color x size matrix for a style
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
 *   sizes: string[],
 *   colors: string[],
 *   cells: { [color]: { [size]: number } },
 *   totals: {
 *     byColor: { [color]: number },
 *     bySize: { [size]: number },
 *     grand: number
 *   }
 * }
 */

// Helper to normalize size strings: "44.00" -> "44"
function normalizeSize(size: string): string {
  const trimmed = String(size).trim();
  const num = parseFloat(trimmed);
  if (!isNaN(num) && trimmed.includes('.')) {
    if (Number.isInteger(num)) {
      return String(Math.floor(num));
    }
  }
  return trimmed;
}

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
      .select('color, size, quantity')
      .eq('style_no', style_no)
      .gte('date', startDateStr)
      .lte('date', endDateStr)
      .limit(100000);

    if (Array.isArray(colors) && colors.length > 0) {
      query = query.in('color', colors);
    }

    const { data: rawData, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Filter for specific months if provided
    // Note: We already filtered by date range, but for months[] we need to be more specific
    // Actually, since we're aggregating, we don't have date in the result here. We need to fetch with date.
    // Let me refetch with date included for filtering
    
    let query2 = supabase
      .from('historical_sales')
      .select('color, size, quantity, date')
      .eq('style_no', style_no)
      .gte('date', startDateStr)
      .lte('date', endDateStr)
      .limit(100000);

    if (Array.isArray(colors) && colors.length > 0) {
      query2 = query2.in('color', colors);
    }

    const { data: rawData2, error: error2 } = await query2;

    if (error2) {
      return NextResponse.json({ error: error2.message }, { status: 500 });
    }

    let historicalData = rawData2 || [];
    
    // Filter to only include rows within specified month ranges (if months[] provided)
    if (Array.isArray(months) && months.length > 0) {
      const monthSet = new Set(months);
      historicalData = historicalData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7);
        return monthSet.has(rowMonth);
      });
    }

    // Aggregate by color and size
    const allColors = new Set<string>();
    const allSizes = new Set<string>();
    const cells: Record<string, Record<string, number>> = {};
    const totalsByColor: Record<string, number> = {};
    const totalsBySize: Record<string, number> = {};
    let grandTotal = 0;

    for (const row of historicalData) {
      const color = row.color;
      const size = normalizeSize(row.size);
      const qty = row.quantity || 0;
      
      allColors.add(color);
      allSizes.add(size);
      
      if (!cells[color]) {
        cells[color] = {};
      }
      cells[color][size] = (cells[color][size] || 0) + qty;
      
      totalsByColor[color] = (totalsByColor[color] || 0) + qty;
      totalsBySize[size] = (totalsBySize[size] || 0) + qty;
      grandTotal += qty;
    }

    // Sort sizes (try numeric sort first)
    const sortedSizes = Array.from(allSizes).sort((a, b) => {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b);
    });

    // Sort colors alphabetically
    const sortedColors = Array.from(allColors).sort();

    return NextResponse.json({
      sizes: sortedSizes,
      colors: sortedColors,
      cells,
      totals: {
        byColor: totalsByColor,
        bySize: totalsBySize,
        grand: grandTotal
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
