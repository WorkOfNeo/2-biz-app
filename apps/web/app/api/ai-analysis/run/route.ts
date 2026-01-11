export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120; // 2 minutes max for AI call

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig, interpolatePrompt } from '../../../../lib/ai/prompts';

type AnalysisType = 'daily' | 'purchase_round';

// Helper to fetch all rows with pagination (bypasses Supabase 1000 row limit)
async function fetchAllRows<T>(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  table: string,
  select: string,
  filters: Record<string, any>,
  options?: { orderBy?: string; cap?: number }
): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const cap = options?.cap ?? 100000;
  let from = 0;
  const allRows: T[] = [];

  while (from < cap) {
    let query = supabase.from(table).select(select);
    
    // Apply filters
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
    
    // Apply ordering and range
    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: true });
    }
    query = query.range(from, from + PAGE_SIZE - 1);
    
    const { data, error } = await query;
    if (error) throw error;
    
    const batch = (data ?? []) as T[];
    allRows.push(...batch);
    
    // Break if we got fewer rows than requested (end of data)
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  
  return allRows;
}

interface RunAnalysisRequest {
  analysisType?: AnalysisType;
  seasonId?: string;         // Override for current season
  comparisonSeasonId?: string; // Override for comparison season
  purchaseRoundNumber?: number; // For purchase rounds
  sendEmail?: boolean;
}

