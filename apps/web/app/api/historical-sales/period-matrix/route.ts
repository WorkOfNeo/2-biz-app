import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/historical-sales/period-matrix
 *
 * Returns totals per (period, style_no, color, size) for the given selection.
 *
 * Body: {
 *   style_nos: string[],
 *   startDate: string (YYYY-MM-DD),
 *   endDate: string (YYYY-MM-DD),
 *   aggregation: 'month' | 'week' | 'day',
 *   colors?: string[]
 * }
 *
 * Response: {
 *   periods: string[],
 *   rows: Array<{
 *     style_no: string,
 *     color: string,
 *     size: string,
 *     byPeriod: Record<string, number>,
 *     total: number
 *   }>
 * }
 */

type Aggregation = 'month' | 'week' | 'day';

// Helper to normalize size strings: "44.00" -> "44"
function normalizeSize(size: string): string {
  const trimmed = String(size).trim();
  const num = parseFloat(trimmed);
  if (!Number.isNaN(num) && trimmed.includes('.')) {
    if (Number.isInteger(num)) {
      return String(Math.floor(num));
    }
  }
  return trimmed;
}

function getWeekKey(dateStr: string): string {
  // Keep consistent with UI aggregation logic used in historical-sales page:
  // weekNo = ceil((((d-jan1)/day)+jan1.getDay()+1)/7)
  const d = new Date(dateStr);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getPeriodKey(dateStr: string, aggregation: Aggregation): string {
  if (aggregation === 'day') return dateStr;
  if (aggregation === 'month') return dateStr.slice(0, 7);
  return getWeekKey(dateStr);
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { style_nos, startDate, endDate, aggregation, colors } = body as {
      style_nos?: string[];
      startDate?: string;
      endDate?: string;
      aggregation?: Aggregation;
      colors?: string[];
    };

    if (!Array.isArray(style_nos) || style_nos.length === 0) {
      return NextResponse.json({ error: 'style_nos is required' }, { status: 400 });
    }
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
    }
    if (aggregation !== 'month' && aggregation !== 'week' && aggregation !== 'day') {
      return NextResponse.json({ error: 'aggregation must be month|week|day' }, { status: 400 });
    }

    // Fetch data with pagination (Supabase default limit is 1000)
    const PAGE_SIZE = 1000;
    let rawData: Array<{ style_no: string; color: string; size: string; quantity: number; date: string }> = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('historical_sales')
        .select('style_no, color, size, quantity, date')
        .in('style_no', style_nos)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (Array.isArray(colors) && colors.length > 0) {
        query = query.in('color', colors);
      }

      const { data: chunk, error } = await query;
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      rawData = rawData.concat((chunk ?? []) as any[]);
      hasMore = (chunk?.length ?? 0) === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    // Aggregate into: key(style|color|size) -> period -> qty
    const periodsSet = new Set<string>();
    const byKey = new Map<string, { style_no: string; color: string; size: string; byPeriod: Record<string, number>; total: number }>();

    for (const row of rawData) {
      if (!row?.date) continue;
      const period = getPeriodKey(row.date, aggregation);
      periodsSet.add(period);

      const styleNo = row.style_no;
      const color = row.color;
      const size = normalizeSize(row.size);
      const qty = row.quantity || 0;
      const key = `${styleNo}|${color}|${size}`;

      if (!byKey.has(key)) {
        byKey.set(key, { style_no: styleNo, color, size, byPeriod: {}, total: 0 });
      }

      const entry = byKey.get(key)!;
      entry.byPeriod[period] = (entry.byPeriod[period] || 0) + qty;
      entry.total += qty;
    }

    const periods = Array.from(periodsSet).sort((a, b) => a.localeCompare(b));
    const rows = Array.from(byKey.values()).sort((a, b) => {
      const s = a.style_no.localeCompare(b.style_no);
      if (s !== 0) return s;
      const c = a.color.localeCompare(b.color);
      if (c !== 0) return c;
      const na = parseFloat(a.size);
      const nb = parseFloat(b.size);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
      return a.size.localeCompare(b.size);
    });

    return NextResponse.json({ periods, rows });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

