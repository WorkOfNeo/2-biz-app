import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig, interpolatePrompt } from '../../../../../lib/ai/prompts';
import { createPseudonymContext } from '../../../../../lib/ai/pseudonymize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60 seconds for AI call

type SizeQtyMap = Record<string, number>; // e.g. { "S": 10, "M": 15, "L": 12 }

type SupplierSuggestion = {
  supplier_name: string;
  supplier_id: string;
  recommendation_summary: string;
  total_units: number;
  total_value_estimate: number;
  lines: Array<{
    style_no: string;
    style_name?: string;
    color: string;
    image_url?: string;
    suggested_qty: number;
    size_quantities?: SizeQtyMap; // AI suggests per size
    available_sizes?: string[]; // sizes seen in sales data
    reasoning: string;
    priority: 'high' | 'medium' | 'low' | 'skip';
    skip_reason?: string | null; // If this line should be skipped
  }>;
  moq_status: 'met' | 'under' | 'n/a';
  notes?: string;
  skip_reason?: string; // If AI recommends skipping this supplier
};

type AIOutput = {
  suppliers: SupplierSuggestion[];
  overall_summary: string;
  total_units: number;
  warnings: string[];
};

/**
 * Round quantity to "full" purchase numbers
 * - Under 100: round to nearest 25
 * - 100-500: round to nearest 50
 * - Above 500: round to nearest 100
 */
function roundToFullQty(qty: number): number {
  if (qty <= 0) return 0;
  if (qty < 100) {
    return Math.round(qty / 25) * 25;
  } else if (qty <= 500) {
    return Math.round(qty / 50) * 50;
  } else {
    return Math.round(qty / 100) * 100;
  }
}

/**
 * Compress styles data to minimal format for AI input
 * Reduces token usage significantly
 */
function compressStylesForAI(styles: any[]): string {
  // Format: style_no|color|sold|sizes_json
  const lines = styles.map(s => {
    const sizes = s.size_breakdown && Object.keys(s.size_breakdown).length > 0 
      ? JSON.stringify(s.size_breakdown)
      : '';
    return `${s.style_no}|${s.color}|${s.CURRENT_SOLD_QTY || s.total_qty}${sizes ? '|' + sizes : ''}`;
  });
  return lines.join('\n');
}

