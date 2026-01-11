export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180; // 3 minutes max for purchase round analysis

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig, interpolatePrompt } from '../../../../lib/ai/prompts';

interface PurchaseRoundRequest {
  seasonId?: string;
  comparisonSeasonId?: string;
}

// Build comprehensive context for purchase round decisions
async function buildPurchaseRoundContext(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  seasonId: string,
  comparisonSeasonId: string | null
) {
  // 1. Get season info
  const { data: currentSeason } = await supabase
    .from('seasons')
    .select('id, name, year, created_at')
    .eq('id', seasonId)
    .single();

  // 2. Fetch sales_stats for current season
  const { data: salesStats } = await supabase
    .from('sales_stats')
    .select('account_no, customer_name, qty, price, salesperson_id, country')
    .eq('season_id', seasonId)
    .limit(50000);

  // 3. Fetch style details for current season
  const { data: styleDetails } = await supabase
    .from('sales_style_details_rows')
    .select('style_no, style_name, color, size, qty, account_no')
    .eq('season_id', seasonId)
    .limit(100000);

  // 4. Get unique style numbers
  const styleNos = Array.from(new Set((styleDetails ?? []).map((r: any) => r.style_no).filter(Boolean)));

  // 5. Fetch style_stock for stock levels (critical for purchase decisions)
  let stockData: any[] = [];
  if (styleNos.length > 0) {
    const { data } = await supabase
      .from('style_stock')
      .select('style_no, color, section, row_label, sizes, values')
      .in('style_no', styleNos.slice(0, 1000));
    stockData = data ?? [];
  }

  // 6. Fetch styles table for supplier info
  const { data: stylesInfo } = await supabase
    .from('styles')
    .select('style_no, style_name, supplier, image_url')
    .in('style_no', styleNos.slice(0, 500));

  // 7. Fetch suppliers
  const { data: suppliers } = await supabase
    .from('suppliers')
    .select('id, name, moq, lead_time_days')
    .limit(100);

  // 8. Fetch customers for coverage calculation
  const { data: customers } = await supabase
    .from('customers')
    .select('customer_id, salesperson_id')
    .limit(5000);

  // 9. Get previous purchase round number
  const { data: lastRound } = await supabase
    .from('ai_season_analyses')
    .select('purchase_round_number')
    .eq('season_id', seasonId)
    .eq('analysis_type', 'purchase_round')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { purchase_round_number: number | null } | null };

  const nextRoundNumber = ((lastRound?.purchase_round_number) || 0) + 1;

  // 10. Comparison season data
  let comparisonStyleQty: Record<string, number> = {};
  if (comparisonSeasonId) {
    const { data: cDetails } = await supabase
      .from('sales_style_details_rows')
      .select('style_no, qty')
      .eq('season_id', comparisonSeasonId)
      .limit(100000);
    
    for (const row of (cDetails ?? []) as any[]) {
      const sn = row.style_no;
      if (!sn) continue;
      comparisonStyleQty[sn] = (comparisonStyleQty[sn] || 0) + Number(row.qty || 0);
    }
  }

  // ========== CALCULATE METRICS ==========

  // Current totals
  const totalQty = (salesStats ?? []).reduce((sum: number, r: any) => sum + (Number(r.qty) || 0), 0);
  const uniqueCustomers = new Set((salesStats ?? []).map((r: any) => r.account_no)).size;
  const totalCustomers = (customers ?? []).length;
  const visitRatePercent = totalCustomers > 0 ? Math.round((uniqueCustomers / totalCustomers) * 1000) / 10 : 0;

  // Season stage
  let purchaseStage: 'EARLY' | 'MID' | 'CLOSING' = 'EARLY';
  if (visitRatePercent >= 75) purchaseStage = 'CLOSING';
  else if (visitRatePercent >= 40) purchaseStage = 'MID';

  // Group style details with stock info
  const styleData: Record<string, { 
    qty: number; 
    colors: Set<string>; 
    customers: Set<string>;
    supplier?: string;
    available?: number;
    onOrder?: number;
    lastYearQty?: number;
  }> = {};

  for (const row of (styleDetails ?? []) as any[]) {
    const sn = row.style_no;
    if (!sn) continue;
    if (!styleData[sn]) {
      const styleInfo = (stylesInfo ?? []).find((s: any) => s.style_no === sn);
      styleData[sn] = { 
        qty: 0, 
        colors: new Set(), 
        customers: new Set(),
        supplier: styleInfo?.supplier,
        lastYearQty: comparisonStyleQty[sn] || 0
      };
    }
    styleData[sn].qty += Number(row.qty) || 0;
    if (row.color) styleData[sn].colors.add(row.color);
    if (row.account_no) styleData[sn].customers.add(row.account_no);
  }

  // Add stock info
  for (const stockRow of stockData) {
    const sn = stockRow.style_no;
    if (!styleData[sn]) continue;
    
    const values = stockRow.values || [];
    const total = values.reduce((s: number, v: number) => s + (Number(v) || 0), 0);
    
    if (stockRow.section === 'Available' || stockRow.section === 'Stock') {
      styleData[sn].available = (styleData[sn].available || 0) + total;
    }
    if (stockRow.section?.includes('Purchase') || stockRow.section?.includes('PO')) {
      styleData[sn].onOrder = (styleData[sn].onOrder || 0) + total;
    }
  }

  // Group by supplier
  const bySupplier: Record<string, any[]> = {};
  for (const [styleNo, data] of Object.entries(styleData)) {
    const supplier = data.supplier || 'Unknown';
    if (!bySupplier[supplier]) bySupplier[supplier] = [];
    bySupplier[supplier].push({
      style_no: styleNo,
      qty_sold: data.qty,
      colors_count: data.colors.size,
      customer_count: data.customers.size,
      available_stock: data.available || 0,
      on_order: data.onOrder || 0,
      remaining_need: Math.max(0, data.qty - (data.onOrder || 0)),
      last_year_qty: data.lastYearQty || 0
    });
  }

  // Supplier summary
  const supplierSummary = Object.entries(bySupplier).map(([name, styles]) => {
    const supplierInfo = (suppliers ?? []).find((s: any) => s.name === name);
    return {
      name,
      moq: supplierInfo?.moq || 0,
      lead_time_days: supplierInfo?.lead_time_days || 0,
      styles_count: styles.length,
      total_sold: styles.reduce((s, st) => s + st.qty_sold, 0),
      total_remaining_need: styles.reduce((s, st) => s + st.remaining_need, 0),
      styles: styles.sort((a, b) => b.qty_sold - a.qty_sold).slice(0, 30) // Top 30 per supplier
    };
  }).sort((a, b) => b.total_sold - a.total_sold);

  // Build context object
  const purchaseRoundContext = {
    round_number: nextRoundNumber,
    purchase_stage: purchaseStage,
    visit_rate_percent: visitRatePercent,
    stage_rules: {
      EARLY: 'Add 10-30% buffer to remaining need',
      MID: 'Cover remaining need exactly or +10%',
      CLOSING: 'Exact match only, skip if below MOQ'
    }
  };

  const currentSeasonData = {
    season: {
      id: currentSeason?.id,
      name: currentSeason?.name,
      year: currentSeason?.year
    },
    totals: {
      qty_sold: totalQty,
      unique_customers: uniqueCustomers,
      unique_styles: styleNos.length
    },
    customer_coverage: {
      visited: uniqueCustomers,
      total: totalCustomers,
      visit_rate_percent: visitRatePercent
    }
  };

  const stockStatus = {
    summary: {
      total_styles_tracked: Object.keys(styleData).length,
      styles_with_stock_data: stockData.length
    },
    by_supplier: supplierSummary
  };

  return {
    purchaseRoundContext,
    currentSeasonData,
    stockStatus,
    supplierData: supplierSummary,
    comparisonData: comparisonSeasonId ? { has_data: Object.keys(comparisonStyleQty).length > 0 } : null,
    nextRoundNumber
  };
}

