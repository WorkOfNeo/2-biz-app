import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { runPurchaseRoundEngine } from './purchaseRoundEngine.js';

type LogFn = (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;

// Format numbers in Danish style (1.000,50)
function formatDK(n: number, decimals = 0): string {
  return new Intl.NumberFormat('da-DK', { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  }).format(n);
}

interface AiAnalysisPayload {
  analysisType: 'daily' | 'purchase_round';
  seasonId: string;
  comparisonSeasonId?: string;
  purchaseRoundNumber?: number;
  purchaseRunId?: string; // Link to purchase_ai_runs record
  sendEmail?: boolean;
}

// Default prompts (fallback if not in DB)
const DEFAULT_PROMPTS = {
  daily_analysis_v1: {
    version: 7,
    content: `Du er en AI-analytiker for 2-BIZ, en dansk mode-grossistvirksomhed der sporer sæsonens salgsfremgang.

Analyser de leverede data og svar med JSON på DANSK.

## OUTPUT FORMAT (valid JSON, ingen markdown):
{
  "executive_summary": {
    "headline": "Kort overskrift der opsummerer status (max 10 ord)",
    "bullets": [
      "📦 Stk solgt: X.XXX total | +Y.YYY siden sidst | Z% index",
      "💰 Omsætning: X.XXX DKK total | +Y.YYY DKK siden sidst | Z% index",
      "👥 Besøgsrate: X% (Y af Z kunder) | +N siden sidst",
      "🔥 Top styles: STYLENAME1 (styleNo) X stk, STYLENAME2 (styleNo) Y stk",
      "👤 Sælgere: X aktive af Y total | bedste: NAVN (index Z%)"
    ]
  },
  "progress_note": "En sætning om hvad der ændrede sig siden sidste analyse",
  "salesperson_summaries": {
    "salesperson_id": { "note": "Kort observation om deres fremgang på dansk" }
  }
}

## TAL FORMAT:
- Brug ALTID dansk talformat med punktum som tusindtalsseparator: 1.234 (ikke 1234 eller 1,234)
- Brug de FORMATEREDE tal fra data (felter der ender på _formatted)

## INDEX - BRUG DISSE TAL:
Brug data fra "index_for_visited_customers" sektionen:
- qty_index_percent = index for stk solgt (kun besøgte kunders sidste sæson som baseline)
- revenue_index_percent = index for omsætning (kun besøgte kunders sidste sæson som baseline)
- Hvis null = ingen data fra sidste sæson for disse kunder

## BULLET FORMAT REGLER:
1. 📦 Stk solgt: [total_formatted] | [+/- stk siden sidst] | [qty_index_percent]% index
2. 💰 Omsætning: [revenue_formatted] DKK | [+/- DKK siden sidst] | [revenue_index_percent]% index
3. 👥 Besøgsrate: [procent] ([besøgte] af [total]) | [+/- kunder siden sidst]
4. 🔥 Top styles: Nævn top 2-3 styles med NAVN (styleNo) og antal
5. 👤 Sælgere: Antal aktive, bedste performer med navn og index

## VIGTIGE REGLER:
- ALLE tekster på DANSK
- Brug | som separator i bullets for nem scanning
- Hvis "changes_since_last" mangler, skriv "første analyse"
- Inkluder ALTID style_name før style_no i parentes
- INGEN advarsler eller anbefalinger - kun fakta og status`,
    model: 'gpt-5-mini',
    temperature: 1, // GPT-5 only supports default
    maxTokens: 4096,
  },
  purchase_round_v1: {
    version: 2,
    content: `Du er en AI-indkøbsanalytiker for 2-BIZ, en dansk mode-grossistvirksomhed.
Dette er en INDKØBSRUNDE - vi træffer faktiske købsbeslutninger for lageropfyldning.

Analyser de leverede data og giv indkøbsanbefalinger på DANSK i JSON format:

## OUTPUT FORMAT:
{
  "executive_summary": {
    "headline": "Kort overskrift for indkøbsrunden",
    "bullets": [
      "📦 Punkt om total anbefalet mængde",
      "🏭 Punkt om leverandører",
      "📊 Punkt om indkøbs-stadie baseret på besøgsrate",
      "⚠️ Eventuelle advarsler"
    ]
  },
  "purchase_recommendations": [{ "supplier": "...", "styles": [...], "total_qty": 0, "priority": "high/medium/low" }],
  "style_insights": { "urgent_restock": [...], "watch_list": [...], "skip": [...] },
  "warnings": ["Advarsler på dansk"],
  "recommendations": ["Anbefalinger på dansk"],
  "total_recommended_units": 0
}

## INDKØBS-REGLER baseret på besøgsrate:
- EARLY (< 40% besøgt): Tilføj 10-30% buffer til resterende behov
- MID (40-75% besøgt): Dæk resterende behov præcist eller +10%
- CLOSING (> 75% besøgt): Kun præcis match, spring over hvis under MOQ`,
    model: 'gpt-5',
    temperature: 1, // GPT-5 only supports default
    maxTokens: 16384,
  }
};

// Helper to fetch all rows with pagination
async function fetchAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  filters: Record<string, any>,
  options?: { cap?: number; logFn?: (msg: string, data?: any) => Promise<void> }
): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const cap = options?.cap ?? 100000;
  let from = 0;
  const allRows: T[] = [];

  while (from < cap) {
    if (options?.logFn) {
      await options.logFn(`FETCH:${table}_page`, { from, pageSize: PAGE_SIZE, totalSoFar: allRows.length });
    }
    
    let query = supabase.from(table).select(select);
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
    query = query.range(from, from + PAGE_SIZE - 1);
    
    const { data, error } = await query;
    if (error) {
      if (options?.logFn) {
        await options.logFn(`FETCH:${table}_error`, { error: error.message, from });
      }
      throw error;
    }
    
    const batch = (data ?? []) as T[];
    allRows.push(...batch);
    
    if (options?.logFn) {
      await options.logFn(`FETCH:${table}_batch`, { batchSize: batch.length, total: allRows.length });
    }
    
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  
  return allRows;
}

