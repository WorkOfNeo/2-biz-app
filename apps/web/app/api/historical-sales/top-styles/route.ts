import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/historical-sales/top-styles
 * Returns aggregated totals per style for a period (for exec dashboard)
 * 
 * Body: {
 *   startDate?: string (YYYY-MM-DD),
 *   endDate?: string (YYYY-MM-DD),
 *   months?: string[] (e.g., ['2024-01', '2024-03']),
 *   limit?: number (default 20)
 * }
 * 
 * Response: {
 *   styles: [{ 
 *     style_no: string, 
 *     style_name: string | null,
 *     total: number, 
 *     colorCount: number,
 *     topColor: string 
 *   }],
 *   period: { start: string, end: string },
 *   grandTotal: number
 * }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { startDate, endDate, months, limit = 20 } = body;

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

    // Fetch all historical sales data for the period (paginate; Supabase default limit is 1000)
    const PAGE_SIZE = 1000;
    let historicalData: any[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: chunk, error } = await supabase
        .from('historical_sales')
        .select('style_no, color, quantity, date')
        .gte('date', startDateStr)
        .lte('date', endDateStr)
        .order('date', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      historicalData = historicalData.concat(chunk || []);
      hasMore = (chunk?.length ?? 0) === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    // Filter for specific months if provided
    if (Array.isArray(months) && months.length > 0) {
      const monthSet = new Set(months);
      historicalData = historicalData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7);
        return monthSet.has(rowMonth);
      });
    }

    // Aggregate by style
    const byStyle = new Map<string, { total: number; colorTotals: Map<string, number> }>();
    let grandTotal = 0;

    for (const row of historicalData) {
      const styleNo = row.style_no;
      const color = row.color;
      const qty = row.quantity || 0;
      
      if (!byStyle.has(styleNo)) {
        byStyle.set(styleNo, { total: 0, colorTotals: new Map() });
      }
      
      const styleData = byStyle.get(styleNo)!;
      styleData.total += qty;
      styleData.colorTotals.set(color, (styleData.colorTotals.get(color) || 0) + qty);
      grandTotal += qty;
    }

    // Get style names
    const styleNos = Array.from(byStyle.keys());
    const { data: stylesData } = await supabase
      .from('styles')
      .select('style_no, style_name')
      .in('style_no', styleNos.slice(0, 500));

    const styleNameMap = new Map<string, string | null>();
    for (const s of (stylesData || [])) {
      styleNameMap.set(s.style_no, s.style_name);
    }

    // Sort by total and take top N
    const sortedStyles = Array.from(byStyle.entries())
      .map(([style_no, data]) => {
        // Find top color
        let topColor = '';
        let topColorQty = 0;
        for (const [color, qty] of data.colorTotals.entries()) {
          if (qty > topColorQty) {
            topColor = color;
            topColorQty = qty;
          }
        }
        
        return {
          style_no,
          style_name: styleNameMap.get(style_no) || null,
          total: data.total,
          colorCount: data.colorTotals.size,
          topColor
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);

    return NextResponse.json({
      styles: sortedStyles,
      period: { start: startDateStr, end: endDateStr },
      grandTotal,
      styleCount: byStyle.size
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
