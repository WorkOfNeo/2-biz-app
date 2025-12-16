import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  scraped_at: string;
};

type SelectionInput = {
  style_no: string;
  color: string;
};

type ItemAnalysis = {
  style_no: string;
  style_name: string;
  color: string;
  sizes: string[];
  stock: number[];
  sold: number[];
  netStock: number[];
  historical: number[];
  nextMonthHistorical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalHistorical: number;
  totalNextMonthHistorical: number;
  weeklyRate: number;
  nextMonthWeeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  suggestedOrderBySize: number[];
  trendDirection: 'up' | 'down' | 'stable';
  trendPercent: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  priority: number;
};

type OrderByStyle = {
  style_no: string;
  style_name: string;
  totalOrder: number;
  colors: Array<{
    color: string;
    order: number;
    status: 'critical' | 'low' | 'ok' | 'surplus';
  }>;
};

type FullAnalysisResponse = {
  items: ItemAnalysis[];
  ordersByStyle: OrderByStyle[];
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    aiSummary: string;
    trendSummary: string;
  };
  dateRange: {
    start: string;
    end: string;
    display: string;
  };
  nextMonthRange: {
    start: string;
    end: string;
    display: string;
  };
  _debug?: {
    historicalRowsLoaded: number;
    historicalTotalCount: number | null;
    totalHistoricalQty: number;
    stockRowsLoaded: number;
    nextMonthRowsLoaded: number;
    queryDateRange: { startDate: string; endDate: string };
    queryStyleNos: string[];
    queryColors: string[];
  };
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, weeks_cover = 4, startDate, endDate } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    if (!startDate || !endDate || typeof startDate !== 'string' || typeof endDate !== 'string') {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
    }
    if (start > end) {
      return NextResponse.json({ error: 'Start date must be before end date' }, { status: 400 });
    }

    const daysInPeriod = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const weeksInPeriod = daysInPeriod / 7;
    
    const periodDisplay = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Calculate "next month" date range (one month after the selected period for trend comparison)
    // This helps understand if demand is expected to increase or decrease
    const nextMonthStart = new Date(start);
    nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
    const nextMonthEnd = new Date(end);
    nextMonthEnd.setMonth(nextMonthEnd.getMonth() + 1);
    
    const nextMonthStartStr = nextMonthStart.toISOString().split('T')[0] as string;
    const nextMonthEndStr = nextMonthEnd.toISOString().split('T')[0] as string;
    const nextMonthDisplay = `${nextMonthStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${nextMonthEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const nextMonthDays = Math.ceil((nextMonthEnd.getTime() - nextMonthStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const nextMonthWeeks = nextMonthDays / 7;

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Get unique style numbers and colors
    const styleNos = Array.from(new Set(selections.map((s: SelectionInput) => s.style_no)));
    const colors = Array.from(new Set(selections.map((s: SelectionInput) => s.color)));

    // Fetch style names for display
    const { data: stylesData } = await supabase
      .from('styles')
      .select('style_no, style_name')
      .in('style_no', styleNos);
    
    const styleNameMap = new Map<string, string>();
    (stylesData || []).forEach((s: any) => {
      styleNameMap.set(s.style_no, s.style_name || s.style_no);
    });

    // Fetch current stock data
    const { data: stockData, error: stockError } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', styleNos)
      .in('color', colors);

    if (stockError) {
      return NextResponse.json({ error: stockError.message }, { status: 500 });
    }

    console.log('🔍 [DEBUG] Stock data query:', {
      styleNos,
      colors,
      rowsReturned: stockData?.length || 0
    });

    // Fetch historical sales with PROPER pagination
    // Supabase has a server-side limit of 1000 rows per query (PGRST_MAX_ROWS)
    // We use .range() to paginate, ensuring we get ALL data without duplicates
    console.log('🔍 [DEBUG] Fetching historical data with pagination...');
    
    const PAGE_SIZE = 1000;
    let allHistoricalData: any[] = [];
    let historicalCount = 0;
    let currentOffset = 0;
    
    while (true) {
      const from = currentOffset;
      const to = currentOffset + PAGE_SIZE - 1;
      
      const { data: pageData, error: pageError, count } = await supabase
        .from('historical_sales')
        .select('style_no, color, size, quantity', { count: 'exact' })
        .in('style_no', styleNos)
        .in('color', colors)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false })
        .order('style_no', { ascending: true })  // Add secondary sort for consistency
        .order('color', { ascending: true })     // Add tertiary sort
        .order('size', { ascending: true })      // Add quaternary sort
        .range(from, to);

      if (pageError) {
        return NextResponse.json({ error: pageError.message }, { status: 500 });
      }

      if (count !== null && currentOffset === 0) {
        historicalCount = count;
        console.log(`🔍 [DEBUG] Total rows to fetch: ${count}`);
      }

      if (pageData && pageData.length > 0) {
        allHistoricalData = allHistoricalData.concat(pageData);
        console.log(`🔍 [DEBUG] Fetched rows ${from}-${from + pageData.length - 1} (${pageData.length} rows, total: ${allHistoricalData.length})`);
      }

      // Break if we got less than PAGE_SIZE rows (end of data)
      if (!pageData || pageData.length < PAGE_SIZE) {
        break;
      }

      // Move to next page
      currentOffset += PAGE_SIZE;

      // Safety break
      if (currentOffset > 100000) {
        console.warn('⚠️ [WARNING] Reached safety limit (100k rows)');
        break;
      }
    }

    const historicalData = allHistoricalData;

    console.log('🔍 [DEBUG] Historical data query COMPLETE:', {
      dateRange: `${startDate} to ${endDate}`,
      rowsReturned: historicalData?.length || 0,
      totalCount: historicalCount,
      sampleRows: historicalData?.slice(0, 5)
    });

    // Calculate total quantity from historical data
    const totalHistoricalQty = (historicalData || []).reduce((sum: number, row: any) => sum + (row.quantity || 0), 0);
    console.log('🔍 [DEBUG] Total historical quantity:', totalHistoricalQty);

    // Fetch next month historical data for trend comparison (with pagination)
    let allNextMonthData: any[] = [];
    let nextMonthOffset = 0;
    
    while (true) {
      const from = nextMonthOffset;
      const to = nextMonthOffset + PAGE_SIZE - 1;
      
      const { data: pageData, error: pageError } = await supabase
        .from('historical_sales')
        .select('style_no, color, size, quantity')
        .in('style_no', styleNos)
        .in('color', colors)
        .gte('date', nextMonthStartStr)
        .lte('date', nextMonthEndStr)
        .order('date', { ascending: false })
        .order('style_no', { ascending: true })
        .order('color', { ascending: true })
        .order('size', { ascending: true })
        .range(from, to);

      if (pageError) {
        console.warn('Could not fetch next month data:', pageError.message);
        break;
      }

      if (pageData && pageData.length > 0) {
        allNextMonthData = allNextMonthData.concat(pageData);
      }

      if (!pageData || pageData.length < PAGE_SIZE) {
        break;
      }

      nextMonthOffset += PAGE_SIZE;

      if (nextMonthOffset > 100000) break;
    }

    const nextMonthData = allNextMonthData;
    console.log('🔍 [DEBUG] Next month data loaded:', nextMonthData?.length || 0, 'rows');

    // Process each selection
    const items: ItemAnalysis[] = [];

    for (const selection of selections as SelectionInput[]) {
      const { style_no, color } = selection;

      // Get stock rows for this style/color
      const rows = (stockData as StockRow[]).filter(
        (r) => r.style_no === style_no && r.color === color
      );

      if (rows.length === 0) {
        continue;
      }

      // Get latest row per section
      const latestBySection = new Map<string, StockRow>();
      rows.forEach((r) => {
        const sectionKey = `${r.section}|${r.row_label ?? ''}`;
        const current = latestBySection.get(sectionKey);
        if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
          latestBySection.set(sectionKey, r);
        }
      });

      const latestRows = Array.from(latestBySection.values());
      const stockRow = latestRows.find((r) => r.section === 'Stock');
      const sizes = stockRow?.sizes || latestRows[0]?.sizes || [];
      const num = sizes.length;

      if (num === 0) continue;

      const ensureNums = (arr: any[], len: number): number[] =>
        Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);

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

      // Calculate current stock
      const stock = stockRow
        ? ensureNums(
            Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(String(stockRow.values || '[]')),
            num
          )
        : Array(num).fill(0);

      // Calculate sold
      const soldRows = latestRows.filter((r) => r.section === 'Sold');
      const sold = soldRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + (vals[i] ?? 0));
      }, Array(num).fill(0) as number[]);

      // Calculate net stock (Stock - Sold, no purchase for NOOS)
      const netStock = stock.map((v, i) => v - (sold[i] ?? 0));
      const totalNetStock = netStock.reduce((a, b) => a + b, 0);

      // Get historical sales for this color
      const colorHistorical = (historicalData || []).filter(
        (h: any) => h.style_no === style_no && h.color === color
      );

      // Get unique sizes from historical data for this color
      const historicalSizes = new Set<string>();
      colorHistorical.forEach((h: any) => historicalSizes.add(String(h.size)));
      
      console.log(`🔍 [DEBUG] ${style_no} - ${color}:`, {
        historicalRowsForColor: colorHistorical.length,
        historicalTotalQty: colorHistorical.reduce((sum: number, h: any) => sum + (h.quantity || 0), 0),
        stockSizes: sizes,
        historicalSizes: Array.from(historicalSizes),
        sampleRows: colorHistorical.slice(0, 5)
      });

      // Aggregate historical by size (with normalization for sizes like "44.00" -> "44")
      const historicalBySize = new Map<string, number>();
      colorHistorical.forEach((h: any) => {
        const normalizedSize = normalizeSize(h.size);
        const current = historicalBySize.get(normalizedSize) || 0;
        historicalBySize.set(normalizedSize, current + h.quantity);
      });

      console.log(`🔍 [DEBUG] ${style_no} - ${color} historicalBySize (after normalization):`, Object.fromEntries(historicalBySize));

      // Match sizes with normalization and log each match
      const historical = sizes.map((size: string, idx: number) => {
        const normalizedStockSize = normalizeSize(size);
        const matchedQty = historicalBySize.get(normalizedStockSize) || historicalBySize.get(size) || 0;
        console.log(`   Size[${idx}] "${size}" → normalized: "${normalizedStockSize}" → matched qty: ${matchedQty}`);
        return matchedQty;
      });
      const totalHistorical = historical.reduce((a: number, b: number) => a + b, 0);

      // Check for unmatched historical sizes
      const matchedNormalizedSizes = new Set(sizes.map((s: string) => normalizeSize(s)));
      const unmatchedHistorical: Record<string, number> = {};
      historicalBySize.forEach((qty, size) => {
        if (!matchedNormalizedSizes.has(size)) {
          unmatchedHistorical[size] = qty;
        }
      });
      
      if (Object.keys(unmatchedHistorical).length > 0) {
        console.warn(`⚠️ [WARNING] ${style_no} - ${color}: Unmatched historical sizes:`, unmatchedHistorical);
        console.warn(`   Stock sizes (normalized):`, Array.from(matchedNormalizedSizes));
        console.warn(`   Historical sizes:`, Array.from(historicalBySize.keys()));
      }

      console.log(`🔍 [DEBUG] ${style_no} - ${color} FINAL:`, {
        historical,
        totalHistorical,
        rawHistoricalTotal: colorHistorical.reduce((sum: number, h: any) => sum + (h.quantity || 0), 0),
        matchedCorrectly: totalHistorical === colorHistorical.reduce((sum: number, h: any) => sum + (h.quantity || 0), 0)
      });

      // Get next month historical sales for this color (for trend analysis)
      const colorNextMonth = (nextMonthData || []).filter(
        (h: any) => h.style_no === style_no && h.color === color
      );
      const nextMonthBySize = new Map<string, number>();
      colorNextMonth.forEach((h: any) => {
        const normalizedSize = normalizeSize(h.size);
        const current = nextMonthBySize.get(normalizedSize) || 0;
        nextMonthBySize.set(normalizedSize, current + h.quantity);
      });
      const nextMonthHistorical = sizes.map((size: string) => {
        const normalizedSize = normalizeSize(size);
        return nextMonthBySize.get(normalizedSize) || nextMonthBySize.get(size) || 0;
      });
      const totalNextMonthHistorical = nextMonthHistorical.reduce((a: number, b: number) => a + b, 0);
      const nextMonthWeeklyRate = totalNextMonthHistorical / nextMonthWeeks;

      // Calculate trend direction and percentage
      let trendDirection: 'up' | 'down' | 'stable' = 'stable';
      let trendPercent = 0;
      if (totalHistorical > 0 && totalNextMonthHistorical > 0) {
        trendPercent = ((totalNextMonthHistorical - totalHistorical) / totalHistorical) * 100;
        if (trendPercent > 10) trendDirection = 'up';
        else if (trendPercent < -10) trendDirection = 'down';
      }

      // Calculate weekly rate and target stock
      const weeklyRate = totalHistorical / weeksInPeriod;
      const targetStock = Math.ceil(weeklyRate * weeks_cover);

      // Calculate suggested order total
      const suggestedOrder = Math.max(0, targetStock - totalNetStock);

      // Calculate suggested order per size (distributed by historical pressure)
      const historicalTotal = historical.reduce((a: number, b: number) => a + b, 0);
      let suggestedOrderBySize: number[];
      if (historicalTotal > 0 && suggestedOrder > 0) {
        const exact = historical.map((h: number) => (h / historicalTotal) * suggestedOrder);
        const floored = exact.map((v: number) => Math.floor(v));
        let remaining = suggestedOrder - floored.reduce((a: number, b: number) => a + b, 0);
        const fractional = exact.map((v: number, i: number) => ({ i, frac: v - Math.floor(v) }));
        fractional.sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < remaining && k < fractional.length; k++) {
          const item = fractional[k];
          if (item && item.i >= 0 && item.i < floored.length) {
            floored[item.i] = (floored[item.i] || 0) + 1;
          }
        }
        suggestedOrderBySize = floored;
      } else {
        suggestedOrderBySize = sizes.map(() => 0);
      }

      // Determine status based on stock level relative to target
      let status: 'critical' | 'low' | 'ok' | 'surplus';
      let priority: number;
      
      if (totalNetStock <= 0) {
        status = 'critical';
        priority = 4; // Highest priority
      } else if (totalNetStock < targetStock * 0.25) {
        status = 'critical';
        priority = 3;
      } else if (totalNetStock < targetStock * 0.5) {
        status = 'low';
        priority = 2;
      } else if (totalNetStock > targetStock * 1.5) {
        status = 'surplus';
        priority = 0;
      } else {
        status = 'ok';
        priority = 1;
      }

      items.push({
        style_no,
        style_name: styleNameMap.get(style_no) || style_no,
        color,
        sizes,
        stock,
        sold,
        netStock,
        historical,
        nextMonthHistorical,
        totalStock: stock.reduce((a, b) => a + b, 0),
        totalSold: sold.reduce((a, b) => a + b, 0),
        totalNetStock,
        totalHistorical,
        totalNextMonthHistorical,
        weeklyRate,
        nextMonthWeeklyRate,
        targetStock,
        suggestedOrder,
        suggestedOrderBySize,
        trendDirection,
        trendPercent,
        status,
        priority
      });
    }

    // Sort by priority (highest first)
    items.sort((a, b) => b.priority - a.priority);

    // Calculate summary stats
    const criticalItems = items.filter(i => i.status === 'critical').length;
    const lowItems = items.filter(i => i.status === 'low').length;
    const okItems = items.filter(i => i.status === 'ok').length;
    const surplusItems = items.filter(i => i.status === 'surplus').length;
    const totalSuggestedOrder = items.reduce((sum, i) => sum + i.suggestedOrder, 0);

    // Group orders by style for easy overview
    const ordersByStyleMap = new Map<string, OrderByStyle>();
    for (const item of items) {
      if (item.suggestedOrder > 0) {
        if (!ordersByStyleMap.has(item.style_no)) {
          ordersByStyleMap.set(item.style_no, {
            style_no: item.style_no,
            style_name: item.style_name,
            totalOrder: 0,
            colors: []
          });
        }
        const styleGroup = ordersByStyleMap.get(item.style_no)!;
        styleGroup.totalOrder += item.suggestedOrder;
        styleGroup.colors.push({
          color: item.color,
          order: item.suggestedOrder,
          status: item.status
        });
      }
    }
    const ordersByStyle = Array.from(ordersByStyleMap.values()).sort((a, b) => b.totalOrder - a.totalOrder);

    // Calculate trend summary
    const upTrends = items.filter(i => i.trendDirection === 'up').length;
    const downTrends = items.filter(i => i.trendDirection === 'down').length;
    const trendSummary = `${upTrends} items trending up, ${downTrends} trending down for next month`;

    // Generate AI summary
    const topCritical = items.filter(i => i.status === 'critical').slice(0, 5);
    const topSurplus = items.filter(i => i.status === 'surplus').slice(0, 3);
    const topTrending = items.filter(i => i.trendDirection === 'up').slice(0, 3);

    const aiPrompt = `Analyze this NOOS inventory data and provide a focused summary. Be concise and stick to the data - no generic business advice.

