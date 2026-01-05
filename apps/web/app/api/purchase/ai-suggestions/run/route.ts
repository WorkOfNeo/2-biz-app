import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig, interpolatePrompt } from '../../../../../lib/ai/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60 seconds for AI call

type SupplierSuggestion = {
  supplier_name: string;
  supplier_id: string;
  recommendation_summary: string;
  total_units: number;
  total_value_estimate: number;
  lines: Array<{
    style_no: string;
    color: string;
    suggested_qty: number;
    reasoning: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  moq_status: 'met' | 'under' | 'n/a';
  notes?: string;
};

type AIOutput = {
  suppliers: SupplierSuggestion[];
  overall_summary: string;
  total_units: number;
  warnings: string[];
};

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
      topNPerSupplier = 50, // Limit items per supplier to control token usage
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
    let salesSummary: any[] = [];
    const { data: salesWithImages, error: summaryErrorImages } = await supabase
      .from('purchase_sales_summary_with_images')
      .select('*')
      .eq('import_id', importId);

    if (summaryErrorImages) {
      console.warn('[AI Suggestions] Could not fetch from purchase_sales_summary_with_images, falling back:', summaryErrorImages.message);
      const { data: salesBasic, error: summaryError } = await supabase
        .from('purchase_sales_summary')
        .select('*')
        .eq('import_id', importId);
      
      if (summaryError) {
        console.error('[AI Suggestions] Failed to fetch sales summary:', summaryError);
        return NextResponse.json({ error: 'Failed to fetch sales data' }, { status: 500 });
      }
      salesSummary = salesBasic || [];
    } else {
      salesSummary = salesWithImages || [];
      console.log('[AI Suggestions] Loaded sales summary with images:', salesSummary.length, 'style/color rows');
    }

    // Fetch customer summary for coverage analysis
    const { data: customerSummary, error: customerError } = await supabase
      .from('purchase_customer_summary')
      .select('*')
      .eq('import_id', importId);

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
      salesBySupplier[supplier].push(row);
      supplierDebug[supplier].rowCount++;
      supplierDebug[supplier].totalQty += Number(row.total_qty) || 0;
    }

    console.log('[Supplier Grouping] Suppliers found in sales data:', Object.keys(salesBySupplier).length);
    for (const [supplier, debug] of Object.entries(supplierDebug)) {
      console.log(`  - "${supplier}": ${debug.rowCount} style/colors, ${debug.totalQty} pcs`);
    }

    // Limit items per supplier to control tokens
    const limitedSalesBySupplier: Record<string, any[]> = {};
    for (const [supplier, items] of Object.entries(salesBySupplier)) {
      // Sort by total_qty descending and take top N
      const sorted = items.sort((a, b) => (b.total_qty || 0) - (a.total_qty || 0));
      limitedSalesBySupplier[supplier] = sorted.slice(0, topNPerSupplier);
    }
    
    console.log('[Supplier Grouping] After limiting to top', topNPerSupplier, 'items per supplier');
    console.log('═══════════════════════════════════════════════════════════');

    // Build customer analysis summary
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
      }
      if (c.sales_rep) {
        customerStats.bySalesRep[c.sales_rep] = (customerStats.bySalesRep[c.sales_rep] || 0) + 1;
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

        // Fetch last season's totals from season_statistics
        const { data: lastSeasonStats, error: lastSeasonError } = await supabase
          .from('season_statistics')
          .select('customer_id, qty, amount')
          .eq('season_id', comparisonSeasonId);

        if (lastSeasonError) {
          console.error('[YoY Analysis] ERROR fetching last season stats:', lastSeasonError);
        } else {
          console.log('[YoY Analysis] Last season (comparison) stats loaded:', (lastSeasonStats || []).length, 'customer records');
          if ((lastSeasonStats || []).length > 0) {
            const totalQty = (lastSeasonStats || []).reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
            const totalAmt = (lastSeasonStats || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
            console.log(`[YoY Analysis] Last season totals: ${totalQty} pcs, ${totalAmt.toFixed(0)} amount`);
          } else {
            console.warn('[YoY Analysis] WARNING: No data found for comparison season!');
          }
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
              console.log(`[YoY Analysis] Current season totals: ${totalQty} pcs, ${totalAmt.toFixed(0)} amount`);
            } else {
              console.warn('[YoY Analysis] WARNING: No data found for current season!');
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

        // Calculate index
        const aggregatedIndex = lastSeasonTotalQty > 0 
          ? ((currentSeasonTotalQty / lastSeasonTotalQty) * 100).toFixed(1)
          : 'N/A';

        yoyAnalysis = {
          comparisonSeasonId,
          lastSeason: {
            totalQty: lastSeasonTotalQty,
            totalAmount: Math.round(lastSeasonTotalAmount),
            customerCount: customersFromLastSeason,
          },
          currentSeason: {
            totalQty: currentSeasonTotalQty,
            totalAmount: Math.round(currentSeasonTotalAmount),
            customersVisited: customersVisitedThisSeason,
            visitRate: customersFromLastSeason > 0 
              ? `${((customersVisitedThisSeason / customersFromLastSeason) * 100).toFixed(1)}%`
              : 'N/A',
          },
          aggregatedIndex: `${aggregatedIndex}%`,
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
            customerCount: customersFromLastSeason - customersVisitedThisSeason - nulledThisYearCount - permClosedCount,
            projectedQty: remainingPotentialQty,
            projectedAmount: Math.round(remainingPotentialAmount),
            note: 'If remaining active customers buy same as last year',
          },
          projectedTotal: {
            qty: currentSeasonTotalQty + remainingPotentialQty,
            amount: Math.round(currentSeasonTotalAmount + remainingPotentialAmount),
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

    // Build customer analysis string
    const customerAnalysisStr = JSON.stringify(customerStats, null, 2);

    // Fetch recent feedback from past runs to improve suggestions
    let feedbackStr = 'No previous feedback available.';
    try {
      const { data: recentRuns } = await supabase
        .from('purchase_ai_runs')
        .select('user_feedback, created_at')
        .eq('status', 'completed')
        .not('user_feedback', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5);

      if (recentRuns && recentRuns.length > 0) {
        const feedbackSummary: string[] = [];
        
        for (const run of recentRuns) {
          const feedback = run.user_feedback as Record<string, any>;
          if (!feedback) continue;
          
          for (const [supplier, data] of Object.entries(feedback)) {
            if (data.verdict === 'skipped') {
              feedbackSummary.push(`- ${supplier}: User skipped this supplier`);
            } else if (data.adjustments && data.adjustments.length > 0) {
              const adj = data.adjustments.slice(0, 3);
              const adjStr = adj.map((a: any) => 
                `${a.style_no}/${a.color}: ${a.original}→${a.adjusted}`
              ).join(', ');
              feedbackSummary.push(`- ${supplier}: Adjusted quantities (${adjStr}${data.adjustments.length > 3 ? '...' : ''})`);
            }
            if (data.notes) {
              feedbackSummary.push(`  Note: "${data.notes}"`);
            }
          }
        }
        
        if (feedbackSummary.length > 0) {
          feedbackStr = `Recent user adjustments:\n${feedbackSummary.slice(0, 15).join('\n')}`;
        }
      }
    } catch (e) {
      console.warn('[AI Suggestions] Could not fetch feedback:', e);
    }

    // Build YoY analysis string
    const yoyAnalysisStr = yoyAnalysis 
      ? JSON.stringify(yoyAnalysis, null, 2)
      : 'No comparison season selected - YoY analysis not available.';

    // Interpolate prompt
    const finalPrompt = interpolatePrompt(promptConfig.content, {
      context: contextStr,
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

    // Create purchase_ai_runs record
    const { data: purchaseRun, error: purchaseRunError } = await supabase
      .from('purchase_ai_runs')
      .insert({
        ai_run_id: aiRunId,
        season_id: seasonId || null,
        import_id: importId,
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

    // Call OpenAI
    const openai = new OpenAI({ apiKey: openaiApiKey });
    
    let aiOutput: AIOutput | null = null;
    let rawResponse = '';
    let usage: any = null;
    let aiError: string | null = null;

    try {
      console.log('[AI Suggestions] Calling OpenAI...', {
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
      } catch (parseError) {
        console.error('[AI Suggestions] Failed to parse AI response as JSON:', parseError);
        aiError = 'Failed to parse AI response as JSON';
      }
    } catch (openaiError: any) {
      console.error('[AI Suggestions] OpenAI API error:', openaiError);
      aiError = openaiError?.message || 'OpenAI API error';
    }

    const durationMs = Date.now() - startTime;

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

