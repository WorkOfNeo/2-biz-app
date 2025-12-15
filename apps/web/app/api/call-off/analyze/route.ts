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
    
    const { selections, weeks_cover = 4, reference_month } = body;
    
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    if (!reference_month || typeof reference_month !== 'string') {
      return NextResponse.json({ error: 'reference_month is required (format: YYYY-MM)' }, { status: 400 });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Parse reference month
    const [year, month] = reference_month.split('-').map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    const daysInMonth = endDate.getDate();

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

    // Fetch historical sales for reference month
    const { data: historicalData, error: historicalError } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity')
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', startDateStr)
      .lte('date', endDateStr);

    if (historicalError) {
      return NextResponse.json({ error: historicalError.message }, { status: 500 });
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
        return acc.map((v, i) => v + vals[i]);
      }, Array(num).fill(0) as number[]);

      // Calculate purchase
      const purchaseRows = latestRows.filter((r) => r.section === 'Purchase (Running + Shipped)');
      const purchase = purchaseRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + vals[i]);
      }, Array(num).fill(0) as number[]);

      // Calculate available
      const available = stock.map((v, i) => v - sold[i] + purchase[i]);
      const currentAvailable = available.reduce((a, b) => a + b, 0);

      // Get historical sales for this color
      const colorHistorical = (historicalData || []).filter(
        (h: any) => h.style_no === style_no && h.color === color
      );

      // Aggregate historical by size
      const historicalBySize = new Map<string, number>();
      colorHistorical.forEach((h: any) => {
        const current = historicalBySize.get(h.size) || 0;
        historicalBySize.set(h.size, current + h.quantity);
      });

      const historical = sizes.map((size: string) => historicalBySize.get(size) || 0);
      const totalHistorical = historical.reduce((a: number, b: number) => a + b, 0);

      // Calculate weekly rate from monthly historical data
      const weeksInMonth = daysInMonth / 7;
      const weeklyRate = totalHistorical / weeksInMonth;
      const targetStock = Math.ceil(weeklyRate * weeks_cover);

      // Calculate what we need to order
      const neededTotal = Math.max(0, targetStock - currentAvailable);

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
      const monthName = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      
      const prompt = `You are a stock replenishment advisor for a fashion/apparel company. Analyze the following data and provide a brief, actionable recommendation (2-3 sentences max).

Style: ${style_no}
Color: ${color}

Current Stock Situation:
- Stock on hand: ${stock.reduce((a, b) => a + b, 0)} units
- Already sold: ${sold.reduce((a, b) => a + b, 0)} units  
- Purchase orders incoming: ${purchase.reduce((a, b) => a + b, 0)} units
- Available (Stock - Sold + Purchase): ${currentAvailable} units

Historical Reference (${monthName}):
- Total sold in ${monthName}: ${totalHistorical} units
- Weekly sales rate: ${weeklyRate.toFixed(1)} units/week

Target:
- Weeks of cover needed: ${weeks_cover} weeks
- Target stock level: ${targetStock} units
- Suggested order quantity: ${neededTotal} units

Provide a brief analysis explaining why we should order ${neededTotal} units (or if the order is 0, explain why no order is needed). Be specific about the numbers.`;

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
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
          max_tokens: 200,
          temperature: 0.3
        });

        const analysis = completion.choices[0]?.message?.content || 
          `Based on ${monthName} sales of ${totalHistorical} units (${weeklyRate.toFixed(1)}/week), with ${currentAvailable} units available and a target of ${targetStock} units for ${weeks_cover} weeks cover, ordering ${neededTotal} units is recommended.`;

        suggestions.push({
          style_no,
          color,
          analysis,
          weekly_rate: weeklyRate,
          current_available: currentAvailable,
          target_stock: targetStock,
          order_suggestion: orderSuggestion,
          sizes
        });
      } catch (aiError: any) {
        // Fallback if OpenAI fails
        const analysis = `Based on ${monthName} sales of ${totalHistorical} units (${weeklyRate.toFixed(1)}/week), with ${currentAvailable} units available and a target of ${targetStock} units for ${weeks_cover} weeks cover, ordering ${neededTotal} units is recommended.`;
        
        suggestions.push({
          style_no,
          color,
          analysis,
          weekly_rate: weeklyRate,
          current_available: currentAvailable,
          target_stock: targetStock,
          order_suggestion: orderSuggestion,
          sizes
        });
      }
    }

    return NextResponse.json({
      suggestions,
      weeks_cover,
      reference_month,
      month_display: startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