PERIOD: ${periodDisplay} | TARGET: ${weeks_cover} weeks cover

STATUS: ${criticalItems} critical, ${lowItems} low, ${okItems} OK, ${surplusItems} surplus
TOTAL ORDER NEEDED: ${totalSuggestedOrder} units

${topCritical.length > 0 ? `CRITICAL (order immediately):
${topCritical.map(i => `• ${i.style_name} (${i.color}): ${i.totalNetStock} in stock → need +${i.suggestedOrder}${i.trendDirection === 'up' ? ' [demand rising]' : ''}`).join('\n')}` : ''}

${topTrending.length > 0 ? `RISING DEMAND (prepare extra):
${topTrending.map(i => `• ${i.style_name} (${i.color}): +${i.trendPercent.toFixed(0)}% vs next month`).join('\n')}` : ''}

${topSurplus.length > 0 ? `SURPLUS (slow movers):
${topSurplus.map(i => `• ${i.style_name} (${i.color}): ${i.totalNetStock - i.targetStock} units above target`).join('\n')}` : ''}

${ordersByStyle.length > 0 ? `ORDER BY STYLE:
${ordersByStyle.slice(0, 5).map(s => `• ${s.style_name}: +${s.totalOrder} (${s.colors.length} colors)`).join('\n')}` : ''}