export async function runAiAnalysis(
  supabase: SupabaseClient,
  payload: AiAnalysisPayload,
  log: LogFn
): Promise<{ success: boolean; analysisId?: string; error?: string }> {
  const startTime = Date.now();
  const { analysisType, seasonId, comparisonSeasonId, purchaseRoundNumber, sendEmail } = payload;

  try {
    await log('info', 'start', { analysisType, seasonId, comparisonSeasonId });

    // ========== PURCHASE ROUND: Use deterministic engine ==========
    if (analysisType === 'purchase_round' && payload.purchaseRunId) {
      await log('info', 'using_purchase_round_engine', { purchaseRunId: payload.purchaseRunId });
      
      const result = await runPurchaseRoundEngine(supabase, {
        seasonId,
        comparisonSeasonId,
        purchaseRoundNumber,
        purchaseRunId: payload.purchaseRunId
      }, log);

      if (!result.success) {
        // Update purchase run status to failed
        await supabase
          .from('purchase_ai_runs')
          .update({ status: 'cancelled' })
          .eq('id', payload.purchaseRunId);
        
        return { success: false, error: result.error };
      }

      // Enqueue PDF export job if needed
      const { data: pdfJob } = await supabase
        .from('jobs')
        .insert({
          type: 'export_ai_analysis',
          payload: { purchaseRunId: payload.purchaseRunId },
          status: 'queued',
          queue: 'default',
          priority: 50
        })
        .select('id')
        .single();

      if (pdfJob) {
        await log('info', 'pdf_export_enqueued', { jobId: pdfJob.id });
      }

      return { success: true };
    }

    // ========== DAILY ANALYSIS: Use LLM-based approach ==========

    // Get OpenAI API key
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    // ========== STEP 1: Fetch Season Info ==========
    await log('info', 'fetching_seasons');
    
    const { data: currentSeason } = await supabase
      .from('seasons')
      .select('id, name, year, created_at, is_current, is_frozen')
      .eq('id', seasonId)
      .single();

    if (!currentSeason) {
      throw new Error(`Season not found: ${seasonId}`);
    }

    let comparisonSeason: any = null;
    if (comparisonSeasonId) {
      const { data } = await supabase
        .from('seasons')
        .select('id, name, year, created_at')
        .eq('id', comparisonSeasonId)
        .single();
      comparisonSeason = data;
    }

    await log('info', 'seasons_loaded', { 
      current: currentSeason.name, 
      comparison: comparisonSeason?.name || 'none' 
    });

    // ========== STEP 2: Fetch Sales Stats ==========
    await log('info', 'fetching_sales_stats');
    
    const logProgress = async (msg: string, data?: any) => log('progress', msg, data);
    
    const salesStats = await fetchAllRows<any>(
      supabase,
      'sales_stats',
      'account_no, customer_name, qty, price, salesperson_id',
      { season_id: seasonId },
      { cap: 50000, logFn: logProgress }
    );
    
    await log('info', 'sales_stats_loaded', { count: salesStats.length });

    // ========== STEP 3: Fetch Style Details ==========
    await log('info', 'fetching_style_details');
    
    const styleDetails = await fetchAllRows<any>(
      supabase,
      'sales_style_details_rows',
      'style_no, style_name, color, size, qty, account_no',
      { season_id: seasonId },
      { cap: 100000, logFn: logProgress }
    );
    
    await log('info', 'style_details_loaded', { count: styleDetails.length });

    // ========== STEP 4: Fetch Customers ==========
    await log('info', 'fetching_customers');
    
    const customers = await fetchAllRows<any>(
      supabase,
      'customers',
      'customer_id, company, stats_display_name, country, salesperson_id',
      {},
      { cap: 10000, logFn: logProgress }
    );
    
    await log('info', 'customers_loaded', { count: customers.length });

    // ========== STEP 5: Fetch Salespersons ==========
    await log('info', 'fetching_salespersons');
    
    const { data: salespersons } = await supabase
      .from('salespersons')
      .select('id, name, email')
      .limit(100);

    await log('info', 'salespersons_loaded', { count: salespersons?.length || 0 });

    // ========== STEP 6: Fetch Stock Data ==========
    await log('info', 'fetching_stock_data');
    
    const styleNos = Array.from(new Set(styleDetails.map((r: any) => r.style_no).filter(Boolean)));
    let stockData: any[] = [];
    
    if (styleNos.length > 0) {
      const styleBatch = styleNos.slice(0, 1000);
      let from = 0;
      while (from < 50000) {
        const { data } = await supabase
          .from('style_stock')
          .select('style_no, color, section, row_label, sizes, values')
          .in('style_no', styleBatch)
          .range(from, from + 1000 - 1);
        
        const batch = data ?? [];
        stockData.push(...batch);
        if (batch.length < 1000) break;
        from += 1000;
      }
    }
    
    await log('info', 'stock_data_loaded', { count: stockData.length });

    // ========== STEP 7: Fetch Comparison Data ==========
    let comparisonStats: any[] = [];
    let comparisonStyleDetails: any[] = [];
    
    if (comparisonSeasonId) {
      await log('info', 'fetching_comparison_data');
      
      comparisonStats = await fetchAllRows<any>(
        supabase,
        'sales_stats',
        'account_no, qty, price, salesperson_id',
        { season_id: comparisonSeasonId },
        { cap: 50000, logFn: logProgress }
      );

      comparisonStyleDetails = await fetchAllRows<any>(
        supabase,
        'sales_style_details_rows',
        'style_no, color, qty',
        { season_id: comparisonSeasonId },
        { cap: 100000, logFn: logProgress }
      );
      
      await log('info', 'comparison_data_loaded', { 
        stats: comparisonStats.length, 
        styles: comparisonStyleDetails.length 
      });
    }

    // ========== STEP 7b: Fetch Last Analysis for Progress Comparison ==========
    await log('info', 'fetching_last_analysis');
    
    const { data: lastAnalysis } = await supabase
      .from('ai_season_analyses')
      .select('id, analysis_date, metrics, created_at')
      .eq('season_id', seasonId)
      .eq('analysis_type', 'daily')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    await log('info', 'last_analysis_loaded', { 
      hasLast: !!lastAnalysis,
      lastDate: lastAnalysis?.analysis_date 
    });

    // ========== STEP 8: Calculate Metrics ==========
    await log('info', 'calculating_metrics');

    // Current season totals
    const totalQty = salesStats.reduce((sum: number, r: any) => sum + (Number(r.qty) || 0), 0);
    const totalRevenue = salesStats.reduce((sum: number, r: any) => sum + (Number(r.price) || 0), 0);
    const uniqueCustomers = new Set(salesStats.map((r: any) => r.account_no)).size;
    const uniqueStyles = new Set(styleDetails.map((r: any) => r.style_no)).size;

    // Customer coverage
    const totalCustomers = customers.length;
    const visitedCustomers = uniqueCustomers;
    const visitRatePercent = totalCustomers > 0 ? Math.round((visitedCustomers / totalCustomers) * 1000) / 10 : 0;

    // Days active
    const seasonStart = currentSeason.created_at ? new Date(currentSeason.created_at) : new Date();
    const daysActive = Math.max(1, Math.floor((Date.now() - seasonStart.getTime()) / (1000 * 60 * 60 * 24)));

    // Velocity
    const avgDailyQty = Math.round(totalQty / daysActive);
    const avgDailyRevenue = Math.round(totalRevenue / daysActive);
    const projectedTotal = avgDailyQty * 42; // 6 weeks

    // Build customer country map and salesperson map
    const customerCountryMap = new Map<string, string>();
    const customerSalespersonMap = new Map<string, string>();
    for (const c of customers) {
      if (c.customer_id) {
        customerCountryMap.set(c.customer_id, c.country || 'Unknown');
        customerSalespersonMap.set(c.customer_id, c.salesperson_id || 'unknown');
      }
    }

    // Build comparison data: what each customer bought last season
    const lastSeasonByCustomer = new Map<string, { qty: number; revenue: number }>();
    for (const row of comparisonStats) {
      const acc = row.account_no;
      if (!acc) continue;
      const existing = lastSeasonByCustomer.get(acc) || { qty: 0, revenue: 0 };
      existing.qty += Number(row.qty) || 0;
      existing.revenue += Number(row.price) || 0;
      lastSeasonByCustomer.set(acc, existing);
    }

    // Group current season by salesperson with per-customer breakdown
    const bySalesperson: Record<string, { 
      id: string; 
      name: string; 
      qty: number; 
      revenue: number; 
      customers: Set<string>;
      customerData: Map<string, { qty: number; revenue: number }>;
    }> = {};
    
    for (const row of salesStats) {
      const spId = row.salesperson_id || 'unknown';
      if (!bySalesperson[spId]) {
        const sp = (salespersons ?? []).find((s: any) => s.id === spId);
        bySalesperson[spId] = { 
          id: spId, 
          name: sp?.name || 'Unknown', 
          qty: 0, 
          revenue: 0, 
          customers: new Set(),
          customerData: new Map()
        };
      }
      bySalesperson[spId].qty += Number(row.qty) || 0;
      bySalesperson[spId].revenue += Number(row.price) || 0;
      if (row.account_no) {
        bySalesperson[spId].customers.add(row.account_no);
        const custData = bySalesperson[spId].customerData.get(row.account_no) || { qty: 0, revenue: 0 };
        custData.qty += Number(row.qty) || 0;
        custData.revenue += Number(row.price) || 0;
        bySalesperson[spId].customerData.set(row.account_no, custData);
      }
    }

    const customersBySalesperson: Record<string, number> = {};
    for (const c of customers) {
      const spId = c.salesperson_id || 'unknown';
      customersBySalesperson[spId] = (customersBySalesperson[spId] || 0) + 1;
    }

    // Calculate index for each salesperson (visited customers: this season vs last season)
    const salespersonData = Object.values(bySalesperson).map(sp => {
      const totalCustomers = customersBySalesperson[sp.id] || 0;
      
      // Calculate index: sum of this season data for visited customers / sum of last season data for same customers
      let thisSeasonQtyForVisited = 0;
      let lastSeasonQtyForVisited = 0;
      let thisSeasonRevenueForVisited = 0;
      let lastSeasonRevenueForVisited = 0;
      
      for (const [custId, custData] of sp.customerData) {
        thisSeasonQtyForVisited += custData.qty;
        thisSeasonRevenueForVisited += custData.revenue;
        const lastSeason = lastSeasonByCustomer.get(custId);
        if (lastSeason) {
          lastSeasonQtyForVisited += lastSeason.qty;
          lastSeasonRevenueForVisited += lastSeason.revenue;
        }
      }
      
      // Index: if last season was 100%, what is this season?
      // If no last season data, index is null
      const qtyIndex = lastSeasonQtyForVisited > 0 
        ? Math.round((thisSeasonQtyForVisited / lastSeasonQtyForVisited) * 1000) / 10 
        : null;
      const revenueIndex = lastSeasonRevenueForVisited > 0
        ? Math.round((thisSeasonRevenueForVisited / lastSeasonRevenueForVisited) * 1000) / 10
        : null;
      
      return {
        id: sp.id,
        name: sp.name,
        status: sp.qty > 0 ? 'active' : 'not_started',
        metrics: {
          qty_sold: sp.qty,
          revenue: Math.round(sp.revenue * 100) / 100,
          customers_visited: sp.customers.size,
          customers_total: totalCustomers,
          visit_rate_percent: totalCustomers > 0 
            ? Math.round((sp.customers.size / totalCustomers) * 1000) / 10 
            : 0,
          qty_index: qtyIndex, // null if no comparison data, otherwise percentage (e.g., 85 means 85% of last season)
          revenue_index: revenueIndex,
          index: qtyIndex // Keep for backward compatibility
        }
      };
    }).sort((a, b) => b.metrics.qty_sold - a.metrics.qty_sold);

    // Add salespersons with 0 sales
    for (const sp of (salespersons ?? [])) {
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
            visit_rate_percent: 0,
            qty_index: null,
            revenue_index: null,
            index: null
          }
        });
      }
    }

    // Group by country
    const byCountry: Record<string, { qty: number; revenue: number; customers: Set<string> }> = {};
    for (const row of salesStats) {
      const country = customerCountryMap.get(row.account_no) || 'Unknown';
      if (!byCountry[country]) byCountry[country] = { qty: 0, revenue: 0, customers: new Set() };
      byCountry[country].qty += Number(row.qty) || 0;
      byCountry[country].revenue += Number(row.price) || 0;
      if (row.account_no) byCountry[country].customers.add(row.account_no);
    }
    const countryData = Object.entries(byCountry)
      .map(([country, data]) => ({ country, qty: data.qty, revenue: data.revenue, customer_count: data.customers.size }))
      .sort((a, b) => b.qty - a.qty);

    // Group style details
    const styleQty: Record<string, { qty: number; colors: Set<string>; customers: Set<string>; style_name: string }> = {};
    for (const row of styleDetails) {
      const sn = row.style_no;
      if (!sn) continue;
      if (!styleQty[sn]) styleQty[sn] = { qty: 0, colors: new Set(), customers: new Set(), style_name: row.style_name || '' };
      styleQty[sn].qty += Number(row.qty) || 0;
      if (row.color) styleQty[sn].colors.add(row.color);
      if (row.account_no) styleQty[sn].customers.add(row.account_no);
      // Keep the first non-empty style_name we encounter
      if (!styleQty[sn].style_name && row.style_name) styleQty[sn].style_name = row.style_name;
    }

    const topStyles = Object.entries(styleQty)
      .map(([style_no, data]) => ({
        style_no,
        style_name: data.style_name || style_no, // Fallback to style_no if no name
        total_qty: data.qty,
        total_qty_formatted: formatDK(data.qty),
        colors_count: data.colors.size,
        customer_count: data.customers.size
      }))
      .sort((a, b) => b.total_qty - a.total_qty)
      .slice(0, 20);

    // Calculate overall index based on VISITED CUSTOMERS ONLY
    // This is the key metric: how are we doing vs last year for the customers we've actually visited?
    let visitedCustomersIndex = {
      this_season_qty: 0,
      this_season_revenue: 0,
      last_season_qty: 0,
      last_season_revenue: 0,
      qty_index: null as number | null,
      revenue_index: null as number | null,
    };
    
    // Get all unique customers visited this season
    const visitedCustomerIds = new Set(salesStats.map((r: any) => r.account_no).filter(Boolean));
    
    // Sum up this season totals for visited customers
    for (const row of salesStats) {
      if (row.account_no && visitedCustomerIds.has(row.account_no)) {
        visitedCustomersIndex.this_season_qty += Number(row.qty) || 0;
        visitedCustomersIndex.this_season_revenue += Number(row.price) || 0;
      }
    }
    
    // Sum up LAST season totals for those same visited customers
    for (const custId of visitedCustomerIds) {
      const lastSeason = lastSeasonByCustomer.get(custId);
      if (lastSeason) {
        visitedCustomersIndex.last_season_qty += lastSeason.qty;
        visitedCustomersIndex.last_season_revenue += lastSeason.revenue;
      }
    }
    
    // Calculate indexes
    if (visitedCustomersIndex.last_season_qty > 0) {
      visitedCustomersIndex.qty_index = Math.round(
        (visitedCustomersIndex.this_season_qty / visitedCustomersIndex.last_season_qty) * 1000
      ) / 10;
    }
    if (visitedCustomersIndex.last_season_revenue > 0) {
      visitedCustomersIndex.revenue_index = Math.round(
        (visitedCustomersIndex.this_season_revenue / visitedCustomersIndex.last_season_revenue) * 1000
      ) / 10;
    }

    // Comparison totals (full season - for reference only)
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

    await log('info', 'metrics_calculated', { 
      totalQty, 
      totalRevenue, 
      uniqueCustomers, 
      visitRatePercent 
    });

    // Calculate changes since last analysis
    let changesSinceLast: any = null;
    if (lastAnalysis?.metrics) {
      const lastMetrics = lastAnalysis.metrics as any;
      const lastTotals = lastMetrics.totals || {};
      const lastCoverage = lastMetrics.customer_coverage || {};
      
      const qtyChange = totalQty - (lastTotals.qty_sold || 0);
      const revenueChange = Math.round((totalRevenue - (lastTotals.revenue || 0)) * 100) / 100;
      changesSinceLast = {
        last_analysis_date: lastAnalysis.analysis_date,
        qty_change: qtyChange,
        qty_change_formatted: (qtyChange >= 0 ? '+' : '') + formatDK(qtyChange),
        revenue_change: revenueChange,
        revenue_change_formatted: (revenueChange >= 0 ? '+' : '') + formatDK(Math.round(revenueChange)),
        customers_change: uniqueCustomers - (lastCoverage.visited_customers || 0),
        visit_rate_change: Math.round((visitRatePercent - (lastCoverage.visit_rate_percent || 0)) * 10) / 10
      };
    }

    // Build context object with Danish-formatted numbers for clarity
    const currentSeasonData = {
      current_season: {
        id: currentSeason.id,
        name: currentSeason.name,
        year: currentSeason.year,
        days_active: daysActive,
        started_at: currentSeason.created_at
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
        qty_sold_formatted: formatDK(totalQty),
        revenue: Math.round(totalRevenue * 100) / 100,
        revenue_formatted: formatDK(Math.round(totalRevenue)),
        unique_customers: uniqueCustomers,
        unique_styles: uniqueStyles
      },
      // INDEX DATA: Based on VISITED CUSTOMERS ONLY
      index_for_visited_customers: {
        this_season_qty: visitedCustomersIndex.this_season_qty,
        this_season_qty_formatted: formatDK(visitedCustomersIndex.this_season_qty),
        this_season_revenue: Math.round(visitedCustomersIndex.this_season_revenue),
        this_season_revenue_formatted: formatDK(Math.round(visitedCustomersIndex.this_season_revenue)),
        last_season_qty_for_these_customers: visitedCustomersIndex.last_season_qty,
        last_season_qty_formatted: formatDK(visitedCustomersIndex.last_season_qty),
        last_season_revenue_for_these_customers: Math.round(visitedCustomersIndex.last_season_revenue),
        last_season_revenue_formatted: formatDK(Math.round(visitedCustomersIndex.last_season_revenue)),
        qty_index_percent: visitedCustomersIndex.qty_index,
        revenue_index_percent: visitedCustomersIndex.revenue_index,
        explanation: 'Index = (denne sæson / sidste sæson for SAMME besøgte kunder) * 100'
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
      changes_since_last: changesSinceLast,
      salesperson_table: salespersonData.map(sp => ({
        salesperson: sp.name,
        visited_customers: sp.metrics.customers_visited,
        qty: sp.metrics.qty_sold,
        qty_formatted: formatDK(sp.metrics.qty_sold),
        price: sp.metrics.revenue,
        price_formatted: formatDK(Math.round(sp.metrics.revenue)),
        index: sp.metrics.index,
        qty_index: sp.metrics.qty_index,
        revenue_index: sp.metrics.revenue_index
      })),
      salespersons: salespersonData,
      by_country: countryData,
      top_styles: topStyles
    };

    // ========== STEP 9: Call OpenAI ==========
    await log('info', 'calling_openai');

    const promptKey = analysisType === 'purchase_round' ? 'purchase_round_v1' : 'daily_analysis_v1';
    const promptConfig = DEFAULT_PROMPTS[promptKey];
    
    const systemPrompt = promptConfig.content;
    const userMessage = `
## Current Season Data
${JSON.stringify(currentSeasonData, null, 2)}

## Comparison Season (Last Year)
${currentSeasonData.comparison_season 
  ? JSON.stringify(currentSeasonData.comparison_season, null, 2) 
  : 'First season - no comparison available'}
`;

    await log('info', 'openai_request', { 
      model: promptConfig.model, 
      contextLength: userMessage.length 
    });

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const isGpt5 = promptConfig.model.startsWith('gpt-5');
    
    const completion = await openai.chat.completions.create({
      model: promptConfig.model,
      // GPT-5 only supports temperature=1 (default), so omit
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
      await log('error', 'parse_error', { error: String(e), raw: rawResponse.slice(0, 500) });
      aiOutput = { error: 'Failed to parse AI response', raw: rawResponse.slice(0, 500) };
    }

    const durationMs = Date.now() - startTime;
    await log('info', 'openai_complete', { 
      durationMs, 
      usage: completion.usage 
    });

    // ========== STEP 10: Save Results ==========
    await log('info', 'saving_results');

    // Create ai_runs entry
    const { data: aiRun, error: runError } = await supabase
      .from('ai_runs')
      .insert({
        prompt_key: promptKey,
        prompt_version: promptConfig.version,
        prompt_content: systemPrompt,
        model: promptConfig.model,
        temperature: promptConfig.temperature,
        max_tokens: promptConfig.maxTokens,
        input_snapshot: { seasonId, comparisonSeasonId, metrics: currentSeasonData },
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
      await log('error', 'ai_run_insert_error', { error: runError.message });
    }

    // Create ai_season_analyses entry
    // Add prompt info to metrics for frontend display
    const metricsWithPromptInfo = {
      ...currentSeasonData,
      prompt_info: {
        key: promptKey,
        version: promptConfig.version,
        model: promptConfig.model,
      }
    };
    
    const { data: analysis, error: analysisError } = await supabase
      .from('ai_season_analyses')
      .insert({
        ai_run_id: aiRun?.id || null,
        season_id: seasonId,
        comparison_season_id: comparisonSeasonId || null,
        analysis_type: analysisType,
        analysis_date: new Date().toISOString().split('T')[0],
        metrics: metricsWithPromptInfo,
        executive_summary: aiOutput.executive_summary || null,
        salesperson_reports: aiOutput.salesperson_reports || {},
        style_insights: aiOutput.style_insights || {},
        warnings: aiOutput.warnings || [],
        recommendations: aiOutput.recommendations || [],
        purchase_round_number: purchaseRoundNumber || null,
        purchase_recommendations: aiOutput.purchase_recommendations || null
      })
      .select('id')
      .single();

    if (analysisError) {
      throw new Error(`Failed to save analysis: ${analysisError.message}`);
    }

    // If this is a purchase round, update the purchase_ai_runs record
    if (analysisType === 'purchase_round' && payload.purchaseRunId) {
      await log('info', 'updating_purchase_run', { purchaseRunId: payload.purchaseRunId });
      
      const { error: purchaseRunError } = await supabase
        .from('purchase_ai_runs')
        .update({
          ai_run_id: aiRun?.id || null,
          status: 'reviewing',
          supplier_suggestions: aiOutput.purchase_recommendations || null,
          run_completed_at: new Date().toISOString(),
          computed_features_snapshot: currentSeasonData,
        })
        .eq('id', payload.purchaseRunId);

      if (purchaseRunError) {
        await log('error', 'purchase_run_update_error', { error: purchaseRunError.message });
      } else {
        await log('info', 'purchase_run_updated', { status: 'reviewing' });
      }
    }

    await log('info', 'complete', { 
      analysisId: analysis?.id, 
      aiRunId: aiRun?.id, 
      purchaseRunId: payload.purchaseRunId,
      durationMs 
    });

    return { success: true, analysisId: analysis?.id };

  } catch (e: any) {
    await log('error', 'failed', { error: e?.message || String(e) });
    return { success: false, error: e?.message || 'Analysis failed' };
  }
}
