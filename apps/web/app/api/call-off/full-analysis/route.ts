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
  color: string;
  sizes: string[];
  stock: number[];
  sold: number[];
  netStock: number[];
  historical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalHistorical: number;
  weeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  priority: number;
};

type FullAnalysisResponse = {
  items: ItemAnalysis[];
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    aiSummary: string;
  };
  dateRange: {
    start: string;
    end: string;
    display: string;
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

    // Fetch historical sales for the date range
    // Use a high limit to ensure we get all data (Supabase default is 1000)
    const { data: historicalData, error: historicalError } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity')
      .in('style_no', styleNos)
      .in('color', colors)
      .gte('date', startDate)
      .lte('date', endDate)
      .limit(50000);

    if (historicalError) {
      return NextResponse.json({ error: historicalError.message }, { status: 500 });
    }

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

      // Calculate weekly rate and target stock
      const weeklyRate = totalHistorical / weeksInPeriod;
      const targetStock = Math.ceil(weeklyRate * weeks_cover);

      // Calculate suggested order
      const suggestedOrder = Math.max(0, targetStock - totalNetStock);

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
        color,
        sizes,
        stock,
        sold,
        netStock,
        historical,
        totalStock: stock.reduce((a, b) => a + b, 0),
        totalSold: sold.reduce((a, b) => a + b, 0),
        totalNetStock,
        totalHistorical,
        weeklyRate,
        targetStock,
        suggestedOrder,
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

    // Generate AI summary
    const topCritical = items.filter(i => i.status === 'critical').slice(0, 5);
    const topSurplus = items.filter(i => i.status === 'surplus').slice(0, 3);

    const aiPrompt = `You are an inventory analyst for a fashion retailer. Analyze this NOOS (Never Out Of Stock) replenishment summary and provide a brief, actionable overview (3-4 sentences max).

Analysis Period: ${periodDisplay}
Target Coverage: ${weeks_cover} weeks

Summary:
- Total items analyzed: ${items.length}
- Critical (need immediate attention): ${criticalItems}
- Low stock: ${lowItems}
- OK: ${okItems}
- Surplus (excess stock): ${surplusItems}
- Total suggested order quantity: ${totalSuggestedOrder} units

${topCritical.length > 0 ? `Most Critical Items:
${topCritical.map(i => `- ${i.style_no} ${i.color}: Net stock ${i.totalNetStock}, Target ${i.targetStock}, Need ${i.suggestedOrder}`).join('\n')}` : ''}

${topSurplus.length > 0 ? `Items with Surplus:
${topSurplus.map(i => `- ${i.style_no} ${i.color}: Net stock ${i.totalNetStock}, Target ${i.targetStock}, Excess ${i.totalNetStock - i.targetStock}`).join('\n')}` : ''}

Provide a concise summary highlighting:
1. Priority actions needed
2. Any concerning patterns
3. Overall stock health assessment`;

    let aiSummary = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: aiPrompt }],
        max_tokens: 300,
        temperature: 0.7
      });
      aiSummary = completion.choices[0]?.message?.content || 'Unable to generate AI summary.';
    } catch (e) {
      aiSummary = `Analysis complete: ${criticalItems} critical items need immediate attention, ${lowItems} are low stock. Total recommended order: ${totalSuggestedOrder} units across ${items.length} items.`;
    }

    const response: FullAnalysisResponse = {
      items,
      summary: {
        totalItems: items.length,
        criticalItems,
        lowItems,
        okItems,
        surplusItems,
        totalSuggestedOrder,
        aiSummary
      },
      dateRange: {
        start: startDate,
        end: endDate,
        display: periodDisplay
      }
    };

    return NextResponse.json(response);
  } catch (error: any) {
    console.error('Full analysis error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

