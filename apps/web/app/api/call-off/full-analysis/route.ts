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
  purchaseRunning: number[];  // Running POs
  bellRainAvailable: number[]; // Bell Rain "call home" stock
  historical: number[];
  nextMonthHistorical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalPurchaseRunning: number;
  totalBellRainAvailable: number;
  totalHistorical: number;
  totalNextMonthHistorical: number;
  weeklyRate: number;
  nextMonthWeeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  bellRainCallHome: number; // Amount to call home from Bell Rain first
  newOrderNeeded: number;   // Amount to order after calling home Bell Rain
  suggestedOrderBySize: number[];
  bellRainCallHomeBySize: number[];
  newOrderNeededBySize: number[];
  trendDirection: 'up' | 'down' | 'stable';
  trendPercent: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  priority: number;
  supplierWarning?: string; // e.g. "Below MOQ"
};

// Bell Rain detection helper
function isBellRainRow(row: StockRow): boolean {
  const label = (row.row_label || '').toLowerCase();
  const pattern = /bell[-_ ]?rain|bellrain/i;
  const brPattern = /^br\d+/i;
  return pattern.test(label) || brPattern.test(row.row_label || '');
}

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
  supplierRulesSnapshot?: any;
  _debug?: {
    historicalRowsLoaded: number;
    historicalTotalCount: number | null;
    totalHistoricalQty: number;
    stockRowsLoaded: number;
    nextMonthRowsLoaded: number;
    queryDateRange: { startDate: string; endDate: string };
    selectedMonths?: string[];
    queryStyleNos: string[];
    queryColors: string[];
  };
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, weeks_cover = 4, startDate, endDate, months } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    // Collect date ranges to query (for multi-month support)
    let dateRanges: Array<{ start: string; end: string }> = [];
    let periodDisplay: string = '';
    let selectedMonths: string[] = [];

    // Support new format: months[] array (e.g. ['2024-01', '2024-03'])
    if (Array.isArray(months) && months.length > 0) {
      selectedMonths = months;
      for (const month of months) {
        const parts = month.split('-');
        if (parts.length !== 2) continue;
        const year = Number(parts[0]);
        const m = Number(parts[1]);
        if (isNaN(year) || isNaN(m) || m < 1 || m > 12) continue;
        
        const s = new Date(year, m - 1, 1);
        const e = new Date(year, m, 0);
        const startStr = s.toISOString().split('T')[0] as string;
        const endStr = e.toISOString().split('T')[0] as string;
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
      const s = new Date(startDate);
      const e = new Date(endDate);
      periodDisplay = `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    else {
      return NextResponse.json({ error: 'Either months[] or startDate/endDate is required' }, { status: 400 });
    }

    // Calculate overall date range for querying
    const allStarts = dateRanges.map(r => r.start).sort();
    const allEnds = dateRanges.map(r => r.end).sort();
    const queryStartDate = allStarts[0] || '';
    const queryEndDate = allEnds[allEnds.length - 1] || '';

    const start = new Date(queryStartDate);
    const end = new Date(queryEndDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
    }

    // Calculate total days across selected months
    let daysInPeriod = 0;
    for (const range of dateRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      daysInPeriod += Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }
    const weeksInPeriod = daysInPeriod / 7;

    // Calculate "next month" date ranges (one month after each selected period for trend comparison)
    // This helps understand if demand is expected to increase or decrease
    let nextMonthRanges: Array<{ start: string; end: string }> = [];
    for (const range of dateRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      s.setMonth(s.getMonth() + 1);
      e.setMonth(e.getMonth() + 1);
      nextMonthRanges.push({
        start: s.toISOString().split('T')[0] as string,
        end: e.toISOString().split('T')[0] as string
      });
    }
    
    const nextMonthAllStarts = nextMonthRanges.map(r => r.start).sort();
    const nextMonthAllEnds = nextMonthRanges.map(r => r.end).sort();
    const nextMonthStartStr = nextMonthAllStarts[0] || '';
    const nextMonthEndStr = nextMonthAllEnds[nextMonthAllEnds.length - 1] || '';
    const nextMonthStart = new Date(nextMonthStartStr);
    const nextMonthEnd = new Date(nextMonthEndStr);
    const nextMonthDisplay = selectedMonths.length > 0
      ? selectedMonths.map(m => {
          const [y, mo] = m.split('-').map(Number);
          const nextMonth = new Date(y!, mo!, 1); // One month after
          return nextMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        }).join(', ')
      : `${nextMonthStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${nextMonthEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    
    let nextMonthDays = 0;
    for (const range of nextMonthRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      nextMonthDays += Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }
    const nextMonthWeeks = nextMonthDays / 7;
    
    // Calculate selected next months for filtering
    const selectedNextMonths = selectedMonths.map(m => {
      const [y, mo] = m.split('-').map(Number);
      const nextDate = new Date(y!, mo!, 1);
      return `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    });

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
        .select('style_no, color, size, quantity, date', { count: 'exact' })
        .in('style_no', styleNos)
        .in('color', colors)
        .gte('date', queryStartDate)
        .lte('date', queryEndDate)
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

    // For multi-month: filter to only include rows within specified month ranges
    let historicalData = allHistoricalData;
    if (selectedMonths.length > 0) {
      const monthSet = new Set(selectedMonths);
      historicalData = allHistoricalData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7); // 'YYYY-MM'
        return monthSet.has(rowMonth);
      });
      console.log(`🔍 [DEBUG] Filtered to ${historicalData.length} rows for selected months: ${selectedMonths.join(', ')}`);
    }

    console.log('🔍 [DEBUG] Historical data query COMPLETE:', {
      dateRange: `${queryStartDate} to ${queryEndDate}`,
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
        .select('style_no, color, size, quantity, date')
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

    // For multi-month: filter to only include rows within specified next month ranges
    let nextMonthData = allNextMonthData;
    if (selectedNextMonths.length > 0) {
      const monthSet = new Set(selectedNextMonths);
      nextMonthData = allNextMonthData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7); // 'YYYY-MM'
        return monthSet.has(rowMonth);
      });
      console.log(`🔍 [DEBUG] Filtered next month to ${nextMonthData.length} rows for: ${selectedNextMonths.join(', ')}`);
    }
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

      // Calculate purchase running (all running POs)
      const purchaseRows = latestRows.filter((r) => r.section === 'Purchase (Running + Shipped)');
      const purchaseRunning = purchaseRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + (vals[i] ?? 0));
      }, Array(num).fill(0) as number[]);
      const totalPurchaseRunning = purchaseRunning.reduce((a, b) => a + b, 0);

      // Calculate Bell Rain available (call-home stock from secondary storage)
      const bellRainRows = latestRows.filter((r) => 
        r.section === 'Purchase (Running + Shipped)' && isBellRainRow(r)
      );
      const bellRainAvailable = bellRainRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + (vals[i] ?? 0));
      }, Array(num).fill(0) as number[]);
      const totalBellRainAvailable = bellRainAvailable.reduce((a, b) => a + b, 0);

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

      // BELL RAIN LOGIC: First use available Bell Rain stock before ordering new
      // Bell Rain = secondary storage we can "call home"
      const bellRainCallHome = Math.min(totalBellRainAvailable, suggestedOrder);
      const newOrderNeeded = Math.max(0, suggestedOrder - bellRainCallHome);

      // Calculate suggested order per size (distributed by historical pressure)
      const historicalTotal = historical.reduce((a: number, b: number) => a + b, 0);
      
      // Helper to distribute quantity across sizes by historical pressure
      const distributeByPressure = (total: number): number[] => {
        if (historicalTotal <= 0 || total <= 0) return sizes.map(() => 0);
        
        const exact = historical.map((h: number) => (h / historicalTotal) * total);
        const floored = exact.map((v: number) => Math.floor(v));
        let remaining = total - floored.reduce((a: number, b: number) => a + b, 0);
        const fractional = exact.map((v: number, i: number) => ({ i, frac: v - Math.floor(v) }));
        fractional.sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < remaining && k < fractional.length; k++) {
          const item = fractional[k];
          if (item && item.i >= 0 && item.i < floored.length) {
            floored[item.i] = (floored[item.i] || 0) + 1;
          }
        }
        return floored;
      };

      const suggestedOrderBySize = distributeByPressure(suggestedOrder);
      
      // Calculate per-size Bell Rain call home (capped by available)
      let bellRainCallHomeBySize = distributeByPressure(bellRainCallHome);
      // Cap by actual Bell Rain available per size
      bellRainCallHomeBySize = bellRainCallHomeBySize.map((qty, i) => 
        Math.min(qty, bellRainAvailable[i] ?? 0)
      );
      const actualBellRainCallHome = bellRainCallHomeBySize.reduce((a, b) => a + b, 0);
      
      // Calculate new order needed per size
      const newOrderNeededBySize = suggestedOrderBySize.map((qty, i) => 
        Math.max(0, qty - (bellRainCallHomeBySize[i] ?? 0))
      );

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
        purchaseRunning,
        bellRainAvailable,
        historical,
        nextMonthHistorical,
        totalStock: stock.reduce((a, b) => a + b, 0),
        totalSold: sold.reduce((a, b) => a + b, 0),
        totalNetStock,
        totalPurchaseRunning,
        totalBellRainAvailable,
        totalHistorical,
        totalNextMonthHistorical,
        weeklyRate,
        nextMonthWeeklyRate,
        targetStock,
        suggestedOrder,
        bellRainCallHome: actualBellRainCallHome,
        newOrderNeeded: suggestedOrder - actualBellRainCallHome,
        suggestedOrderBySize,
        bellRainCallHomeBySize,
        newOrderNeededBySize,
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
    const totalBellRainCallHome = items.reduce((sum, i) => sum + i.bellRainCallHome, 0);
    const totalNewOrderNeeded = items.reduce((sum, i) => sum + i.newOrderNeeded, 0);

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

    // Fetch recent feedback for these items to include in AI prompt
    let feedbackSummary = '';
    try {
      const { data: recentFeedback } = await supabase
        .from('call_off_feedback')
        .select('style_no, color, verdict, notes, created_at')
        .in('style_no', styleNos)
        .in('color', colors)
        .order('created_at', { ascending: false })
        .limit(20);

      if (recentFeedback && recentFeedback.length > 0) {
        const correct = recentFeedback.filter(f => f.verdict === 'correct').length;
        const incorrect = recentFeedback.filter(f => f.verdict === 'incorrect').length;
        const withNotes = recentFeedback.filter(f => f.notes);
        
        feedbackSummary = `\n\nPREVIOUS FEEDBACK (${recentFeedback.length} entries, ${correct} correct, ${incorrect} incorrect):`;
        if (withNotes.length > 0) {
          feedbackSummary += '\nUser notes:';
          withNotes.slice(0, 3).forEach(f => {
            feedbackSummary += `\n- ${f.style_no} ${f.color} (${f.verdict}): ${f.notes}`;
          });
        }
      }
    } catch (e) {
      console.warn('Could not fetch feedback:', e);
    }

    // Fetch supplier data to check for BELL_RAIN pull-first logic
    let supplierRulesSnapshot: any = null;
    let bellRainInfo = '';
    try {
      const { data: suppliers } = await supabase
        .from('suppliers')
        .select('id, name, tags, lead_time_days, travel_time_days, moq')
        .eq('active', true);

      if (suppliers && suppliers.length > 0) {
        supplierRulesSnapshot = { suppliers, fetchedAt: new Date().toISOString() };
        
        // Check for BELL_RAIN tagged supplier
        const bellRain = suppliers.find(s => s.tags?.includes('BELL_RAIN'));
        if (bellRain) {
          bellRainInfo = `\nIMPORTANT - BELL RAIN STOCK: ${totalBellRainCallHome} units can be CALLED HOME from secondary storage before ordering ${totalNewOrderNeeded} new units.`;
        }
      }
    } catch (e) {
      console.warn('Could not fetch suppliers:', e);
    }

    // Get items with Bell Rain stock available
    const bellRainItems = items.filter(i => i.bellRainCallHome > 0);

    // Generate AI summary
    const topCritical = items.filter(i => i.status === 'critical').slice(0, 5);
    const topSurplus = items.filter(i => i.status === 'surplus').slice(0, 3);
    const topTrending = items.filter(i => i.trendDirection === 'up').slice(0, 3);

    const aiPrompt = `Analyze this NOOS inventory data and provide a focused summary. Be concise and stick to the data - no generic business advice.${bellRainInfo}

PERIOD: ${periodDisplay} | TARGET: ${weeks_cover} weeks cover

STATUS: ${criticalItems} critical, ${lowItems} low, ${okItems} OK, ${surplusItems} surplus
TOTAL NEEDED: ${totalSuggestedOrder} units (Bell Rain call-home: ${totalBellRainCallHome}, New order: ${totalNewOrderNeeded})

${bellRainItems.length > 0 ? `BELL RAIN - CALL HOME FIRST:
${bellRainItems.slice(0, 5).map(i => `• ${i.style_name} (${i.color}): call home ${i.bellRainCallHome} units, then order ${i.newOrderNeeded} new`).join('\n')}` : ''}

${topCritical.length > 0 ? `CRITICAL (order immediately):
${topCritical.map(i => `• ${i.style_name} (${i.color}): ${i.totalNetStock} in stock → need +${i.suggestedOrder}${i.bellRainCallHome > 0 ? ` (${i.bellRainCallHome} from Bell Rain)` : ''}${i.trendDirection === 'up' ? ' [demand rising]' : ''}`).join('\n')}` : ''}

${topTrending.length > 0 ? `RISING DEMAND (prepare extra):
${topTrending.map(i => `• ${i.style_name} (${i.color}): +${i.trendPercent.toFixed(0)}% vs next month`).join('\n')}` : ''}

${topSurplus.length > 0 ? `SURPLUS (slow movers):
${topSurplus.map(i => `• ${i.style_name} (${i.color}): ${i.totalNetStock - i.targetStock} units above target`).join('\n')}` : ''}

${ordersByStyle.length > 0 ? `ORDER BY STYLE:
${ordersByStyle.slice(0, 5).map(s => `• ${s.style_name}: +${s.totalOrder} (${s.colors.length} colors)`).join('\n')}` : ''}

Provide a brief summary in 3-4 sentences:
1. What to CALL HOME from Bell Rain first (if any)
2. What to order NEW (style names and quantities)
3. What's trending up for next month
${feedbackSummary}
Keep it SHORT. Only mention specific styles. No general business advice.`;

    let aiSummary = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: aiPrompt }],
        max_completion_tokens: 600,  // GPT-5 uses max_completion_tokens
        // GPT-5 only supports temperature=1 (default)
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
        start: queryStartDate,
        end: queryEndDate,
        display: periodDisplay
      },
      nextMonthRange: {
        start: nextMonthStartStr,
        end: nextMonthEndStr,
        display: nextMonthDisplay
      },
      supplierRulesSnapshot,
      // Debug info
      _debug: {
        historicalRowsLoaded: historicalData?.length || 0,
        historicalTotalCount: historicalCount,
        totalHistoricalQty,
        stockRowsLoaded: stockData?.length || 0,
        nextMonthRowsLoaded: nextMonthData?.length || 0,
        queryDateRange: { startDate: queryStartDate, endDate: queryEndDate },
        selectedMonths: selectedMonths.length > 0 ? selectedMonths : undefined,
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