export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: PurchaseRoundRequest = await req.json();

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    // Get season IDs
    let seasonId = body.seasonId;
    let comparisonSeasonId = body.comparisonSeasonId;

    if (!seasonId) {
      const { data: setting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'season_compare')
        .maybeSingle();
      seasonId = (setting?.value as any)?.s1;
      comparisonSeasonId = (setting?.value as any)?.s2;
    }

    if (!seasonId) {
      return NextResponse.json({ error: 'No season configured' }, { status: 400 });
    }

    console.log('[Purchase Round] Starting for season:', seasonId);

    // Build context
    const { purchaseRoundContext, currentSeasonData, stockStatus, supplierData, comparisonData, nextRoundNumber } = 
      await buildPurchaseRoundContext(supabase, seasonId, comparisonSeasonId || null);

    // Get prompt
    const promptConfig = await getPromptConfig('purchase_round_v1');

    // Interpolate prompt
    const userMessage = interpolatePrompt(`
## Purchase Round Context
{{purchase_round_context}}

## Current Season Data
{{current_season_data}}

## Stock Status
{{stock_status}}

## Supplier Information
{{supplier_data}}

## Comparison Season (Last Year)
{{comparison_season_data}}
`, {
      purchase_round_context: JSON.stringify(purchaseRoundContext, null, 2),
      current_season_data: JSON.stringify(currentSeasonData, null, 2),
      stock_status: JSON.stringify(stockStatus, null, 2),
      supplier_data: JSON.stringify(supplierData, null, 2),
      comparison_season_data: comparisonData ? JSON.stringify(comparisonData, null, 2) : 'No comparison data available'
    });

    console.log('[Purchase Round] Calling', promptConfig.model);

    // Call OpenAI
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: promptConfig.model,
      temperature: promptConfig.temperature,
      max_tokens: promptConfig.maxTokens,
      messages: [
        { role: 'system', content: promptConfig.content },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' }
    });

    const rawResponse = completion.choices[0]?.message?.content || '{}';
    let aiOutput: any = {};
    try {
      aiOutput = JSON.parse(rawResponse);
    } catch {
      aiOutput = { error: 'Failed to parse AI response' };
    }

    const durationMs = Date.now() - startTime;

    // Create ai_runs entry
    const { data: aiRun } = await supabase
      .from('ai_runs')
      .insert({
        prompt_key: 'purchase_round_v1',
        prompt_version: promptConfig.version,
        prompt_content: promptConfig.content,
        model: promptConfig.model,
        temperature: promptConfig.temperature,
        max_tokens: promptConfig.maxTokens,
        input_snapshot: { seasonId, comparisonSeasonId, purchaseRoundContext, stockStatus },
        output: aiOutput,
        raw_response: rawResponse,
        usage: completion.usage,
        status: 'completed',
        duration_ms: durationMs,
        completed_at: new Date().toISOString()
      })
      .select('id')
      .single();

    // Create ai_season_analyses entry
    const { data: analysis, error: analysisError } = await supabase
      .from('ai_season_analyses')
      .insert({
        ai_run_id: aiRun?.id || null,
        season_id: seasonId,
        comparison_season_id: comparisonSeasonId || null,
        analysis_type: 'purchase_round',
        analysis_date: new Date().toISOString().split('T')[0],
        metrics: currentSeasonData,
        executive_summary: aiOutput.executive_summary || null,
        salesperson_reports: {},
        style_insights: aiOutput.style_insights || {},
        warnings: aiOutput.warnings || [],
        recommendations: [],
        purchase_round_number: nextRoundNumber,
        purchase_recommendations: aiOutput.purchase_recommendations || null
      })
      .select('id')
      .single();

    if (analysisError) {
      return NextResponse.json({ error: 'Failed to save analysis', detail: analysisError.message }, { status: 500 });
    }

    console.log('[Purchase Round] Completed in', durationMs, 'ms. Round #', nextRoundNumber);

    return NextResponse.json({
      success: true,
      analysisId: analysis?.id,
      purchaseRoundNumber: nextRoundNumber,
      durationMs,
      output: aiOutput
    });

  } catch (e: any) {
    console.error('[Purchase Round] Error:', e);
    return NextResponse.json({ error: e?.message || 'Purchase round failed' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to start a purchase round' }, { status: 405 });
}