Provide a brief summary in 3-4 sentences:
1. What to order now (style names and quantities)
2. What's trending up for next month
3. Any items with too much stock

Keep it SHORT. Only mention specific styles. No general business advice.`;

    let aiSummary = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: aiPrompt }],
        max_tokens: 600,
        temperature: 0.7
      });
      aiSummary = completion.choices[0]?.message?.content || 'Unable to generate AI summary.';
    } catch (e) {
      aiSummary = `## Analysis Complete

**Immediate Action Required:** ${criticalItems} critical items need attention.

**Order Summary:** ${totalSuggestedOrder} units recommended across ${items.length} items.

**Trend Alert:** ${upTrends} items showing increased demand for next month - consider ordering extra.`;
    }

    const response: FullAnalysisResponse = {
      items,
      ordersByStyle,
      summary: {
        totalItems: items.length,
        criticalItems,
        lowItems,
        okItems,
        surplusItems,
        totalSuggestedOrder,
        aiSummary,
        trendSummary
      },
      dateRange: {
        start: startDate,
        end: endDate,
        display: periodDisplay
      },
      nextMonthRange: {
        start: nextMonthStartStr,
        end: nextMonthEndStr,
        display: nextMonthDisplay
      },
      // Debug info
      _debug: {
        historicalRowsLoaded: historicalData?.length || 0,
        historicalTotalCount: historicalCount,
        totalHistoricalQty,
        stockRowsLoaded: stockData?.length || 0,
        nextMonthRowsLoaded: nextMonthData?.length || 0,
        queryDateRange: { startDate, endDate },
        queryStyleNos: styleNos,
        queryColors: colors
      }
    };

    console.log('🔍 [DEBUG] Response debug info:', response._debug);

    return NextResponse.json(response);
  } catch (error: any) {
    console.error('Full analysis error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