export async function POST(req: Request) {
  const startTime = Date.now();
  
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { 
      importId,
      seasonId,
      comparisonSeasonId, // Last year's season for YoY comparison
      dateRange,
      topNPerSupplier = 200, // Increased from 50 - need to see all styles!
    } = body as {
      importId: string;
      seasonId?: string;
      comparisonSeasonId?: string;
      dateRange?: { start: string; end: string };
      topNPerSupplier?: number;
    };
    
    if (!importId) {
      return NextResponse.json({ error: 'importId is required' }, { status: 400 });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    console.log('[AI Suggestions] Starting run for import:', importId);

    // Get prompt config
    const promptConfig = await getPromptConfig('purchase_suggestions_v1');

    // Fetch import details
    const { data: importData, error: importError } = await supabase
      .from('purchase_sales_imports')
      .select('*')
      .eq('id', importId)
      .single();

    if (importError || !importData) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 });
    }

    // Fetch aggregated sales data by supplier/style/color (with images)
    // Try the enhanced view first, fall back to basic view
    // IMPORTANT: Override default 1000 row limit!
    let salesSummary: any[] = [];
    const { data: salesWithImages, error: summaryErrorImages } = await supabase
      .from('purchase_sales_summary_with_images')
      .select('*')
      .eq('import_id', importId)
      .limit(50000);  // Override default 1000 limit

    if (summaryErrorImages) {
      console.warn('[AI Suggestions] Could not fetch from purchase_sales_summary_with_images, falling back:', summaryErrorImages.message);
      const { data: salesBasic, error: summaryError } = await supabase
        .from('purchase_sales_summary')
        .select('*')
        .eq('import_id', importId)
        .limit(50000);  // Override default 1000 limit
      
      if (summaryError) {
        console.error('[AI Suggestions] Failed to fetch sales summary:', summaryError);
        return NextResponse.json({ error: 'Failed to fetch sales data' }, { status: 500 });
      }
      salesSummary = salesBasic || [];
    } else {
      salesSummary = salesWithImages || [];
      console.log('[AI Suggestions] Loaded sales summary with images:', salesSummary.length, 'style/color rows');
    }

    // Fetch size breakdown data
    const { data: sizeSummary, error: sizeError } = await supabase
      .from('purchase_sales_size_summary')
      .select('*')
      .eq('import_id', importId)
      .limit(50000);  // Override default 1000 limit

    if (sizeError) {
      console.warn('[AI Suggestions] Could not fetch size summary:', sizeError.message);
    }

    // Build size breakdown lookup: style_no|color -> { size: qty }
    const sizeBreakdownMap: Record<string, { sizes: string[]; sizeQty: SizeQtyMap }> = {};
    for (const row of (sizeSummary || [])) {
      const key = `${row.style_no}|${row.color}`;
      if (!sizeBreakdownMap[key]) {
        sizeBreakdownMap[key] = { sizes: [], sizeQty: {} };
      }
      if (row.size) {
        sizeBreakdownMap[key].sizes.push(row.size);
        sizeBreakdownMap[key].sizeQty[row.size] = Number(row.total_qty) || 0;
      }
    }
    console.log('[AI Suggestions] Size breakdown loaded for', Object.keys(sizeBreakdownMap).length, 'style/color combinations');

    // Fetch customer summary for coverage analysis
    const { data: customerSummary, error: customerError } = await supabase
      .from('purchase_customer_summary')
      .select('*')
      .eq('import_id', importId)
      .limit(50000);  // Override default 1000 limit

    if (customerError) {
      console.error('[AI Suggestions] Failed to fetch customer summary:', customerError);
    }

    // Fetch supplier master data
    const { data: suppliers, error: suppliersError } = await supabase
      .from('suppliers')
      .select('*')
      .eq('active', true);

    if (suppliersError) {
      console.error('[AI Suggestions] Failed to fetch suppliers:', suppliersError);
    }

    // Build supplier name lookup (case-insensitive)
    const knownSupplierNames = new Set<string>();
    const supplierByLowerName = new Map<string, any>();
    for (const s of (suppliers || [])) {
      knownSupplierNames.add(s.name.toLowerCase());
      supplierByLowerName.set(s.name.toLowerCase(), s);
      // Also check external_name for matching
      if (s.external_name) {
        knownSupplierNames.add(s.external_name.toLowerCase());
        supplierByLowerName.set(s.external_name.toLowerCase(), s);
      }
    }

    // Find all unique suppliers from sales data
    const suppliersFromSales = new Set<string>();
    for (const row of (salesSummary || [])) {
      if (row.supplier) {
        suppliersFromSales.add(row.supplier);
      }
    }

    // Detect unlinked suppliers (in sales data but not in suppliers table)
    const unlinkedSuppliers: Array<{ name: string; styleCount: number; totalQty: number }> = [];
    const supplierStats: Record<string, { styleCount: number; totalQty: number }> = {};
    
    for (const row of (salesSummary || [])) {
      const supplierName = row.supplier || 'Unknown';
      if (!supplierStats[supplierName]) {
        supplierStats[supplierName] = { styleCount: 0, totalQty: 0 };
      }
      supplierStats[supplierName].styleCount++;
      supplierStats[supplierName].totalQty += Number(row.total_qty) || 0;
    }

    for (const [name, stats] of Object.entries(supplierStats)) {
      const isKnown = knownSupplierNames.has(name.toLowerCase());
      if (!isKnown && name !== 'Unknown') {
        unlinkedSuppliers.push({
          name,
          styleCount: stats.styleCount,
          totalQty: stats.totalQty,
        });
      }
    }

    // Sort by total qty descending
    unlinkedSuppliers.sort((a, b) => b.totalQty - a.totalQty);

    if (unlinkedSuppliers.length > 0) {
      console.log('[AI Suggestions] UNLINKED SUPPLIERS detected:', unlinkedSuppliers.length);
      console.log('[AI Suggestions] These suppliers have no master data (MOQ, lead time, etc.):');
      for (const s of unlinkedSuppliers) {
        console.log(`  - "${s.name}": ${s.styleCount} styles, ${s.totalQty} pcs`);
      }
    }

    // Fetch season info if provided
    let seasonInfo = null;
    if (seasonId) {
      const { data: season } = await supabase
        .from('seasons')
        .select('id, name, start_date, end_date')
        .eq('id', seasonId)
        .single();
      seasonInfo = season;
    }

    // Fetch ALL styles linked to the selected season (including those with no sales)
    let seasonStyles: Array<{
      style_no: string;
      style_name: string | null;
      color: string;
      supplier: string | null;
      image_url?: string | null;
    }> = [];
    let noSalesStyles: Array<{
      style_no: string;
      style_name: string | null;
      color: string;
      supplier: string | null;
      image_url?: string | null;
    }> = [];

    if (seasonId) {
      try {
        // Get style_colors for this season via style_color_seasons
        const { data: seasonStyleColors, error: sscError } = await supabase
          .from('style_color_seasons')
          .select(`
            style_color_id,
            style_colors!inner (
              id,
              color,
              style_id,
              styles!inner (
                style_no,
                style_name,
                supplier,
                image_url
              )
            )
          `)
          .eq('season_id', seasonId);

        if (sscError) {
          console.warn('[AI Suggestions] Could not fetch season styles:', sscError);
        } else if (seasonStyleColors) {
          // Flatten the nested structure
          for (const row of seasonStyleColors) {
            const sc = row.style_colors as any;
            if (sc && sc.styles) {
              seasonStyles.push({
                style_no: sc.styles.style_no,
                style_name: sc.styles.style_name,
                color: sc.color,
                supplier: sc.styles.supplier,
                image_url: sc.styles.image_url,
              });
            }
          }

          console.log('[AI Suggestions] Found', seasonStyles.length, 'style/colors for season');

          // Build a set of style/color keys that have sales in the CSV
          const salesKeys = new Set<string>();
          for (const row of (salesSummary || [])) {
            salesKeys.add(`${row.style_no}|${row.color}`.toLowerCase());
          }

          // Find styles with NO sales
          noSalesStyles = seasonStyles.filter(s => {
            const key = `${s.style_no}|${s.color}`.toLowerCase();
            return !salesKeys.has(key);
          });

          console.log('[AI Suggestions]', noSalesStyles.length, 'style/colors have no sales yet');
        }
      } catch (e) {
        console.warn('[AI Suggestions] Error fetching season styles:', e);
      }
    }

    // Build aggregated input for AI (grouped by supplier)
    console.log('═══════════════════════════════════════════════════════════');
    console.log('[Supplier Grouping] Starting...');
    console.log('[Supplier Grouping] Sales summary rows:', (salesSummary || []).length);
    
    const salesBySupplier: Record<string, any[]> = {};
    const supplierDebug: Record<string, { rowCount: number; totalQty: number }> = {};
    
    for (const row of (salesSummary || [])) {
      const supplier = row.supplier || 'Unknown';
      if (!salesBySupplier[supplier]) {
        salesBySupplier[supplier] = [];
        supplierDebug[supplier] = { rowCount: 0, totalQty: 0 };
      }
      // Attach size breakdown to each row
      const key = `${row.style_no}|${row.color}`;
      const sizeData = sizeBreakdownMap[key];
      const enrichedRow = {
        ...row,
        sizes: sizeData?.sizes || [],
        size_breakdown: sizeData?.sizeQty || {},
      };
      salesBySupplier[supplier]!.push(enrichedRow);
      supplierDebug[supplier]!.rowCount++;
      supplierDebug[supplier]!.totalQty += Number(row.total_qty) || 0;
    }

    console.log('[Supplier Grouping] Suppliers found in sales data:', Object.keys(salesBySupplier).length);
    for (const [supplier, debug] of Object.entries(supplierDebug)) {
      console.log(`  - "${supplier}": ${debug.rowCount} style/colors, ${debug.totalQty} pcs`);
    }

    // Limit items per supplier to control tokens, but add clear sold qty context
    const limitedSalesBySupplier: Record<string, any[]> = {};
    let totalStylesSent = 0;
    let totalQtySent = 0;
    
    for (const [supplier, items] of Object.entries(salesBySupplier)) {
      // Sort by total_qty descending and take top N
      const sorted = items.sort((a, b) => (b.total_qty || 0) - (a.total_qty || 0));
      const limited = sorted.slice(0, topNPerSupplier);
      
      // Rename fields to be crystal clear for AI
      limitedSalesBySupplier[supplier] = limited.map(item => ({
        style_no: item.style_no,
        style_name: item.style_name,
        color: item.color,
        CURRENT_SOLD_QTY: item.total_qty,  // Renamed for clarity!
        customer_count: item.customer_count,
        countries: item.countries,
        total_amount: item.total_amount,
      }));
      
      totalStylesSent += limited.length;
      totalQtySent += limited.reduce((sum, i) => sum + (i.total_qty || 0), 0);
    }
    
    console.log('[Supplier Grouping] Sending', totalStylesSent, 'styles to AI with', totalQtySent, 'total qty sold');
    console.log('[Supplier Grouping] Limited to top', topNPerSupplier, 'items per supplier');
    console.log('═══════════════════════════════════════════════════════════');

    // Build customer analysis summary WITH PSEUDONYMIZATION for AI
    // Only pseudonymize sales reps (personal names), keep countries (useful for analysis)
    const allSalesReps = [...new Set((customerSummary || []).map(c => c.sales_rep).filter(Boolean))];
    const pseudonymContext = createPseudonymContext(allSalesReps);
    
    console.log('[Privacy] Pseudonymizing', allSalesReps.length, 'sales reps for AI (keeping countries)');
    
    // Build stats with pseudonymized sales reps for AI (countries kept as-is)
    const customerStatsForAI = {
      totalCustomers: new Set((customerSummary || []).map(c => c.customer_ref)).size,
      byCountry: {} as Record<string, number>,  // Countries kept - useful for analysis!
      bySalesRep: {} as Record<string, number>,  // Pseudonymized rep IDs
      topCustomers: (customerSummary || [])
        .sort((a, b) => (b.total_qty || 0) - (a.total_qty || 0))
        .slice(0, 20)
        .map(c => ({
          ref: c.customer_ref,  // Already pseudonymized as C_xxxxx
          country: c.country,   // Keep country - not personal data
          sales_rep: pseudonymContext.salesRepMap.get(c.sales_rep) || 'Rep_Unknown',
          total_qty: c.total_qty,
          style_count: c.style_count,
        })),
    };
    
    // Keep original stats for internal use (not sent to AI)
    const customerStats = {
      totalCustomers: new Set((customerSummary || []).map(c => c.customer_ref)).size,
      byCountry: {} as Record<string, number>,
      bySalesRep: {} as Record<string, number>,
      topCustomers: (customerSummary || [])
        .sort((a, b) => (b.total_qty || 0) - (a.total_qty || 0))
        .slice(0, 20)
        .map(c => ({
          ref: c.customer_ref,
          country: c.country,
          sales_rep: c.sales_rep,
          total_qty: c.total_qty,
          style_count: c.style_count,
        })),
    };

    for (const c of (customerSummary || [])) {
      if (c.country) {
        customerStats.byCountry[c.country] = (customerStats.byCountry[c.country] || 0) + 1;
        customerStatsForAI.byCountry[c.country] = (customerStatsForAI.byCountry[c.country] || 0) + 1;
      }
      if (c.sales_rep) {
        customerStats.bySalesRep[c.sales_rep] = (customerStats.bySalesRep[c.sales_rep] || 0) + 1;
        const pseudoRep = pseudonymContext.salesRepMap.get(c.sales_rep) || 'Rep_Unknown';
        customerStatsForAI.bySalesRep[pseudoRep] = (customerStatsForAI.bySalesRep[pseudoRep] || 0) + 1;
      }
    }

    // Build Year-over-Year comparison if comparison season provided
    let yoyAnalysis: any = null;
    if (comparisonSeasonId) {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('[YoY Analysis] Starting Year-over-Year comparison');
      console.log('[YoY Analysis] Comparison Season ID:', comparisonSeasonId);
      console.log('[YoY Analysis] Current Season ID:', seasonId || 'none');
      
      try {
        // Fetch customer master data (for nulled/permanently_closed status)
        const { data: customersData, error: customersError } = await supabase
          .from('customers')
          .select('id, customer_id, company, nulled, permanently_closed, salesperson_id, country');

        if (customersError) {
          console.error('[YoY Analysis] ERROR fetching customers:', customersError);
        } else {
          console.log('[YoY Analysis] Customer master data loaded:', (customersData || []).length, 'customers');
          const nulledCount = (customersData || []).filter(c => c.nulled).length;
          const permClosedCount = (customersData || []).filter(c => c.permanently_closed).length;
          console.log(`[YoY Analysis] Customer status: ${nulledCount} nulled, ${permClosedCount} permanently closed`);
        }

        const customerMaster = new Map<string, any>();
        for (const c of (customersData || [])) {
          if (c.customer_id) {
            customerMaster.set(c.customer_id.toLowerCase(), c);
          }
          // Also map by company name for fuzzy matching
          if (c.company) {
            customerMaster.set(c.company.toLowerCase(), c);
          }
        }

        // Fetch last season's totals - try season_statistics first, then fallback to sales_stats
        let lastSeasonStats: any[] = [];
        
        const { data: seasonStatsData, error: seasonStatsError } = await supabase
          .from('season_statistics')
          .select('customer_id, qty, amount')
          .eq('season_id', comparisonSeasonId);

        if (seasonStatsError) {
          console.error('[YoY Analysis] ERROR fetching season_statistics:', seasonStatsError);
        } else if ((seasonStatsData || []).length > 0) {
          lastSeasonStats = seasonStatsData || [];
          console.log('[YoY Analysis] Using season_statistics:', lastSeasonStats.length, 'customer records');
        } else {
          // Fallback to sales_stats table
          console.log('[YoY Analysis] No data in season_statistics, trying sales_stats...');
          const { data: salesStatsData, error: salesStatsError } = await supabase
            .from('sales_stats')
            .select('account_no, qty, price')
            .eq('season_id', comparisonSeasonId);
          
          if (salesStatsError) {
            console.error('[YoY Analysis] ERROR fetching sales_stats:', salesStatsError);
          } else if ((salesStatsData || []).length > 0) {
            // Map sales_stats format to expected format
            lastSeasonStats = (salesStatsData || []).map(s => ({
              customer_id: s.account_no,  // Use account_no as customer_id
              qty: s.qty,
              amount: s.price,
            }));
            console.log('[YoY Analysis] Using sales_stats:', lastSeasonStats.length, 'customer records');
          } else {
            console.warn('[YoY Analysis] WARNING: No data found in either table!');
          }
        }
        
        if (lastSeasonStats.length > 0) {
          const totalQty = lastSeasonStats.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
          const totalAmt = lastSeasonStats.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
          console.log(`[YoY Analysis] Last season totals: ${totalQty} pcs, ${totalAmt.toFixed(0)} amount`);
        }

        // Fetch current season's totals (if seasonId provided)
        let currentSeasonStats: any[] = [];
        if (seasonId) {
          const { data, error: currentSeasonError } = await supabase
            .from('season_statistics')
            .select('customer_id, qty, amount')
            .eq('season_id', seasonId);
          
          if (currentSeasonError) {
            console.error('[YoY Analysis] ERROR fetching current season stats:', currentSeasonError);
          } else {
            currentSeasonStats = data || [];
            console.log('[YoY Analysis] Current season stats loaded:', currentSeasonStats.length, 'customer records');
            if (currentSeasonStats.length > 0) {
              const totalQty = currentSeasonStats.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
              const totalAmt = currentSeasonStats.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
              console.log(`[YoY Analysis] Current season (from DB): ${totalQty} pcs, ${totalAmt.toFixed(0)} amount`);
            } else {
              // This is expected - current season data comes from uploaded CSV, not DB
              console.log('[YoY Analysis] No DB data for current season (using uploaded CSV instead)');
            }
          }
        } else {
          console.log('[YoY Analysis] No current season ID provided, skipping current season lookup');
        }

        // Build lookup: customer UUID -> last season totals
        const lastSeasonByCustomerId = new Map<string, { qty: number; amount: number }>();
        for (const s of (lastSeasonStats || [])) {
          lastSeasonByCustomerId.set(s.customer_id, { 
            qty: Number(s.qty) || 0, 
            amount: Number(s.amount) || 0 
          });
        }

        // Build lookup: customer UUID -> current season totals
        const currentSeasonByCustomerId = new Map<string, { qty: number; amount: number }>();
        for (const s of currentSeasonStats) {
          currentSeasonByCustomerId.set(s.customer_id, { 
            qty: Number(s.qty) || 0, 
            amount: Number(s.amount) || 0 
          });
        }

        // Aggregate totals
        let lastSeasonTotalQty = 0;
        let lastSeasonTotalAmount = 0;
        let currentSeasonTotalQty = 0;
        let currentSeasonTotalAmount = 0;
        let customersVisitedThisSeason = 0;
        let customersFromLastSeason = 0;
        let nulledThisYearCount = 0;
        let nulledThisYearLostQty = 0;
        let nulledThisYearLostAmount = 0;
        let permClosedCount = 0;
        let permClosedLostQty = 0;
        let permClosedLostAmount = 0;
        let remainingPotentialQty = 0;
        let remainingPotentialAmount = 0;

        // Get all customers who had activity last season
        const customersUuidsFromDb = new Set<string>();
        for (const c of (customersData || [])) {
          if (c.id) customersUuidsFromDb.add(c.id);
        }

        for (const [customerId, lastYear] of lastSeasonByCustomerId) {
          lastSeasonTotalQty += lastYear.qty;
          lastSeasonTotalAmount += lastYear.amount;
          customersFromLastSeason++;

          // Find customer master record
          let customerRecord: any = null;
          for (const c of (customersData || [])) {
            if (c.id === customerId) {
              customerRecord = c;
              break;
            }
          }

          const currentYear = currentSeasonByCustomerId.get(customerId);
          
          if (currentYear && currentYear.qty > 0) {
            customersVisitedThisSeason++;
            currentSeasonTotalQty += currentYear.qty;
            currentSeasonTotalAmount += currentYear.amount;
          } else {
            // Customer not visited yet this season
            if (customerRecord?.permanently_closed) {
              permClosedCount++;
              permClosedLostQty += lastYear.qty;
              permClosedLostAmount += lastYear.amount;
            } else if (customerRecord?.nulled) {
              nulledThisYearCount++;
              nulledThisYearLostQty += lastYear.qty;
              nulledThisYearLostAmount += lastYear.amount;
            } else {
              // Active customer not yet visited - this is potential
              remainingPotentialQty += lastYear.qty;
              remainingPotentialAmount += lastYear.amount;
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // Build VISITED customers from uploaded CSV (customerSummary)
        // ═══════════════════════════════════════════════════════════════════════
        
        // Build map of customer sales from uploaded CSV
        const uploadedCustomerSales = new Map<string, { qty: number; amount: number }>();
        for (const c of (customerSummary || [])) {
          const ref = c.customer_ref;
          if (!ref) continue;
          const existing = uploadedCustomerSales.get(ref) || { qty: 0, amount: 0 };
          uploadedCustomerSales.set(ref, {
            qty: existing.qty + (Number(c.total_qty) || 0),
            amount: existing.amount + (Number(c.total_amount) || 0),
          });
        }
        
        const uploadedTotalQty = (salesSummary || []).reduce((sum, r) => sum + (Number(r.total_qty) || 0), 0);
        const uploadedTotalAmount = (salesSummary || []).reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);
        const uploadedCustomerCount = uploadedCustomerSales.size;
        
        console.log('[YoY Analysis] Uploaded CSV: qty=', uploadedTotalQty, 'unique customers=', uploadedCustomerCount);
        
        // Now calculate INDEX for VISITED customers only:
        // - Find which uploaded customers also bought last year
        // - Compare: this year qty / those same customers' last year qty
        
        let visitedCustomersLastYearQty = 0;
        let visitedCustomersLastYearAmount = 0;
        let visitedCustomersThisYearQty = 0;
        let visitedCustomersThisYearAmount = 0;
        let matchedCustomerCount = 0;
        
        // We need to match customer_ref (from CSV) to customer_id (in sales_stats)
        // Build reverse lookup: customer company/customer_id → UUID
        const customerRefToId = new Map<string, string>();
        for (const c of (customersData || [])) {
          if (c.company) customerRefToId.set(c.company.toLowerCase().trim(), c.id);
          if (c.customer_id) customerRefToId.set(String(c.customer_id).toLowerCase().trim(), c.id);
        }
        
        for (const [customerRef, thisYearSales] of uploadedCustomerSales) {
          // Try to find this customer in last year's data
          const refLower = customerRef.toLowerCase().trim();
          const customerId = customerRefToId.get(refLower);
          
          if (customerId) {
            const lastYearData = lastSeasonByCustomerId.get(customerId);
            if (lastYearData) {
              // This customer bought BOTH years - count for index
              visitedCustomersLastYearQty += lastYearData.qty;
              visitedCustomersLastYearAmount += lastYearData.amount;
              visitedCustomersThisYearQty += thisYearSales.qty;
              visitedCustomersThisYearAmount += thisYearSales.amount;
              matchedCustomerCount++;
            }
          }
        }
        
        // Calculate index for VISITED customers only
        const visitedCustomersIndex = visitedCustomersLastYearQty > 0 
          ? ((visitedCustomersThisYearQty / visitedCustomersLastYearQty) * 100).toFixed(1)
          : 'N/A';
        
        // Calculate visit rate based on uploaded customers vs last year customers
        const actualVisitRate = customersFromLastSeason > 0 
          ? ((uploadedCustomerCount / customersFromLastSeason) * 100).toFixed(1)
          : 'N/A';
        
        console.log('[YoY Analysis] Matched', matchedCustomerCount, 'customers between this year and last year');
        console.log('[YoY Analysis] Visited customers: this year=', visitedCustomersThisYearQty, 'same customers last year=', visitedCustomersLastYearQty);
        console.log('[YoY Analysis] VISITED CUSTOMERS INDEX:', visitedCustomersIndex, '%');
        
        yoyAnalysis = {
          comparisonSeasonId,
          lastSeason: {
            totalQty: lastSeasonTotalQty,
            totalAmount: Math.round(lastSeasonTotalAmount),
            customerCount: customersFromLastSeason,
          },
          currentSeason: {
            totalQty: uploadedTotalQty,  // Total from uploaded CSV
            totalAmount: Math.round(uploadedTotalAmount),
            customersVisited: uploadedCustomerCount,  // Unique customers in CSV
            visitRate: `${actualVisitRate}%`,  // visitedCustomers / lastYearCustomers
          },
          // INDEX: Compare visited customers' this year sales vs SAME customers' last year sales
          aggregatedIndex: `${visitedCustomersIndex}%`,
          visitedCustomersAnalysis: {
            matchedCustomers: matchedCustomerCount,
            thisYearQty: visitedCustomersThisYearQty,
            lastYearQty: visitedCustomersLastYearQty,
            index: `${visitedCustomersIndex}%`,
            note: 'Compares this year qty vs same customers last year qty',
          },
          nulledThisYear: {
            count: nulledThisYearCount,
            lostQty: nulledThisYearLostQty,
            lostAmount: Math.round(nulledThisYearLostAmount),
            note: 'Customers marked as nulled - excluded from potential',
          },
          permanentlyClosed: {
            count: permClosedCount,
            lostQty: permClosedLostQty,
            lostAmount: Math.round(permClosedLostAmount),
            note: 'Customers permanently closed - excluded from potential',
          },
          remainingPotential: {
            customerCount: customersFromLastSeason - uploadedCustomerCount - nulledThisYearCount - permClosedCount,
            projectedQty: remainingPotentialQty,
            projectedAmount: Math.round(remainingPotentialAmount),
            note: 'If remaining active customers buy same as last year',
          },
          projectedTotal: {
            qty: uploadedTotalQty + remainingPotentialQty,
            amount: Math.round(uploadedTotalAmount + remainingPotentialAmount),
          },
        };

        console.log('[YoY Analysis] Final YoY analysis object:');
        console.log(JSON.stringify(yoyAnalysis, null, 2));
        console.log('═══════════════════════════════════════════════════════════');
      } catch (e) {
        console.error('[YoY Analysis] ERROR building YoY analysis:', e);
        console.log('═══════════════════════════════════════════════════════════');
      }
    } else {
      console.log('[YoY Analysis] No comparison season provided, skipping YoY analysis');
    }

    // Build supplier lookup map
    const supplierMap: Record<string, any> = {};
    for (const s of (suppliers || [])) {
      supplierMap[s.name] = {
        id: s.id,
        name: s.name,
        moq: s.moq || 0,
        lead_time_days: s.lead_time_days || 0,
        travel_time_days: s.travel_time_days || 0,
        tags: s.tags || [],
      };
    }

    // Build context string
    const contextStr = JSON.stringify({
      importName: importData.name,
      dateRange: {
        start: importData.date_range_start,
        end: importData.date_range_end,
      },
      season: seasonInfo ? { name: seasonInfo.name } : null,
      stats: {
        totalRows: importData.row_count,
        totalStyles: importData.style_count,
        totalCustomers: importData.customer_count,
        totalQty: importData.total_qty,
        totalAmount: importData.total_amount,
      },
      seasonAssortment: {
        totalStyleColors: seasonStyles.length,
        withSales: seasonStyles.length - noSalesStyles.length,
        noSalesYet: noSalesStyles.length,
      },
    }, null, 2);

    // Build no-sales styles summary (grouped by supplier, limited)
    const noSalesBySupplier: Record<string, Array<{ style_no: string; color: string; style_name: string | null }>> = {};
    for (const s of noSalesStyles) {
      const supplier = s.supplier || 'Unknown';
      if (!noSalesBySupplier[supplier]) {
        noSalesBySupplier[supplier] = [];
      }
      // Limit to first 20 per supplier to control tokens
      if (noSalesBySupplier[supplier].length < 20) {
        noSalesBySupplier[supplier].push({
          style_no: s.style_no,
          color: s.color,
          style_name: s.style_name,
        });
      }
    }
    const noSalesStylesStr = noSalesStyles.length > 0
      ? JSON.stringify({
          summary: `${noSalesStyles.length} style/colors from this season have no sales yet`,
          bySupplier: noSalesBySupplier,
        }, null, 2)
      : 'All season styles have sales in the uploaded data.';

    // Build suppliers string (master data)
    const suppliersStr = JSON.stringify(
      Object.values(supplierMap),
      null,
      2
    );

    // Build sales by supplier string (aggregated)
    const salesBySupplierStr = JSON.stringify(limitedSalesBySupplier, null, 2);

    // Build customer analysis string - USE PSEUDONYMIZED VERSION for AI!
    const customerAnalysisStr = JSON.stringify(customerStatsForAI, null, 2);
    console.log('[Privacy] Customer stats pseudonymized: countries→regions, sales_reps→Rep_XXXX');

    // Fetch recent feedback from past runs to improve suggestions
    let feedbackStr = 'No previous feedback available.';
    try {
      const feedbackParts: string[] = [];
      
      // 1. Fetch detailed line-level feedback from purchase_ai_line_feedback
      //    This captures individual style/color corrections with reasons
      const { data: lineFeedback } = await supabase
        .from('purchase_ai_line_feedback')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (lineFeedback && lineFeedback.length > 0) {
        // Group feedback by verdict for better AI understanding
        const adjusted = lineFeedback.filter((f: any) => f.verdict === 'adjusted');
        const approved = lineFeedback.filter((f: any) => f.verdict === 'approved');
        const skipped = lineFeedback.filter((f: any) => f.verdict === 'skipped');
        
        feedbackParts.push(`## Line-Level Feedback Summary (${lineFeedback.length} total entries)`);
        feedbackParts.push(`- Correct suggestions: ${approved.length}`);
        feedbackParts.push(`- Adjusted suggestions: ${adjusted.length}`);
        feedbackParts.push(`- Skipped items: ${skipped.length}`);
        
        // Show specific adjustments with reasons (most valuable for learning)
        if (adjusted.length > 0) {
          feedbackParts.push('\n### Recent Corrections (User adjusted AI suggestion):');
          for (const adj of adjusted.slice(0, 15)) {
            const delta = adj.adjusted_qty - adj.suggested_qty;
            const direction = delta > 0 ? '↑' : '↓';
            feedbackParts.push(
              `- ${adj.supplier_name} | ${adj.style_no}/${adj.color}: ` +
              `AI suggested ${adj.suggested_qty} → User changed to ${adj.adjusted_qty} (${direction}${Math.abs(delta)})` +
              (adj.reason ? ` | Reason: "${adj.reason}"` : '')
            );
          }
        }
        
        // Show patterns in corrections
        if (adjusted.length >= 3) {
          const avgDelta = adjusted.reduce((sum: number, f: any) => 
            sum + (f.adjusted_qty - f.suggested_qty), 0) / adjusted.length;
          const direction = avgDelta > 0 ? 'INCREASING' : 'DECREASING';
          feedbackParts.push(`\n### Pattern: User is typically ${direction} quantities by ~${Math.abs(Math.round(avgDelta))} units on average.`);
        }
      }

      // 2. Also fetch run-level feedback from purchase_ai_runs
      const { data: recentRuns } = await supabase
        .from('purchase_ai_runs')
        .select('user_feedback, created_at')
        .eq('status', 'completed')
        .not('user_feedback', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5);

      if (recentRuns && recentRuns.length > 0) {
        const runFeedback: string[] = [];
        
        for (const run of recentRuns) {
          const feedback = run.user_feedback as Record<string, any>;
          if (!feedback) continue;
          
          for (const [supplier, data] of Object.entries(feedback)) {
            if (data.verdict === 'skipped') {
              runFeedback.push(`- ${supplier}: User skipped this supplier`);
            } else if (data.adjustments && data.adjustments.length > 0) {
              const adj = data.adjustments.slice(0, 3);
              const adjStr = adj.map((a: any) => 
                `${a.style_no}/${a.color}: ${a.original}→${a.adjusted}`
              ).join(', ');
              runFeedback.push(`- ${supplier}: Adjusted quantities (${adjStr}${data.adjustments.length > 3 ? '...' : ''})`);
            }
            if (data.notes) {
              runFeedback.push(`  Note: "${data.notes}"`);
            }
          }
        }
        
        if (runFeedback.length > 0) {
          feedbackParts.push('\n### Run-Level Notes:');
          feedbackParts.push(...runFeedback.slice(0, 10));
        }
      }
      
      if (feedbackParts.length > 0) {
        feedbackStr = feedbackParts.join('\n');
        console.log(`[AI Suggestions] Loaded ${lineFeedback?.length || 0} line feedback entries for AI learning`);
      }
    } catch (e) {
      console.warn('[AI Suggestions] Could not fetch feedback:', e);
    }

    // Build YoY analysis string
    const yoyAnalysisStr = yoyAnalysis 
      ? JSON.stringify(yoyAnalysis, null, 2)
      : 'No comparison season selected - YoY analysis not available.';

    // ═══════════════════════════════════════════════════════════════════════
    // PURCHASE STAGE based on VISIT RATE (% of customers visited)
    // ═══════════════════════════════════════════════════════════════════════
    // Instead of arbitrary "round numbers", we use actual progress:
    // - EARLY: < 40% of customers visited (plenty of room to grow)
    // - MID: 40-75% of customers visited (moderate remaining potential)
    // - CLOSING: > 75% of customers visited (most customers seen, wrapping up)
    
    // Get visit rate from YoY analysis (or default to EARLY if no data)
    let visitRatePercent = 0;
    if (yoyAnalysis?.currentSeason?.visitRate) {
      visitRatePercent = parseFloat(yoyAnalysis.currentSeason.visitRate) || 0;
    }
    
    // Determine purchase stage based on visit rate
    let purchaseStage: 'EARLY' | 'MID' | 'CLOSING' = 'EARLY';
    if (visitRatePercent >= 75) {
      purchaseStage = 'CLOSING';
    } else if (visitRatePercent >= 40) {
      purchaseStage = 'MID';
    } else {
      purchaseStage = 'EARLY';
    }
    
    // Keep run number for logging/labeling only
    let purchaseRunNumber = Number(body.runNumber) || 1;
    if (seasonId && !body.runNumber) {
      const { data: runNumResult } = await supabase.rpc('get_next_purchase_run_number', { p_season_id: seasonId });
      if (runNumResult) {
        purchaseRunNumber = runNumResult;
      }
    }
    
    // Build purchase level info based on VISIT RATE
    let purchaseLevelInfo = '';
    if (purchaseStage === 'EARLY') {
      purchaseLevelInfo = `PURCHASE STAGE: EARLY (${visitRatePercent.toFixed(0)}% of customers visited)
We're at the beginning of the season - lots of customers left to visit.
- Be AGGRESSIVE with quantities - order 100-150% of projected seasonal need
- Better to over-order popular styles than miss sales
- New styles should get healthy initial orders
- Remaining potential: ${100 - visitRatePercent}% of customers not yet visited`;
    } else if (purchaseStage === 'MID') {
      purchaseLevelInfo = `PURCHASE STAGE: MID-SEASON (${visitRatePercent.toFixed(0)}% of customers visited)
About half the season is complete.
- Order 80-100% of remaining projected need
- Focus on proven performers that are selling well
- Be cautious with slow sellers
- Remaining potential: ${100 - visitRatePercent}% of customers not yet visited`;
    } else {
      purchaseLevelInfo = `PURCHASE STAGE: CLOSING (${visitRatePercent.toFixed(0)}% of customers visited)
Most customers have been visited - wrapping up the season. Two options only:
- BUY EXACTLY to match sold qty (if MOQ is met and delivery is viable)
- OR SKIP ENTIRELY (if remaining qty < MOQ or lead time too long)
- Example: Sold 600, purchased 550 → need 50, but MOQ=100 → SKIP (suggest 0)
- Example: Sold 900, purchased 600 → need 300, MOQ=200 → suggest 300 exactly
- NO buffer quantities, NO gambling on late-season
- Remaining potential: only ${100 - visitRatePercent}% of customers left`;
    }
    console.log('[AI Suggestions] Purchase stage:', purchaseStage, `(${visitRatePercent.toFixed(1)}% visited)`);

    // Interpolate prompt
    const finalPrompt = interpolatePrompt(promptConfig.content, {
      context: contextStr,
      purchase_level: purchaseLevelInfo,
      suppliers: suppliersStr,
      sales_by_supplier: salesBySupplierStr,
      no_sales_styles: noSalesStylesStr,
      customer_analysis: customerAnalysisStr,
      yoy_analysis: yoyAnalysisStr,
      feedback: feedbackStr,
    });

    // Create AI run record
    const inputSnapshot = {
      importId,
      seasonId,
      comparisonSeasonId: comparisonSeasonId || null,
      dateRange: {
        start: importData.date_range_start,
        end: importData.date_range_end,
      },
      stats: {
        totalRows: importData.row_count,
        totalStyles: importData.style_count,
        totalCustomers: importData.customer_count,
        suppliersCount: Object.keys(limitedSalesBySupplier).length,
        topNPerSupplier,
      },
      suppliersSent: Object.keys(limitedSalesBySupplier),
      seasonAssortment: {
        totalStyleColors: seasonStyles.length,
        withSales: seasonStyles.length - noSalesStyles.length,
        noSalesYet: noSalesStyles.length,
      },
      yoyAnalysis: yoyAnalysis || null,
    };

    const { data: aiRun, error: aiRunError } = await supabase
      .from('ai_runs')
      .insert({
        prompt_key: promptConfig.key,
        prompt_version: promptConfig.version,
        prompt_content: finalPrompt,
        model: promptConfig.model,
        temperature: promptConfig.temperature,
        max_tokens: promptConfig.maxTokens,
        input_snapshot: inputSnapshot,
        status: 'running',
      })
      .select('id')
      .single();

    if (aiRunError || !aiRun) {
      console.error('[AI Suggestions] Failed to create ai_run:', aiRunError);
      return NextResponse.json({ error: 'Failed to create AI run record' }, { status: 500 });
    }

    const aiRunId = aiRun.id;

    // Use the run number we already computed earlier
    const runLabel = `Round_${purchaseRunNumber}`;

    // Build computed features snapshot for reproducibility
    const computedFeaturesSnapshot = {
      overall: {
        totalQty: importData.total_qty,
        totalAmount: importData.total_amount,
        styleCount: importData.style_count,
        customerCount: importData.customer_count,
      },
      supplierBreakdown: Object.entries(salesBySupplier).map(([supplier, items]) => ({
        supplier,
        styleCount: items.length,
        totalQty: items.reduce((sum: number, r: any) => sum + (Number(r.total_qty) || 0), 0),
      })),
      yoyAnalysis: yoyAnalysis || null,
      customerStats,
      noSalesStylesCount: noSalesStyles.length,
      seasonAssortment: {
        totalStyleColors: seasonStyles.length,
        withSales: seasonStyles.length - noSalesStyles.length,
        noSalesYet: noSalesStyles.length,
      },
    };

    // Create purchase_ai_runs record with extended fields
    const { data: purchaseRun, error: purchaseRunError } = await supabase
      .from('purchase_ai_runs')
      .insert({
        ai_run_id: aiRunId,
        season_id: seasonId || null,
        import_id: importId,
        comparison_season_id: comparisonSeasonId || null,
        run_label: runLabel,
        run_number: purchaseRunNumber,
        comparison_mode: comparisonSeasonId ? 'csv_to_season_totals' : 'csv_only',
        computed_features_snapshot: computedFeaturesSnapshot,
        run_started_at: new Date().toISOString(),
        date_range: {
          start: importData.date_range_start,
          end: importData.date_range_end,
        },
        status: 'pending',
      })
      .select('id')
      .single();

    if (purchaseRunError) {
      console.error('[AI Suggestions] Failed to create purchase_ai_runs:', purchaseRunError);
    }
    
    console.log('[AI Suggestions] Created purchase run:', runLabel, '(run #' + purchaseRunNumber + ')');

    // Call OpenAI - use CHUNKED approach if we have many styles
    const openai = new OpenAI({ apiKey: openaiApiKey });
    
    let aiOutput: AIOutput | null = null;
    let rawResponse = '';
    let usage: any = null;
    let aiError: string | null = null;
    
    // Decide: use chunked (per-supplier) mode if we have many styles
    const USE_CHUNKED_MODE = totalStylesSent > 30;
    const supplierNames = Object.keys(limitedSalesBySupplier);
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('[AI Mode]', USE_CHUNKED_MODE ? 'CHUNKED (per-supplier)' : 'SINGLE CALL');
    console.log('[AI Mode] Total styles:', totalStylesSent, '| Suppliers:', supplierNames.length);
    console.log('═══════════════════════════════════════════════════════════');

    if (USE_CHUNKED_MODE) {
      // CHUNKED MODE: Process each supplier separately for better completeness
      console.log('[AI Chunked] Processing', supplierNames.length, 'suppliers in parallel...');
      
      const supplierPromises = supplierNames.map(async (supplierName) => {
        const supplierStyles = limitedSalesBySupplier[supplierName] || [];
        const supplierData = supplierMap[supplierName] || {};
        
        // Build compact prompt for this supplier
        const stylesData = compressStylesForAI(supplierStyles);
        const singleSupplierPrompt = `You are a purchasing advisor. Generate purchase suggestions for ONE supplier.

## Supplier: ${supplierName}
MOQ: ${supplierData.moq || 0} | Lead Time: ${supplierData.lead_time_days || 0} days

## Purchase Stage (based on ${visitRatePercent.toFixed(0)}% of customers visited)
${purchaseLevelInfo}

## Styles (format: style_no|color|sold|sizes_json)
${stylesData}

## Rules
1. **INCLUDE ALL STYLES** - every style in input MUST appear in output (${supplierStyles.length} total)
2. **Round to full numbers**: <100→nearest 25, 100-500→nearest 50, >500→nearest 100
3. **Skip low sales**: If sold < ${Math.round((supplierData.moq || 0) * 0.65)} (65% of MOQ) in EARLY stage → qty:0, skip_reason:"Below MOQ threshold"
4. **EARLY (<40% visited)**: Suggest 1.0-1.3x of sold (buffer for growth)
5. **MID (40-75% visited)**: Match sold or slightly above
6. **CLOSING (>75% visited)**: Exact match to sold, or skip if remaining < MOQ
7. **Never exceed last year** unless style is 150%+ vs last year

## Output (valid JSON only, no markdown):
{
  "supplier_name": "${supplierName}",
  "lines": [
    {"style_no":"X","color":"Y","qty":N,"sold":N,"skip_reason":null,"reason":"brief"}
  ],
  "total_units": N,
  "moq_status": "met|under|n/a",
  "summary": "1-2 sentences"
}`;

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'Respond with valid JSON only. No markdown.' },
              { role: 'user', content: singleSupplierPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.2,
            response_format: { type: 'json_object' },
          });
          
          const response = completion.choices[0]?.message?.content || '';
          const parsed = JSON.parse(response);
          
          console.log(`[AI Chunked] ${supplierName}: ${parsed.lines?.length || 0} lines, ${parsed.total_units || 0} units`);
          
          return {
            success: true,
            supplierName,
            data: parsed,
            usage: completion.usage,
          };
        } catch (e: any) {
          console.error(`[AI Chunked] ${supplierName} FAILED:`, e.message);
          return {
            success: false,
            supplierName,
            error: e.message,
          };
        }
      });
      
      // Run all in parallel (or use batches for rate limiting)
      const results = await Promise.all(supplierPromises);
      
      // Combine results into AIOutput format
      const combinedSuppliers: SupplierSuggestion[] = [];
      let totalTokens = 0;
      let successCount = 0;
      let failCount = 0;
      
      for (const result of results) {
        if (result.success && result.data) {
          successCount++;
          totalTokens += result.usage?.total_tokens || 0;
          
          // Convert chunked response to our SupplierSuggestion format
          const lines = (result.data.lines || []).map((l: any) => ({
            style_no: l.style_no,
            color: l.color,
            suggested_qty: l.qty || 0,
            reasoning: l.reason || '',
            priority: l.skip_reason ? 'skip' as const : 'medium' as const,
            skip_reason: l.skip_reason || null,
            current_sold: l.sold || 0,
          }));
          
          combinedSuppliers.push({
            supplier_name: result.supplierName,
            supplier_id: supplierMap[result.supplierName]?.id || '',
            recommendation_summary: result.data.summary || '',
            total_units: result.data.total_units || 0,
            total_value_estimate: 0,
            lines,
            moq_status: result.data.moq_status || 'n/a',
          });
        } else {
          failCount++;
        }
      }
      
      aiOutput = {
        suppliers: combinedSuppliers,
        overall_summary: `Processed ${successCount} suppliers in chunked mode. ${failCount > 0 ? `${failCount} failed.` : ''}`,
        total_units: combinedSuppliers.reduce((sum, s) => sum + s.total_units, 0),
        warnings: failCount > 0 ? [`${failCount} suppliers failed to process`] : [],
      };
      
      usage = { total_tokens: totalTokens };
      rawResponse = JSON.stringify(aiOutput);
      
      console.log('═══════════════════════════════════════════════════════════');
      console.log('[AI Chunked] COMPLETE:', successCount, 'succeeded,', failCount, 'failed');
      console.log('[AI Chunked] Total tokens used:', totalTokens);
      console.log('[AI Chunked] Total units:', aiOutput.total_units);
      console.log('═══════════════════════════════════════════════════════════');
      
    } else {
      // SINGLE CALL MODE: Use original approach for smaller datasets
      try {
        console.log('[AI Suggestions] Calling OpenAI (single call)...', {
          model: promptConfig.model,
          promptLength: finalPrompt.length,
        });

        const completion = await openai.chat.completions.create({
          model: promptConfig.model,
          messages: [
            {
              role: 'system',
              content: 'You are a purchasing advisor. Always respond with valid JSON matching the specified schema. Do not include markdown code blocks in your response.',
            },
            {
              role: 'user',
              content: finalPrompt,
            },
          ],
          max_tokens: promptConfig.maxTokens,
          temperature: promptConfig.temperature,
          response_format: { type: 'json_object' },
        });

        rawResponse = completion.choices[0]?.message?.content || '';
        usage = completion.usage;

        console.log('[AI Suggestions] OpenAI response received', {
          tokensUsed: usage?.total_tokens,
          responseLength: rawResponse.length,
        });

        // Parse JSON response
        try {
          aiOutput = JSON.parse(rawResponse) as AIOutput;
          
          // Build sold qty lookup FIRST so we can use it in logging
          const soldQtyMapForLog: Record<string, number> = {};
          for (const row of (salesSummary || [])) {
            const key = `${row.style_no}|${row.color}`;
            soldQtyMapForLog[key] = (soldQtyMapForLog[key] || 0) + (Number(row.total_qty) || 0);
          }
          
          // Log AI response summary
          console.log('═══════════════════════════════════════════════════════════');
          console.log('[AI Response] SUMMARY:');
          console.log('[AI Response] Overall:', aiOutput.overall_summary);
          console.log('[AI Response] Total units suggested:', aiOutput.total_units);
          console.log('[AI Response] Warnings:', aiOutput.warnings || 'none');
          console.log('[AI Response] Suppliers:', aiOutput.suppliers?.length || 0);
          
          // Count total lines from AI
          let totalAILines = 0;
          for (const supplier of (aiOutput.suppliers || [])) {
            totalAILines += (supplier.lines?.length || 0);
          }
          console.log('[AI Response] TOTAL STYLE/COLOR LINES FROM AI:', totalAILines);
          console.log('[AI Response] INPUT: We sent', totalStylesSent, 'styles to AI');
          if (totalAILines < totalStylesSent) {
            console.warn('[AI Response] WARNING: AI returned fewer styles than we sent!', 
              `Missing ${totalStylesSent - totalAILines} styles`);
          }
          
          // Log per-supplier summary (with actual sold qty from our data)
          for (const supplier of (aiOutput.suppliers || [])) {
            const topLines = (supplier.lines || []).slice(0, 3);
            console.log(`[AI Response] ${supplier.supplier_name}:`);
            console.log(`  - ${supplier.lines?.length || 0} lines, ${supplier.total_units} total units`);
            console.log(`  - Top suggestions:`, topLines.map(l => {
              const key = `${l.style_no}|${l.color}`;
              const soldQty = soldQtyMapForLog[key] || 0;
              return `${l.style_no}/${l.color}: ${soldQty} sold → ${l.suggested_qty} suggested`;
            }).join(', '));
          }
          console.log('═══════════════════════════════════════════════════════════');
          
        } catch (parseError) {
          console.error('[AI Suggestions] Failed to parse AI response as JSON:', parseError);
          console.error('[AI Suggestions] Raw response (first 1000 chars):', rawResponse.substring(0, 1000));
          aiError = 'Failed to parse AI response as JSON';
        }
      } catch (openaiError: any) {
        console.error('[AI Suggestions] OpenAI API error:', openaiError);
        aiError = openaiError?.message || 'OpenAI API error';
      }
    }

    const durationMs = Date.now() - startTime;

    // Enrich AI output with style_name, image_url, sold qty, and size data from sales summary
    if (aiOutput && aiOutput.suppliers) {
      // Build lookup maps from sales summary
      const styleNameMap: Record<string, string> = {};
      const imageUrlMap: Record<string, string> = {};
      const soldQtyMap: Record<string, number> = {};  // key: style_no|color → sold qty
      
      for (const row of (salesSummary || [])) {
        if (row.style_no && row.style_name) {
          styleNameMap[row.style_no] = row.style_name;
        }
        if (row.style_no && row.image_url) {
          imageUrlMap[row.style_no] = row.image_url;
        }
        // Build sold qty lookup
        const key = `${row.style_no}|${row.color}`;
        soldQtyMap[key] = (soldQtyMap[key] || 0) + (Number(row.total_qty) || 0);
      }
      
      console.log('[AI Suggestions] Built sold qty lookup for', Object.keys(soldQtyMap).length, 'style/color combinations');
      
      // Add style_name from season styles if not in sales summary
      for (const style of seasonStyles) {
        if (style.style_no && style.style_name && !styleNameMap[style.style_no]) {
          styleNameMap[style.style_no] = style.style_name;
        }
      }
      
      // Enrich each supplier's lines with style_name, image_url, and size data
      for (const supplier of aiOutput.suppliers) {
        if (supplier.lines) {
          for (const line of supplier.lines) {
            const key = `${line.style_no}|${line.color}`;
            const sizeData = sizeBreakdownMap[key];
            
            if (line.style_no && styleNameMap[line.style_no]) {
              (line as any).style_name = styleNameMap[line.style_no];
            }
            if (line.style_no && imageUrlMap[line.style_no]) {
              (line as any).image_url = imageUrlMap[line.style_no];
            }
            // Add current sold qty from our data (don't rely on AI returning it)
            const soldQty = soldQtyMap[key] || 0;
            (line as any).current_sold = soldQty;
            // Add size info and sales data
            if (sizeData) {
              (line as any).available_sizes = sizeData.sizes;
              // Add actual sales data per size
              (line as any).sold_sizes = sizeData.sizeQty;
              // Calculate total sold
              const totalSold = Object.values(sizeData.sizeQty).reduce((sum: number, v) => sum + (v as number), 0);
              (line as any).total_sold = totalSold;
              
              // If AI didn't provide size_quantities, calculate from suggested_qty proportionally
              if (!(line as any).size_quantities && sizeData.sizes.length > 0) {
                if (totalSold > 0) {
                  const sizeQuantities: SizeQtyMap = {};
                  for (const size of sizeData.sizes) {
                    const sizeQty = sizeData.sizeQty[size] || 0;
                    const ratio = sizeQty / totalSold;
                    sizeQuantities[size] = Math.round(line.suggested_qty * ratio);
                  }
                  // Adjust for rounding errors
                  const sum = Object.values(sizeQuantities).reduce((s, v) => s + v, 0);
                  if (sum !== line.suggested_qty && sizeData.sizes.length > 0) {
                    const diff = line.suggested_qty - sum;
                    // Add diff to largest size
                    const largestSize = sizeData.sizes.reduce((a, b) => 
                      (sizeQuantities[a] || 0) >= (sizeQuantities[b] || 0) ? a : b
                    );
                    sizeQuantities[largestSize] = (sizeQuantities[largestSize] || 0) + diff;
                  }
                  (line as any).size_quantities = sizeQuantities;
                } else {
                  // Even distribution if no sales data
                  const perSize = Math.floor(line.suggested_qty / sizeData.sizes.length);
                  const remainder = line.suggested_qty % sizeData.sizes.length;
                  const sizeQuantities: SizeQtyMap = {};
                  sizeData.sizes.forEach((size, idx) => {
                    sizeQuantities[size] = perSize + (idx < remainder ? 1 : 0);
                  });
                  (line as any).size_quantities = sizeQuantities;
                }
              }
            }
          }
        }
      }
      
      console.log('[AI Suggestions] Enriched output with', Object.keys(styleNameMap).length, 'style names and size breakdowns');
      
      // ═══════════════════════════════════════════════════════════════════════
      // VALIDATE: Only for EARLY stage - don't override CLOSING stage suggestions
      // The AI makes conservative suggestions for CLOSING - that's CORRECT
      // ═══════════════════════════════════════════════════════════════════════
      
      console.log('═══════════════════════════════════════════════════════════');
      console.log('[VALIDATE] Purchase stage:', purchaseStage, `(${visitRatePercent.toFixed(1)}% visited)`);
      
      // Only validate/fix for EARLY stage (<40% visited)
      // For MID and CLOSING, trust the AI's suggestions
      if (purchaseStage === 'EARLY') {
        // For early stage, use modest multiplier (1.2-1.5x, not full projection)
        const projectionMultiplier = Math.min(1.5, visitRatePercent > 0 ? 100 / visitRatePercent : 1.5);
        
        console.log('[VALIDATE] EARLY STAGE - checking suggestions');
        console.log('[VALIDATE] Visit rate:', visitRatePercent.toFixed(1), '% → multiplier:', projectionMultiplier.toFixed(2));
        
        let fixedCount = 0;
        for (const supplier of aiOutput.suppliers) {
          for (const line of (supplier.lines || [])) {
            const soldQty = (line as any).current_sold || 0;
            const suggestedQty = line.suggested_qty || 0;
            
            // Only fix if suggested is MUCH lower than sold (less than 80%)
            if (soldQty > 0 && suggestedQty < soldQty * 0.8) {
              // For early rounds: suggest sold + 20-30% buffer, NOT sold × multiplier
              const correctedQty = Math.round((soldQty * 1.3) / 10) * 10;
              console.log(`[VALIDATE] FIXED: ${line.style_no}/${line.color}: ${soldQty} sold, AI said ${suggestedQty} → corrected to ${correctedQty}`);
              
              // Update the suggestion
              const originalQty = line.suggested_qty;
              line.suggested_qty = correctedQty;
              (line as any).notes = `AI suggested ${originalQty}, adjusted to ${correctedQty} (early stage buffer)`;
              (line as any).projection_basis = `Sold ${soldQty} + 30% buffer = ${correctedQty} (${visitRatePercent.toFixed(0)}% visited)`;
              
              // Update supplier total
              supplier.total_units = (supplier.total_units || 0) - originalQty + correctedQty;
              
              // Recalculate size quantities if we have size data
              const sizeData = (line as any).sold_sizes;
              if (sizeData && Object.keys(sizeData).length > 0) {
                const totalSold = Object.values(sizeData).reduce((sum: number, v) => sum + ((v as number) || 0), 0);
                if (totalSold > 0) {
                  const newSizeQty: Record<string, number> = {};
                  for (const [size, qty] of Object.entries(sizeData)) {
                    const ratio = ((qty as number) || 0) / totalSold;
                    newSizeQty[size] = Math.round(correctedQty * ratio);
                  }
                  (line as any).size_quantities = newSizeQty;
                }
              }
              
              fixedCount++;
            }
          }
        }
        
        if (fixedCount > 0) {
          aiOutput.total_units = aiOutput.suppliers.reduce((sum, s) => sum + (s.total_units || 0), 0);
          console.log('[VALIDATE] Fixed', fixedCount, 'suggestions. New total:', aiOutput.total_units);
        } else {
          console.log('[VALIDATE] All AI suggestions were valid');
        }
      } else {
        // MID or CLOSING stage - trust AI's conservative suggestions
        console.log(`[VALIDATE] ${purchaseStage} STAGE - trusting AI suggestions (no overrides)`);
      }
      console.log('═══════════════════════════════════════════════════════════');
      
      // ═══════════════════════════════════════════════════════════════════════
      // BACKFILL: Add missing styles that AI didn't include
      // This ensures we get a suggestion for EVERY style with sales
      // ═══════════════════════════════════════════════════════════════════════
      
      // Build set of style/colors that AI already returned
      const aiReturnedKeys = new Set<string>();
      for (const supplier of aiOutput.suppliers) {
        for (const line of (supplier.lines || [])) {
          aiReturnedKeys.add(`${line.style_no}|${line.color}`);
        }
      }
      
      // Find missing styles from our sales data
      const missingStyles: Array<{
        supplier: string;
        style_no: string;
        color: string;
        soldQty: number;
        style_name?: string;
        image_url?: string;
        sizeData: { sizes: string[]; sizeQty: Record<string, number> } | null;
      }> = [];
      
      for (const row of (salesSummary || [])) {
        const key = `${row.style_no}|${row.color}`;
        if (!aiReturnedKeys.has(key)) {
          const sizeData = sizeBreakdownMap[key];
          missingStyles.push({
            supplier: row.supplier || 'Unknown',
            style_no: row.style_no,
            color: row.color || 'Default',
            soldQty: Number(row.total_qty) || 0,
            style_name: styleNameMap[row.style_no],
            image_url: imageUrlMap[row.style_no],
            sizeData: sizeData || null,
          });
        }
      }
      
      if (missingStyles.length > 0) {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('[BACKFILL] Adding', missingStyles.length, 'styles that AI missed');
        console.log('[BACKFILL] Purchase stage:', purchaseStage, `(${visitRatePercent.toFixed(1)}% visited)`);
        
        // Multiplier depends on purchase stage!
        let multiplier: number;
        let isClosingStage = false;
        if (purchaseStage === 'EARLY') {
          // EARLY (<40% visited): sold + 30% buffer
          multiplier = 1.3;
          console.log('[BACKFILL] EARLY STAGE - using 1.3x multiplier');
        } else if (purchaseStage === 'MID') {
          // MID (40-75% visited): match sold or slightly above
          multiplier = 1.1;
          console.log('[BACKFILL] MID STAGE - using 1.1x multiplier');
        } else {
          // CLOSING (>75% visited): match exactly to sold amount
          multiplier = 1.0;
          isClosingStage = true;
          console.log('[BACKFILL] CLOSING STAGE - using 1.0x (exact match, check MOQ)');
        }
        
        // Group missing by supplier
        const missingBySupplier: Record<string, typeof missingStyles> = {};
        for (const m of missingStyles) {
          const supplierKey = m.supplier;
          if (!missingBySupplier[supplierKey]) {
            missingBySupplier[supplierKey] = [];
          }
          missingBySupplier[supplierKey]!.push(m);
        }
        
        // Add to AI output
        for (const [supplierName, styles] of Object.entries(missingBySupplier)) {
          // Get supplier MOQ from master data
          const supplierData = supplierMap[supplierName];
          const supplierMoq = supplierData?.moq || 0;
          
          // Find or create supplier in output
          let supplierOutput = aiOutput.suppliers.find(s => s.supplier_name === supplierName);
          if (!supplierOutput) {
            const newSupplier: SupplierSuggestion = {
              supplier_name: supplierName,
              supplier_id: supplierData?.id || '',
              recommendation_summary: 'Backfilled - AI did not include this supplier',
              lines: [],
              total_units: 0,
              total_value_estimate: 0,
              moq_status: 'n/a',
            };
            aiOutput.suppliers.push(newSupplier);
            supplierOutput = newSupplier;
          }
          if (!supplierOutput.lines) {
            supplierOutput.lines = [];
          }
          
          for (const m of styles) {
            // Check if sales are too low vs MOQ (skip if below 65% of MOQ)
            // Only applies to EARLY stage - we'll catch them in next purchase
            const moqThreshold = 0.65; // 65% of MOQ
            const isBelowMoqThreshold = supplierMoq > 0 && 
              m.soldQty < (supplierMoq * moqThreshold) && 
              purchaseStage === 'EARLY'; // Only skip in early stage
            
            // Project quantity: sold × multiplier, then round to "full" numbers
            const rawProjected = m.soldQty * multiplier;
            let projectedQty: number;
            
            if (isBelowMoqThreshold) {
              // Skip this style - below MOQ threshold for early stage
              projectedQty = 0;
            } else if (isClosingStage) {
              // CLOSING: match sold exactly, rounded to full numbers
              projectedQty = roundToFullQty(m.soldQty);
            } else {
              // EARLY/MID: at least sold qty, rounded to full numbers
              projectedQty = roundToFullQty(Math.max(m.soldQty, rawProjected));
            }
            
            // Build size quantities (only if we're ordering)
            let sizeQuantities: Record<string, number> | undefined = undefined;
            if (projectedQty > 0 && m.sizeData && m.sizeData.sizes.length > 0) {
              const totalSold = Object.values(m.sizeData.sizeQty).reduce((sum, v) => sum + (v || 0), 0);
              if (totalSold > 0) {
                sizeQuantities = {};
                for (const size of m.sizeData.sizes) {
                  const sizeQty = m.sizeData.sizeQty[size] || 0;
                  const ratio = sizeQty / totalSold;
                  sizeQuantities[size] = Math.round(projectedQty * ratio);
                }
              } else {
                // Even distribution
                sizeQuantities = {};
                const perSize = Math.floor(projectedQty / m.sizeData.sizes.length);
                m.sizeData.sizes.forEach((size, idx) => {
                  sizeQuantities![size] = perSize + (idx < projectedQty % m.sizeData!.sizes.length ? 1 : 0);
                });
              }
            }
            
            // Determine skip reason if applicable
            let skipReason: string | null = null;
            let notes: string;
            let reasoning: string;
            let priority: 'high' | 'medium' | 'low' | 'skip';
            
            if (isBelowMoqThreshold) {
              skipReason = `Below MOQ threshold: sold ${m.soldQty} < ${Math.round(supplierMoq * moqThreshold)} (65% of MOQ ${supplierMoq})`;
              notes = 'Skipped - will reconsider in next purchase round when sales increase';
              reasoning = 'Sales too low vs MOQ, waiting for more demand';
              priority = 'skip';
            } else if (isClosingRound) {
              notes = 'Backfilled - CLOSING round: exact match to sold qty';
              reasoning = 'Closing round: buy to cover exactly, or skip if MOQ not met';
              priority = 'low';
            } else {
              notes = 'Backfilled - AI did not include this style';
              reasoning = 'System backfill based on sold qty projection';
              priority = 'medium';
            }
            
            const backfillLine: any = {
              style_no: m.style_no,
              color: m.color,
              suggested_qty: projectedQty,
              current_sold: m.soldQty,
              style_name: m.style_name,
              image_url: m.image_url,
              skip_reason: skipReason,
              notes: notes,
              projection_basis: isBelowMoqThreshold
                ? `Skipped: ${m.soldQty} sold < ${Math.round(supplierMoq * moqThreshold)} MOQ threshold`
                : `Sold ${m.soldQty} × ${multiplier.toFixed(1)}x → rounded to ${projectedQty}`,
              available_sizes: m.sizeData?.sizes || [],
              sold_sizes: m.sizeData?.sizeQty || {},
              total_sold: m.soldQty,
              size_quantities: sizeQuantities,
              reasoning: reasoning,
              priority: priority,
            };
            
            supplierOutput.lines!.push(backfillLine);
            supplierOutput.total_units += projectedQty;
          }
        }
        
        // Update total units
        aiOutput.total_units = aiOutput.suppliers.reduce((sum, s) => sum + (s.total_units || 0), 0);
        
        console.log('[BACKFILL] Total styles now:', aiReturnedKeys.size + missingStyles.length);
        console.log('[BACKFILL] Total units now:', aiOutput.total_units);
        console.log('═══════════════════════════════════════════════════════════');
      }
    }

    // Update ai_runs record
    await supabase
      .from('ai_runs')
      .update({
        status: aiError ? 'failed' : 'completed',
        output: aiOutput,
        raw_response: rawResponse,
        usage: usage,
        error: aiError,
        duration_ms: durationMs,
        completed_at: new Date().toISOString(),
      })
      .eq('id', aiRunId);

    // Update purchase_ai_runs with suggestions
    if (aiOutput && purchaseRun) {
      await supabase
        .from('purchase_ai_runs')
        .update({
          supplier_suggestions: aiOutput.suppliers,
          status: 'reviewing',
        })
        .eq('id', purchaseRun.id);
    }

    if (aiError) {
      return NextResponse.json({
        success: false,
        error: aiError,
        aiRunId,
        purchaseRunId: purchaseRun?.id,
      }, { status: 500 });
    }

    console.log('[AI Suggestions] Complete', {
      aiRunId,
      purchaseRunId: purchaseRun?.id,
      durationMs,
      suppliersRecommended: aiOutput?.suppliers?.length || 0,
      totalUnits: aiOutput?.total_units || 0,
    });

    return NextResponse.json({
      success: true,
      aiRunId,
      purchaseRunId: purchaseRun?.id,
      suggestions: aiOutput,
      yoyAnalysis: yoyAnalysis || null,
      seasonAssortment: {
        totalStyleColors: seasonStyles.length,
        withSales: seasonStyles.length - noSalesStyles.length,
        noSalesYet: noSalesStyles.length,
        noSalesStylesBySupplier: noSalesBySupplier,
      },
      // Suppliers from sales data that don't have a matching entry in suppliers table
      unlinkedSuppliers: unlinkedSuppliers.length > 0 ? unlinkedSuppliers : null,
      suppliersCoverage: {
        totalFromSales: suppliersFromSales.size,
        linkedCount: suppliersFromSales.size - unlinkedSuppliers.length,
        unlinkedCount: unlinkedSuppliers.length,
      },
      // Analysis background for transparency
      analysisBackground: {
        promptKey: promptConfig.key,
        promptVersion: promptConfig.version,
        runLabel,
        runNumber: purchaseRunNumber,
        purchaseStage,
        visitRatePercent: visitRatePercent.toFixed(1),
        stageExplanation: `${purchaseStage} stage (${visitRatePercent.toFixed(0)}% of customers visited)`,
        model: promptConfig.model,
        temperature: promptConfig.temperature,
        computedFeatures: computedFeaturesSnapshot,
      },
      stats: {
        durationMs,
        tokensUsed: usage?.total_tokens || 0,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
      },
    });
  } catch (error: any) {
    console.error('[AI Suggestions] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET: Retrieve a previous AI run result
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const purchaseRunId = searchParams.get('purchaseRunId');
    const aiRunId = searchParams.get('aiRunId');

    if (!purchaseRunId && !aiRunId) {
      return NextResponse.json({ error: 'purchaseRunId or aiRunId is required' }, { status: 400 });
    }

    if (purchaseRunId) {
      const { data, error } = await supabase
        .from('purchase_ai_runs')
        .select(`
          *,
          ai_runs (*)
        `)
        .eq('id', purchaseRunId)
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ data });
    }

    if (aiRunId) {
      const { data, error } = await supabase
        .from('ai_runs')
        .select('*')
        .eq('id', aiRunId)
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ data });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