// Build context data from scraped sources
async function buildAnalysisContext(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  seasonId: string,
  comparisonSeasonId: string | null
) {
  // 1. Get season info
  const { data: currentSeason } = await supabase
    .from('seasons')
    .select('id, name, year, created_at, is_current, is_frozen')
    .eq('id', seasonId)
    .single() as { data: { id: string; name: string; year: number | null; created_at: string; is_current: boolean; is_frozen: boolean } | null };

  let comparisonSeason: { id: string; name: string; year: number | null; created_at: string } | null = null;
  if (comparisonSeasonId) {
    const { data } = await supabase
      .from('seasons')
      .select('id, name, year, created_at')
      .eq('id', comparisonSeasonId)
      .single() as { data: { id: string; name: string; year: number | null; created_at: string } | null };
    comparisonSeason = data;
  }

  // 2. Fetch sales_stats for current season (with pagination)
  // Note: country comes from customers table, not sales_stats
  const salesStats = await fetchAllRows<any>(
    supabase,
    'sales_stats',
    'account_no, customer_name, qty, price, salesperson_id',
    { season_id: seasonId },
    { cap: 50000 }
  );

  // 3. Fetch sales_style_details_rows for style-level detail (with pagination)
  const styleDetails = await fetchAllRows<any>(
    supabase,
    'sales_style_details_rows',
    'style_no, style_name, color, size, qty, account_no',
    { season_id: seasonId },
    { cap: 100000 }
  );

  // 4. Get unique style numbers for stock lookup
  const styleNos = Array.from(new Set((styleDetails ?? []).map((r: any) => r.style_no).filter(Boolean)));

  // 5. Fetch style_stock for stock levels (with pagination for large datasets)
  let stockData: any[] = [];
  if (styleNos.length > 0) {
    // Fetch in batches of 500 style numbers to avoid query size limits
    const PAGE_SIZE = 1000;
    let from = 0;
    const styleBatch = styleNos.slice(0, 1000); // Limit styles to check
    
    while (from < 50000) {
      const { data } = await supabase
        .from('style_stock')
        .select('style_no, color, section, row_label, sizes, values')
        .in('style_no', styleBatch)
        .range(from, from + PAGE_SIZE - 1);
      
      const batch = data ?? [];
      stockData.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  // 6. Fetch customers (with pagination)
  // Note: customers table uses 'company' or 'stats_display_name', not 'customer_name'
  const customers = await fetchAllRows<any>(
    supabase,
    'customers',
    'customer_id, company, stats_display_name, country, salesperson_id',
    {},
    { cap: 10000 }
  );

  // 7. Fetch salespersons
  const { data: salespersons } = await supabase
    .from('salespersons')
    .select('id, name, email')
    .limit(100) as { data: { id: string; name: string; email: string | null }[] | null };

  // 8. Fetch comparison season data (if available) with pagination
  let comparisonStats: any[] = [];
  let comparisonStyleDetails: any[] = [];
  if (comparisonSeasonId) {
    comparisonStats = await fetchAllRows<any>(
      supabase,
      'sales_stats',
      'account_no, qty, price, salesperson_id',
      { season_id: comparisonSeasonId },
      { cap: 50000 }
    );

    comparisonStyleDetails = await fetchAllRows<any>(
      supabase,
      'sales_style_details_rows',
      'style_no, color, qty',
      { season_id: comparisonSeasonId },
      { cap: 100000 }
    );
  }

  // ========== CALCULATE METRICS ==========

  // Current season totals
  const totalQty = (salesStats ?? []).reduce((sum: number, r: any) => sum + (Number(r.qty) || 0), 0);
  const totalRevenue = (salesStats ?? []).reduce((sum: number, r: any) => sum + (Number(r.price) || 0), 0);
  const uniqueCustomers = new Set((salesStats ?? []).map((r: any) => r.account_no)).size;
  const uniqueStyles = new Set((styleDetails ?? []).map((r: any) => r.style_no)).size;

  // Customer coverage
  const totalCustomers = (customers ?? []).length;
  const visitedCustomers = uniqueCustomers;
  const visitRatePercent = totalCustomers > 0 ? Math.round((visitedCustomers / totalCustomers) * 1000) / 10 : 0;

  // Calculate days active (from season created_at to now)
  const seasonStart = currentSeason?.created_at ? new Date(currentSeason.created_at) : new Date();
  const daysActive = Math.max(1, Math.floor((Date.now() - seasonStart.getTime()) / (1000 * 60 * 60 * 24)));

  // Velocity
  const avgDailyQty = Math.round(totalQty / daysActive);
  const avgDailyRevenue = Math.round(totalRevenue / daysActive);
  const projectedTotal = avgDailyQty * 42; // Assume 6 weeks = 42 days

  // Group by salesperson
  const bySalesperson: Record<string, { id: string; name: string; qty: number; revenue: number; customers: Set<string> }> = {};
  for (const row of (salesStats ?? []) as any[]) {
    const spId = row.salesperson_id || 'unknown';
    if (!bySalesperson[spId]) {
      const sp = (salespersons ?? []).find((s: any) => s.id === spId);
      bySalesperson[spId] = { id: spId, name: sp?.name || 'Unknown', qty: 0, revenue: 0, customers: new Set() };
    }
    bySalesperson[spId].qty += Number(row.qty) || 0;
    bySalesperson[spId].revenue += Number(row.price) || 0;
    if (row.account_no) bySalesperson[spId].customers.add(row.account_no);
  }

  // Get customer counts per salesperson
  const customersBySalesperson: Record<string, number> = {};
  for (const c of (customers ?? []) as any[]) {
    const spId = c.salesperson_id || 'unknown';
    customersBySalesperson[spId] = (customersBySalesperson[spId] || 0) + 1;
  }

  const salespersonData = Object.values(bySalesperson).map(sp => {
    const totalCustomers = customersBySalesperson[sp.id] || 0;
    return {
      id: sp.id,
      name: sp.name,
      status: sp.qty > 0 ? 'active' : 'not_started',
      metrics: {
        qty_sold: sp.qty,
        revenue: sp.revenue,
        customers_visited: sp.customers.size,
        customers_total: totalCustomers,
        visit_rate_percent: totalCustomers > 0 ? Math.round((sp.customers.size / totalCustomers) * 1000) / 10 : 0
      }
    };
  }).sort((a, b) => b.metrics.qty_sold - a.metrics.qty_sold);

  // Add salespersons with 0 sales
  for (const sp of (salespersons ?? []) as any[]) {
    if (!bySalesperson[sp.id]) {
      salespersonData.push({
        id: sp.id,
        name: sp.name,
        status: 'not_started',
        metrics: {
          qty_sold: 0,
          revenue: 0,
          customers_visited: 0,
          customers_total: customersBySalesperson[sp.id] || 0,
          visit_rate_percent: 0
        }
      });
    }
  }

  // Build customer_id -> country mapping from customers table
  const customerCountryMap = new Map<string, string>();
  for (const c of (customers ?? []) as any[]) {
    if (c.customer_id) customerCountryMap.set(c.customer_id, c.country || 'Unknown');
  }

  // Group by country (look up country from customers table via account_no)
  const byCountry: Record<string, { qty: number; revenue: number; customers: Set<string> }> = {};
  for (const row of (salesStats ?? []) as any[]) {
    const country = customerCountryMap.get(row.account_no) || 'Unknown';
    if (!byCountry[country]) byCountry[country] = { qty: 0, revenue: 0, customers: new Set() };
    byCountry[country].qty += Number(row.qty) || 0;
    byCountry[country].revenue += Number(row.price) || 0;
    if (row.account_no) byCountry[country].customers.add(row.account_no);
  }
  const countryData = Object.entries(byCountry)
    .map(([country, data]) => ({ country, qty: data.qty, revenue: data.revenue, customer_count: data.customers.size }))
    .sort((a, b) => b.qty - a.qty);

  // Group style details by style_no
  const styleQty: Record<string, { qty: number; colors: Set<string>; customers: Set<string> }> = {};
  for (const row of (styleDetails ?? []) as any[]) {
    const sn = row.style_no;
    if (!sn) continue;
    if (!styleQty[sn]) styleQty[sn] = { qty: 0, colors: new Set(), customers: new Set() };
    styleQty[sn].qty += Number(row.qty) || 0;
    if (row.color) styleQty[sn].colors.add(row.color);
    if (row.account_no) styleQty[sn].customers.add(row.account_no);
  }

  const topStyles = Object.entries(styleQty)
    .map(([style_no, data]) => ({
      style_no,
      total_qty: data.qty,
      colors_count: data.colors.size,
      customer_count: data.customers.size
    }))
    .sort((a, b) => b.total_qty - a.total_qty)
    .slice(0, 20);

  // Stock status summary
  const stockSections: Record<string, any[]> = {};
  for (const row of stockData) {
    const key = `${row.style_no}|${row.color}`;
    if (!stockSections[key]) stockSections[key] = [];
    stockSections[key].push(row);
  }

  let lowStockCount = 0;
  let zeroStockCount = 0;
  const criticalStyles: any[] = [];

  for (const [key, rows] of Object.entries(stockSections)) {
    const availableRow = rows.find((r: any) => r.section === 'Available' || r.section === 'Stock');
    if (availableRow) {
      const values = availableRow.values || [];
      const total = values.reduce((s: number, v: number) => s + (Number(v) || 0), 0);
      if (total === 0) zeroStockCount++;
      else if (total < 50) lowStockCount++;

      // Check if style is selling fast with low stock
      const parts = key.split('|');
      const styleNo = parts[0] || '';
      const color = parts[1] || '';
      if (styleNo && styleQty[styleNo]) {
        const styleData = styleQty[styleNo];
        if (styleData && total < 50 && styleData.qty > 100) {
          criticalStyles.push({
            style_no: styleNo,
            color,
            available: total,
            sold_this_season: styleData.qty
          });
        }
      }
    }
  }

  // Comparison season totals
  let comparisonTotals = null;
  if (comparisonSeasonId && comparisonStats.length > 0) {
    const cQty = comparisonStats.reduce((sum: number, r: any) => sum + (Number(r.qty) || 0), 0);
    const cRevenue = comparisonStats.reduce((sum: number, r: any) => sum + (Number(r.price) || 0), 0);
    comparisonTotals = {
      final_qty: cQty,
      final_revenue: cRevenue,
      customer_count: new Set(comparisonStats.map((r: any) => r.account_no)).size
    };
  }

  // Build the context object
  const currentSeasonData = {
    current_season: {
      id: currentSeason?.id,
      name: currentSeason?.name,
      year: currentSeason?.year,
      days_active: daysActive,
      started_at: currentSeason?.created_at
    },
    comparison_season: comparisonSeason ? {
      id: comparisonSeason.id,
      name: comparisonSeason.name,
      year: comparisonSeason.year,
      final_totals: comparisonTotals
    } : null,
    is_first_season: !comparisonSeasonId,
    totals: {
      qty_sold: totalQty,
      revenue: totalRevenue,
      unique_customers: uniqueCustomers,
      unique_styles: uniqueStyles
    },
    customer_coverage: {
      total_customers: totalCustomers,
      visited_customers: visitedCustomers,
      visit_rate_percent: visitRatePercent
    },
    velocity: {
      avg_daily_qty: avgDailyQty,
      avg_daily_revenue: avgDailyRevenue,
      projected_season_total: projectedTotal
    },
    salespersons: salespersonData,
    by_country: countryData,
    top_styles: topStyles,
    stock_summary: {
      styles_with_low_stock: lowStockCount,
      styles_with_zero_stock: zeroStockCount,
      critical_styles: criticalStyles.slice(0, 10)
    }
  };

  return { currentSeasonData, comparisonTotals, metrics: currentSeasonData };
}

export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: RunAnalysisRequest = await req.json();
    const { analysisType = 'daily', purchaseRoundNumber, sendEmail = false } = body;

    // Get OpenAI API key
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    // Get season IDs from request or from app_settings
    let seasonId = body.seasonId;
    let comparisonSeasonId = body.comparisonSeasonId;

    if (!seasonId) {
      // Get from season_compare settings
      const { data: setting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'season_compare')
        .maybeSingle();
      seasonId = (setting?.value as any)?.s1;
      comparisonSeasonId = (setting?.value as any)?.s2;
    }

    if (!seasonId) {
      return NextResponse.json({ error: 'No season configured. Set season_compare in settings.' }, { status: 400 });
    }

    console.log('[AI Analysis] Starting', analysisType, 'analysis for season:', seasonId);

    // Build context from database
    const { currentSeasonData, metrics } = await buildAnalysisContext(supabase, seasonId, comparisonSeasonId || null);

    // Get the appropriate prompt
    const promptKey = analysisType === 'purchase_round' ? 'purchase_round_v1' : 'daily_analysis_v1';
    const promptConfig = await getPromptConfig(promptKey);

    // Interpolate the prompt
    const systemPrompt = promptConfig.content;
    const userMessage = interpolatePrompt(`
## Current Season Data
{{current_season_data}}

## Comparison Season (Last Year)
{{comparison_season_data}}
`, {
      current_season_data: JSON.stringify(currentSeasonData, null, 2),
      comparison_season_data: currentSeasonData.comparison_season 
        ? JSON.stringify(currentSeasonData.comparison_season, null, 2) 
        : 'First season - no comparison available'
    });

    console.log('[AI Analysis] Calling', promptConfig.model, 'with', userMessage.length, 'chars');

    // Call OpenAI - GPT-5 has different parameter requirements:
    // - Uses max_completion_tokens instead of max_tokens
    // - Does not support custom temperature (only default 1)
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const isGpt5 = promptConfig.model.startsWith('gpt-5');
    const completion = await openai.chat.completions.create({
      model: promptConfig.model,
      // GPT-5 only supports temperature=1 (default), so omit for GPT-5
      ...(!isGpt5 && { temperature: promptConfig.temperature }),
      ...(isGpt5 
        ? { max_completion_tokens: promptConfig.maxTokens }
        : { max_tokens: promptConfig.maxTokens }
      ),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' }
    });

    const rawResponse = completion.choices[0]?.message?.content || '{}';
    let aiOutput: any = {};
    try {
      aiOutput = JSON.parse(rawResponse);
    } catch (e) {
      console.error('[AI Analysis] Failed to parse AI response:', e);
      aiOutput = { error: 'Failed to parse AI response', raw: rawResponse.slice(0, 500) };
    }

    const durationMs = Date.now() - startTime;

    // Create ai_runs entry for audit
    const { data: aiRun, error: runError } = await supabase
      .from('ai_runs')
      .insert({
        prompt_key: promptKey,
        prompt_version: promptConfig.version,
        prompt_content: systemPrompt,
        model: promptConfig.model,
        temperature: promptConfig.temperature,
        max_tokens: promptConfig.maxTokens,
        input_snapshot: { seasonId, comparisonSeasonId, metrics },
        output: aiOutput,
        raw_response: rawResponse,
        usage: completion.usage,
        status: 'completed',
        duration_ms: durationMs,
        completed_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (runError) {
      console.error('[AI Analysis] Failed to create ai_runs entry:', runError);
    }

    // Create ai_season_analyses entry
    const { data: analysis, error: analysisError } = await supabase
      .from('ai_season_analyses')
      .insert({
        ai_run_id: aiRun?.id || null,
        season_id: seasonId,
        comparison_season_id: comparisonSeasonId || null,
        analysis_type: analysisType,
        analysis_date: new Date().toISOString().split('T')[0],
        metrics: metrics,
        executive_summary: aiOutput.executive_summary || null,
        salesperson_reports: aiOutput.salesperson_reports || {},
        style_insights: aiOutput.style_insights || {},
        warnings: aiOutput.warnings || [],
        recommendations: aiOutput.recommendations || [],
        comparison_note: aiOutput.comparison_note || null,
        purchase_round_number: purchaseRoundNumber || null,
        purchase_recommendations: aiOutput.purchase_recommendations || null
      })
      .select('id')
      .single();

    if (analysisError) {
      console.error('[AI Analysis] Failed to create analysis entry:', analysisError);
      return NextResponse.json({ error: 'Failed to save analysis', detail: analysisError.message }, { status: 500 });
    }

    console.log('[AI Analysis] Completed in', durationMs, 'ms. Analysis ID:', analysis?.id);

    return NextResponse.json({
      success: true,
      analysisId: analysis?.id,
      aiRunId: aiRun?.id,
      analysisType,
      seasonId,
      comparisonSeasonId,
      durationMs,
      output: aiOutput
    });

  } catch (e: any) {
    console.error('[AI Analysis] Error:', e);
    return NextResponse.json({ error: e?.message || 'Analysis failed' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to run analysis' }, { status: 405 });
}
