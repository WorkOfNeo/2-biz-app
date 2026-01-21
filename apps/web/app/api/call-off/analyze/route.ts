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

type SuggestionOutput = {
  style_no: string;
  color: string;
  analysis: string;
  weekly_rate: number;
  current_available: number;
  target_stock: number;
  order_suggestion: number[];
  sizes: string[];
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { selections, weeks_cover = 4, startDate, endDate, reference_month, months } = body;
    
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
      const start = new Date(startDate);
      const end = new Date(endDate);
      dateRanges.push({ start: startDate, end: endDate });
      periodDisplay = `${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    }
    // Legacy: reference_month
    else if (reference_month && typeof reference_month === 'string') {
      const parts = reference_month.split('-');
      if (parts.length !== 2) {
        return NextResponse.json({ error: 'Invalid reference_month format. Use YYYY-MM' }, { status: 400 });
      }
      
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      
      if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
        return NextResponse.json({ error: 'Invalid reference_month format. Use YYYY-MM' }, { status: 400 });
      }
      
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      const startStr = start.toISOString().split('T')[0] as string;
      const endStr = end.toISOString().split('T')[0] as string;
      dateRanges.push({ start: startStr, end: endStr });
      periodDisplay = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    else {
      return NextResponse.json({ error: 'Either months[], startDate/endDate or reference_month is required' }, { status: 400 });
    }

    // Calculate overall date range for querying
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

    // Calculate total days across selected months
    let daysInPeriod = 0;
    for (const range of dateRanges) {
      const s = new Date(range.start);
      const e = new Date(range.end);
      daysInPeriod += Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Get unique style numbers and colors
    const styleNos = Array.from(new Set(selections.map((s: SelectionInput) => s.style_no)));
    const colors = Array.from(new Set(selections.map((s: SelectionInput) => s.color)));

    // Fetch current stock data
    const { data: stockData, error: stockError } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', styleNos)
      .in('color', colors);

    if (stockError) {
      return NextResponse.json({ error: stockError.message }, { status: 500 });
    }

    // Fetch historical sales for selected period
    // Use a high limit to ensure we get all data (Supabase default is 1000)
    const { data: rawHistoricalData, error: historicalError } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity, date')
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', startDateStr)
      .lte('date', endDateStr)
      .limit(50000);

    if (historicalError) {
      return NextResponse.json({ error: historicalError.message }, { status: 500 });
    }

    // For multi-month: filter to only include rows within specified month ranges
    let historicalData = rawHistoricalData || [];
    if (selectedMonths.length > 0) {
      const monthSet = new Set(selectedMonths);
      historicalData = historicalData.filter((row: any) => {
        if (!row.date) return false;
        const rowMonth = row.date.substring(0, 7); // 'YYYY-MM'
        return monthSet.has(rowMonth);
      });
    }

    // Process each selection
    const suggestions: SuggestionOutput[] = [];

    for (const selection of selections as SelectionInput[]) {
      const { style_no, color } = selection;
      const key = `${style_no}|${color}`.toLowerCase();

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
        const num = parseFloat(trimmed);
        if (!isNaN(num) && trimmed.includes('.')) {
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

      // Calculate net stock (Stock - Sold, no purchase included for NOOS)
      const netStock = stock.map((v, i) => v - (sold[i] ?? 0));
      const currentNetStock = netStock.reduce((a, b) => a + b, 0);

      // Get historical sales for this color
      const colorHistorical = (historicalData || []).filter(
        (h: any) => h.style_no === style_no && h.color === color
      );

      // Aggregate historical by size (with normalization for sizes like "44.00" -> "44")
      const historicalBySize = new Map<string, number>();
      colorHistorical.forEach((h: any) => {
        const normalizedSize = normalizeSize(h.size);
        const current = historicalBySize.get(normalizedSize) || 0;
        historicalBySize.set(normalizedSize, current + h.quantity);
      });

      // Match sizes with normalization
      const historical = sizes.map((size: string) => {
        const normalizedSize = normalizeSize(size);
        return historicalBySize.get(normalizedSize) || historicalBySize.get(size) || 0;
      });
      const totalHistorical = historical.reduce((a: number, b: number) => a + b, 0);

      // Calculate weekly rate from historical data
      const weeksInPeriod = daysInPeriod / 7;
      const weeklyRate = totalHistorical / weeksInPeriod;
      const targetStock = Math.ceil(weeklyRate * weeks_cover);

      // Calculate what we need to order
      const neededTotal = Math.max(0, targetStock - currentNetStock);

      // Distribute order by historical pressure
      const historicalTotal = historical.reduce((a: number, b: number) => a + b, 0);
      let orderSuggestion: number[];

      if (historicalTotal > 0 && neededTotal > 0) {
        // Distribute based on historical sales pressure
        const exact = historical.map((h: number) => (h / historicalTotal) * neededTotal);
        const floored = exact.map((v: number) => Math.floor(v));
        let remaining = neededTotal - floored.reduce((a: number, b: number) => a + b, 0);
        
        const fractional = exact.map((v: number, i: number) => ({ i, frac: v - Math.floor(v) }));
        fractional.sort((a, b) => b.frac - a.frac);
        
        for (let k = 0; k < remaining && k < fractional.length; k++) {
          const item = fractional[k];
          if (item && item.i >= 0 && item.i < floored.length) {
            floored[item.i] = (floored[item.i] || 0) + 1;
          }
        }
        
        orderSuggestion = floored;
      } else {
        // Even distribution if no historical data
        const perSize = neededTotal > 0 ? Math.floor(neededTotal / num) : 0;
        const remainder = neededTotal > 0 ? neededTotal % num : 0;
        orderSuggestion = sizes.map((_: string, i: number) => perSize + (i < remainder ? 1 : 0));
      }

      // Use OpenAI to generate a human-readable analysis
      const prompt = `You are a stock replenishment advisor for a fashion/apparel company. Analyze the following data and provide a brief, actionable recommendation (2-3 sentences max).

Style: ${style_no}
Color: ${color}

Current Stock Situation:
- Stock on hand: ${stock.reduce((a, b) => a + b, 0)} units
- Already sold: ${sold.reduce((a, b) => a + b, 0)} units  
- Net Stock (Stock - Sold): ${currentNetStock} units

Historical Reference (${periodDisplay}):
- Total sold in period: ${totalHistorical} units
- Period duration: ${daysInPeriod} days
- Weekly sales rate: ${weeklyRate.toFixed(1)} units/week

Target:
- Weeks of cover needed: ${weeks_cover} weeks
- Target stock level: ${targetStock} units
- Suggested order quantity: ${neededTotal} units

Provide a brief analysis explaining why we should order ${neededTotal} units (or if the order is 0, explain why no order is needed). Be specific about the numbers.`;

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-5-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful inventory analyst. Provide brief, data-driven recommendations for stock replenishment. Keep responses under 100 words.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_completion_tokens: 200,  // GPT-5 uses max_completion_tokens
          // GPT-5 only supports temperature=1 (default)
        });

        const analysis = completion.choices[0]?.message?.content || 
          `Based on ${periodDisplay} sales of ${totalHistorical} units (${weeklyRate.toFixed(1)}/week), with ${currentNetStock} units net stock and a target of ${targetStock} units for ${weeks_cover} weeks cover, ordering ${neededTotal} units is recommended.`;

        suggestions.push({
          style_no,
          color,
          analysis,
          weekly_rate: weeklyRate,
          current_available: currentNetStock,
          target_stock: targetStock,
          order_suggestion: orderSuggestion,
          sizes
        });
      } catch (aiError: any) {
        // Fallback if OpenAI fails
        const analysis = `Based on ${periodDisplay} sales of ${totalHistorical} units (${weeklyRate.toFixed(1)}/week), with ${currentNetStock} units net stock and a target of ${targetStock} units for ${weeks_cover} weeks cover, ordering ${neededTotal} units is recommended.`;
        
        suggestions.push({
          style_no,
          color,
          analysis,
          weekly_rate: weeklyRate,
          current_available: currentNetStock,
          target_stock: targetStock,
          order_suggestion: orderSuggestion,
          sizes
        });
      }
    }

    return NextResponse.json({
      suggestions,
      weeks_cover,
      period_display: periodDisplay,
      start_date: startDateStr,
      end_date: endDateStr
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

