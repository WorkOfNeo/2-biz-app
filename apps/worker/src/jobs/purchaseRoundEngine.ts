import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

type LogFn = (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;

// Format numbers in Danish style (1.000)
function formatDK(n: number): string {
  return new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 }).format(n);
}

interface PurchaseRoundPayload {
  seasonId: string;
  comparisonSeasonId?: string;
  purchaseRoundNumber?: number;
  purchaseRunId: string;
}

interface SupplierMaster {
  id: string;
  name: string;
  moq: number;
  lead_time_days: number;
  travel_time_days: number;
  active: boolean;
}

interface StyleColorSuggestion {
  style_no: string;
  style_name: string;
  color: string;
  sold_qty: number;
  open_po_qty: number;
  suggested_qty_total: number;
  sizes: string[];
  size_breakdown: number[];
  active_salespeople_count: number;
  rounding_step: number;
  reasoning?: string;
}

interface SupplierSuggestion {
  supplier: string;
  moq: number;
  lead_time_days: number;
  travel_time_days: number;
  total_qty: number;
  below_moq: boolean;
  moq_topped_up: boolean;
  moq_topup_reason?: string;
  sold_qty_total: number;
  priority?: 'high' | 'medium' | 'low';
  commentary?: string;
  flags?: string[];
  styles: StyleColorSuggestion[];
}

interface PurchaseRoundResult {
  success: boolean;
  purchase_stage: 'early' | 'mid' | 'closing';
  visit_rate_percent: number;
  supplier_suggestions: SupplierSuggestion[];
  prompt_key: string;
  prompt_version: number;
  model: string;
  ai_commentary?: any;
  error?: string;
}

// Stage-based multipliers
const STAGE_MULTIPLIERS = {
  early: { base: 1.4, perSalesperson: 0.05 }, // Aggressive: 140% + 5% per active salesperson
  mid: { base: 1.2, perSalesperson: 0.03 },   // Balanced: 120% + 3% per active salesperson
  closing: { base: 1.05, perSalesperson: 0.01 } // Conservative: 105% + 1% per active salesperson
};

function computePurchaseStage(visitRatePercent: number): 'early' | 'mid' | 'closing' {
  if (visitRatePercent < 40) return 'early';
  if (visitRatePercent < 75) return 'mid';
  return 'closing';
}

// Round value to nearest step (5 or 10)
function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

// Adaptive rounding: round each size bucket to nearest 5 or 10
// Returns { sizeBreakdown: number[], total: number, step: number }
function roundSizeBreakdownAdaptive(
  rawValues: number[], 
  targetTotal: number
): { sizeBreakdown: number[]; total: number; step: number } {
  // Choose step: < 50 units → round to 5s, otherwise → 10s
  const step = targetTotal < 50 ? 5 : 10;
  
  // Round each size to nearest step
  let rounded = rawValues.map(v => roundToStep(v, step));
  
  // Calculate new total
  let total = rounded.reduce((a, b) => a + b, 0);
  
  // Edge case: if rounding all to 0 but we had demand, bump the largest to step
  if (total === 0 && targetTotal > 0) {
    // Find the size with max original value
    let maxIdx = 0;
    let maxVal = rawValues[0] || 0;
    for (let i = 1; i < rawValues.length; i++) {
      const val = rawValues[i];
      if (val !== undefined && val > maxVal) {
        maxVal = val;
        maxIdx = i;
      }
    }
    if (rounded[maxIdx] !== undefined) {
      rounded[maxIdx] = step;
    }
    total = step;
  }
  
  return { sizeBreakdown: rounded, total, step };
}

// Legacy integer rounding helper (kept for any edge cases)
function roundPreservingSum(values: number[], targetSum: number): number[] {
  const floored = values.map(Math.floor);
  const remainder = targetSum - floored.reduce((a, b) => a + b, 0);
  
  // Get fractional parts and their indices
  const fractions = values.map((v, i) => ({ index: i, frac: v - Math.floor(v) }));
  fractions.sort((a, b) => b.frac - a.frac);
  
  // Add 1 to the top 'remainder' items
  for (let i = 0; i < remainder && i < fractions.length; i++) {
    const frac = fractions[i];
    if (frac !== undefined) {
      const idx = frac.index;
      const current = floored[idx];
      if (current !== undefined) {
        floored[idx] = current + 1;
      }
    }
  }
  
  return floored;
}

export async function runPurchaseRoundEngine(
  supabase: SupabaseClient,
  payload: PurchaseRoundPayload,
  log: LogFn
): Promise<PurchaseRoundResult> {
  const startTime = Date.now();
  const { seasonId, comparisonSeasonId, purchaseRoundNumber, purchaseRunId } = payload;

  try {
    await log('info', 'purchase_engine_start', { seasonId, purchaseRunId });

    // ========== STEP 1: Load Season + Customers ==========
    await log('info', 'loading_season_data');
    
    const { data: season } = await supabase
      .from('seasons')
      .select('id, name, year, start_sale, end_sale, latest_delivery')
      .eq('id', seasonId)
      .single();

    if (!season) throw new Error(`Season not found: ${seasonId}`);
    
    // Compute date context for AI
    const today = new Date();
    const seasonDates = {
      start_sale: season.start_sale || null,
      end_sale: season.end_sale || null,
      latest_delivery: season.latest_delivery || null,
      days_since_start: season.start_sale 
        ? Math.floor((today.getTime() - new Date(season.start_sale).getTime()) / (1000 * 60 * 60 * 24))
        : null,
      days_until_end: season.end_sale 
        ? Math.floor((new Date(season.end_sale).getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        : null,
      days_until_latest_delivery: season.latest_delivery 
        ? Math.floor((new Date(season.latest_delivery).getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        : null
    };

    const { data: customers } = await supabase
      .from('customers')
      .select('customer_id, salesperson_id')
      .limit(10000);

    const totalCustomers = customers?.length || 0;
    await log('info', 'season_loaded', { name: season.name, totalCustomers });

    // ========== STEP 2: Load Sales Stats + Style Details ==========
    await log('info', 'loading_sales_data');

    // Fetch sales_stats for this season
    const { data: salesStats } = await supabase
      .from('sales_stats')
      .select('account_no, qty, salesperson_id')
      .eq('season_id', seasonId);

    const visitedCustomers = new Set((salesStats || []).map(r => r.account_no).filter(Boolean)).size;
    const visitRatePercent = totalCustomers > 0 
      ? Math.round((visitedCustomers / totalCustomers) * 1000) / 10 
      : 0;

    const purchaseStage = computePurchaseStage(visitRatePercent);
    await log('info', 'stage_computed', { visitRatePercent, purchaseStage });

    // Build account -> salesperson map
    const accountSalesperson = new Map<string, string>();
    for (const row of salesStats || []) {
      if (row.account_no && row.salesperson_id) {
        accountSalesperson.set(row.account_no, row.salesperson_id);
      }
    }

    // Fetch style details with pagination
    let styleDetails: any[] = [];
    let from = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      await log('progress', 'loading_style_details', { from });
      const { data, error } = await supabase
        .from('sales_style_details_rows')
        .select('style_no, style_name, color, size, qty, account_no')
        .eq('season_id', seasonId)
        .range(from, from + PAGE_SIZE - 1);
      
      if (error) throw error;
      styleDetails.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    await log('info', 'style_details_loaded', { count: styleDetails.length });

    // ========== STEP 3: Load Styles + Suppliers ==========
    await log('info', 'loading_styles_and_suppliers');

    // Get unique style_nos
    const styleNos = Array.from(new Set(styleDetails.map(r => r.style_no).filter(Boolean)));

    // Fetch styles with supplier info
    const { data: styles } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier')
      .in('style_no', styleNos.slice(0, 1000)); // Limit to avoid query too large

    const styleSupplierMap = new Map<string, { supplier: string; style_name: string }>();
    for (const s of styles || []) {
      styleSupplierMap.set(s.style_no, { supplier: s.supplier || 'Unknown', style_name: s.style_name || '' });
    }

    // Fetch suppliers master
    const { data: suppliers } = await supabase
      .from('suppliers')
      .select('id, name, moq, lead_time_days, travel_time_days, active');

    const supplierMasterMap = new Map<string, SupplierMaster>();
    for (const s of suppliers || []) {
      supplierMasterMap.set(s.name.toLowerCase(), s as SupplierMaster);
    }

    await log('info', 'suppliers_loaded', { 
      stylesWithSupplier: styles?.length || 0, 
      suppliersMaster: suppliers?.length || 0 
    });

    // ========== STEP 4: Load Open POs (SPY + APP) ==========
    await log('info', 'loading_open_pos');

    // SPY POs: purchase_order_items joined with purchase_orders (Running/Shipped)
    const { data: openSpyPoItems } = await supabase
      .from('purchase_order_items')
      .select('style_no, color, qty, po_no');

    // Filter to only Running/Shipped POs
    const { data: openSpyPos } = await supabase
      .from('purchase_orders')
      .select('po_no, status')
      .in('status', ['Running', 'Shipped']);

    const openSpyPoNos = new Set((openSpyPos || []).map(p => p.po_no));
    
    // Build open PO totals by style+color
    const openPoTotals = new Map<string, number>();
    for (const item of openSpyPoItems || []) {
      if (!item.style_no || !openSpyPoNos.has(item.po_no)) continue;
      const key = `${item.style_no}|${(item.color || '').toLowerCase()}`;
      openPoTotals.set(key, (openPoTotals.get(key) || 0) + (item.qty || 0));
    }

    // APP POs: read meta.items from non-completed app_pos
    const { data: openAppPos } = await supabase
      .from('app_pos')
      .select('id, meta, status, confirmed')
      .in('status', ['Running', 'Shipped']);

    for (const appPo of openAppPos || []) {
      const items = appPo.meta?.items as any[] || [];
      for (const item of items) {
        if (!item.style_no) continue;
        const key = `${item.style_no}|${(item.color || '').toLowerCase()}`;
        openPoTotals.set(key, (openPoTotals.get(key) || 0) + (item.total || 0));
      }
    }

    await log('info', 'open_pos_loaded', { 
      spyPoItems: openSpyPoItems?.length || 0, 
      appPos: openAppPos?.length || 0,
      uniqueStyleColors: openPoTotals.size
    });

    // ========== STEP 5: Aggregate Sales by Style+Color with Size Mix ==========
    await log('info', 'aggregating_sales');

    type StyleColorData = {
      style_no: string;
      style_name: string;
      color: string;
      total_qty: number;
      salespeople: Set<string>;
      sizeMix: Map<string, number>; // size -> qty
    };

    const styleColorAgg = new Map<string, StyleColorData>();
    
    for (const row of styleDetails) {
      if (!row.style_no || !row.color) continue;
      const key = `${row.style_no}|${row.color.toLowerCase()}`;
      
      if (!styleColorAgg.has(key)) {
        const styleMeta = styleSupplierMap.get(row.style_no);
        styleColorAgg.set(key, {
          style_no: row.style_no,
          style_name: styleMeta?.style_name || row.style_name || row.style_no,
          color: row.color,
          total_qty: 0,
          salespeople: new Set(),
          sizeMix: new Map()
        });
      }
      
      const agg = styleColorAgg.get(key)!;
      agg.total_qty += Number(row.qty) || 0;
      
      // Track salesperson for this style
      if (row.account_no) {
        const spId = accountSalesperson.get(row.account_no);
        if (spId) agg.salespeople.add(spId);
      }
      
      // Track size mix
      if (row.size) {
        agg.sizeMix.set(row.size, (agg.sizeMix.get(row.size) || 0) + (Number(row.qty) || 0));
      }
    }

    await log('info', 'sales_aggregated', { uniqueStyleColors: styleColorAgg.size });

    // ========== STEP 6: Calculate Recommendations by Supplier ==========
    await log('info', 'calculating_recommendations');

    const stageConfig = STAGE_MULTIPLIERS[purchaseStage];
    
    // Group by supplier
    const bySupplier = new Map<string, StyleColorSuggestion[]>();
    let unmatchedSuppliers = new Set<string>();

    for (const [key, data] of styleColorAgg) {
      const styleMeta = styleSupplierMap.get(data.style_no);
      const supplierName = styleMeta?.supplier || 'Unknown';
      
      if (!bySupplier.has(supplierName)) {
        bySupplier.set(supplierName, []);
      }

      // Calculate target multiplier
      const activeSalesCount = data.salespeople.size;
      const multiplier = stageConfig.base + (activeSalesCount * stageConfig.perSalesperson);
      
      // Base recommended qty
      const targetQty = Math.ceil(data.total_qty * multiplier);
      
      // Subtract open POs
      const openQty = openPoTotals.get(key) || 0;
      const recommendedQty = Math.max(0, targetQty - openQty);
      
      // Skip if nothing to recommend
      if (recommendedQty === 0 && data.total_qty === 0) continue;

      // Calculate size breakdown with adaptive rounding (5 or 10)
      const sizes = Array.from(data.sizeMix.keys()).sort();
      let sizeBreakdown: number[] = [];
      let finalQty = recommendedQty;
      let roundingStep = 5; // default
      
      if (sizes.length > 0 && recommendedQty > 0) {
        const totalMixQty = Array.from(data.sizeMix.values()).reduce((a, b) => a + b, 0);
        if (totalMixQty > 0) {
          // Calculate raw breakdown based on size mix proportions
          const rawBreakdown = sizes.map(size => {
            const mixQty = data.sizeMix.get(size) || 0;
            return (mixQty / totalMixQty) * recommendedQty;
          });
          
          // Apply adaptive rounding (5 or 10 based on total)
          const roundResult = roundSizeBreakdownAdaptive(rawBreakdown, recommendedQty);
          sizeBreakdown = roundResult.sizeBreakdown;
          finalQty = roundResult.total; // total now matches sum of rounded sizes
          roundingStep = roundResult.step;
        } else {
          // Equal split if no size data, then round
          const perSize = recommendedQty / sizes.length;
          const rawBreakdown = sizes.map(() => perSize);
          const roundResult = roundSizeBreakdownAdaptive(rawBreakdown, recommendedQty);
          sizeBreakdown = roundResult.sizeBreakdown;
          finalQty = roundResult.total;
          roundingStep = roundResult.step;
        }
      } else if (recommendedQty > 0) {
        // No sizes known - round the total to step
        roundingStep = recommendedQty < 50 ? 5 : 10;
        finalQty = roundToStep(recommendedQty, roundingStep);
        if (finalQty === 0 && recommendedQty > 0) finalQty = roundingStep;
      }

      // Check if supplier is in master
      const supplierLower = supplierName.toLowerCase();
      if (!supplierMasterMap.has(supplierLower) && supplierName !== 'Unknown') {
        unmatchedSuppliers.add(supplierName);
      }

      // Generate detailed reasoning for this style
      let reasoning: string;
      if (finalQty > 0) {
        // Explain the multiplier choice
        const stageNames = { early: 'tidligt', mid: 'midt', closing: 'sent' };
        const stageName = stageNames[purchaseStage];
        const multiplierExplanation = `x${multiplier.toFixed(2)} (${stageName} stadie${activeSalesCount > 0 ? ` + ${activeSalesCount} aktiv sælger${activeSalesCount > 1 ? 'e' : ''}` : ''})`;
        
        // Explain the math
        const mathParts = [`Solgt: ${formatDK(data.total_qty)} stk`];
        if (openQty > 0) {
          mathParts.push(`Åbne PO: ${formatDK(openQty)} stk`);
        }
        mathParts.push(`Mål: ${formatDK(targetQty)} ${multiplierExplanation}`);
        if (openQty > 0) {
          mathParts.push(`Netto: ${formatDK(targetQty - openQty)}`);
        }
        mathParts.push(`Afrundet til ${roundingStep}: ${formatDK(finalQty)} stk`);
        
        reasoning = mathParts.join(' → ');
      } else {
        reasoning = `Ingen køb nødvendig – allerede dækket af ${formatDK(openQty)} stk i åbne PO'er.`;
      }

      bySupplier.get(supplierName)!.push({
        style_no: data.style_no,
        style_name: data.style_name,
        color: data.color,
        sold_qty: data.total_qty,
        open_po_qty: openQty,
        suggested_qty_total: finalQty,
        sizes,
        size_breakdown: sizeBreakdown,
        active_salespeople_count: activeSalesCount,
        rounding_step: roundingStep,
        reasoning
      });
    }

    if (unmatchedSuppliers.size > 0) {
      await log('info', 'unmatched_suppliers', { suppliers: Array.from(unmatchedSuppliers) });
    }

    // Build supplier suggestions with MOQ check and safe top-up
    const supplierSuggestions: SupplierSuggestion[] = [];
    
    for (const [supplierName, styles] of bySupplier) {
      const supplierMaster = supplierMasterMap.get(supplierName.toLowerCase());
      let totalQty = styles.reduce((sum, s) => sum + s.suggested_qty_total, 0);
      const soldQtyTotal = styles.reduce((sum, s) => sum + s.sold_qty, 0);
      const moq = supplierMaster?.moq || 0;
      let belowMoq = totalQty > 0 && totalQty < moq;
      let moqToppedUp = false;
      let moqTopupReason: string | undefined = undefined;

      // Filter out styles with 0 recommended qty for cleaner output
      let activeStyles = styles.filter(s => s.suggested_qty_total > 0);
      
      if (activeStyles.length === 0 && totalQty === 0) continue;

      // MOQ safe top-up logic
      if (belowMoq && moq > 0) {
        // Determine if top-up is "safe" based on sold qty
        // EARLY: more permissive (allow if sold * 1.25 >= moq)
        // MID/CLOSING: require sold >= moq
        const safeMultiplier = purchaseStage === 'early' ? 1.25 : 1.0;
        const isSafeToTopUp = soldQtyTotal * safeMultiplier >= moq;
        
        if (isSafeToTopUp) {
          // Top up to MOQ by distributing extra units across top-selling styles
          const deficit = moq - totalQty;
          
          // Sort active styles by sold_qty descending
          const sortedStyles = [...activeStyles].sort((a, b) => b.sold_qty - a.sold_qty);
          
          // Distribute deficit proportionally based on sold_qty
          const totalSold = sortedStyles.reduce((s, st) => s + st.sold_qty, 0);
          let remaining = deficit;
          
          if (totalSold > 0) {
            for (const style of sortedStyles) {
              if (remaining <= 0) break;
              // Proportional share rounded to the style's rounding step
              const share = Math.round((style.sold_qty / totalSold) * deficit);
              const step = style.rounding_step || 5;
              const roundedShare = roundToStep(share, step);
              
              if (roundedShare > 0) {
                style.suggested_qty_total += roundedShare;
                // Also update size breakdown proportionally
                if (style.size_breakdown.length > 0) {
                  const sizeTotal = style.size_breakdown.reduce((a, b) => a + b, 0);
                  if (sizeTotal > 0) {
                    for (let i = 0; i < style.size_breakdown.length; i++) {
                      const sizeCurrent = style.size_breakdown[i];
                      if (sizeCurrent !== undefined) {
                        const sizeShare = Math.round((sizeCurrent / sizeTotal) * roundedShare);
                        style.size_breakdown[i] = sizeCurrent + roundToStep(sizeShare, step);
                      }
                    }
                    // Recalc total from size breakdown
                    style.suggested_qty_total = style.size_breakdown.reduce((a, b) => a + b, 0);
                  }
                }
                remaining -= roundedShare;
                style.reasoning = (style.reasoning || '') + ` | +${formatDK(roundedShare)} stk tilføjet for at nå MOQ.`;
              }
            }
          } else {
            // No sold data - just add to the first style
            const firstStyle = sortedStyles[0];
            if (firstStyle) {
              const step = firstStyle.rounding_step || 5;
              const roundedDeficit = roundToStep(deficit, step);
              firstStyle.suggested_qty_total += roundedDeficit;
              firstStyle.reasoning = (firstStyle.reasoning || '') + ` | +${formatDK(roundedDeficit)} stk tilføjet for at nå MOQ.`;
            }
          }
          
          // Recalculate total and update flags
          totalQty = activeStyles.reduce((s, st) => s + st.suggested_qty_total, 0);
          belowMoq = totalQty < moq; // Should now be false
          moqToppedUp = true;
          moqTopupReason = `Topped up from ${totalQty - deficit} to ${totalQty} to meet MOQ (${moq})`;
        } else {
          // Not safe to top up - add flag
          if (purchaseStage === 'early') {
            moqTopupReason = `Under MOQ (${totalQty}/${moq}). Salg (${soldQtyTotal}) er for lavt til sikker top-up i early stage.`;
          } else {
            moqTopupReason = `Under MOQ (${totalQty}/${moq}). Overvej om det er værd at købe.`;
          }
        }
      }

      supplierSuggestions.push({
        supplier: supplierName,
        moq: moq,
        lead_time_days: supplierMaster?.lead_time_days || 0,
        travel_time_days: supplierMaster?.travel_time_days || 0,
        total_qty: totalQty,
        below_moq: belowMoq,
        moq_topped_up: moqToppedUp,
        moq_topup_reason: moqTopupReason,
        sold_qty_total: soldQtyTotal,
        styles: activeStyles.length > 0 ? activeStyles : styles.slice(0, 5)
      });
    }

    // Sort by total qty descending
    supplierSuggestions.sort((a, b) => b.total_qty - a.total_qty);

    await log('info', 'recommendations_calculated', { 
      supplierCount: supplierSuggestions.length,
      totalUnits: supplierSuggestions.reduce((s, sup) => s + sup.total_qty, 0),
      belowMoqCount: supplierSuggestions.filter(s => s.below_moq).length,
      moqToppedUpCount: supplierSuggestions.filter(s => s.moq_topped_up).length
    });

    // ========== STEP 7: Call LLM for Commentary ==========
    await log('info', 'calling_ai_for_commentary');

    const openaiApiKey = process.env.OPENAI_API_KEY;
    let aiCommentary: any = null;
    let promptKey = `purchase_round_${purchaseStage}_v1`;
    let promptVersion = 1;
    let model = 'gpt-4o-mini';

    if (openaiApiKey) {
      // Try to load prompt from DB
      const { data: dbPrompt } = await supabase
        .from('ai_prompts')
        .select('key, version, content, model, temperature, max_tokens')
        .eq('key', promptKey)
        .eq('active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      const promptContent = dbPrompt?.content || getDefaultStagePrompt(purchaseStage);
      model = dbPrompt?.model || 'gpt-4o-mini';
      promptVersion = dbPrompt?.version || 1;

      // Prepare data for LLM
      const purchaseData = {
        season: season.name,
        season_year: season.year,
        purchase_stage: purchaseStage,
        visit_rate_percent: visitRatePercent,
        total_recommended_units: supplierSuggestions.reduce((s, sup) => s + sup.total_qty, 0),
        // Season timing context
        season_start_sale: seasonDates.start_sale,
        season_end_sale: seasonDates.end_sale,
        season_latest_delivery: seasonDates.latest_delivery,
        days_since_start_sale: seasonDates.days_since_start,
        days_until_end_sale: seasonDates.days_until_end,
        days_until_latest_delivery: seasonDates.days_until_latest_delivery,
        // Supplier data with MOQ details
        suppliers: supplierSuggestions.map(s => ({
          name: s.supplier,
          total_qty: s.total_qty,
          sold_qty: s.sold_qty_total,
          moq: s.moq,
          below_moq: s.below_moq,
          moq_topped_up: s.moq_topped_up,
          moq_topup_reason: s.moq_topup_reason,
          lead_time_days: s.lead_time_days,
          travel_time_days: s.travel_time_days,
          style_count: s.styles.length,
          top_styles: s.styles.slice(0, 3).map(st => ({
            style_name: st.style_name,
            sold: st.sold_qty,
            recommended: st.suggested_qty_total
          }))
        }))
      };

      const userMessage = promptContent.replace('{{purchase_data}}', JSON.stringify(purchaseData, null, 2));

      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const completion = await openai.chat.completions.create({
          model,
          max_tokens: 2000,
          messages: [
            { role: 'user', content: userMessage }
          ],
          response_format: { type: 'json_object' }
        });

        const rawResponse = completion.choices[0]?.message?.content || '{}';
        aiCommentary = JSON.parse(rawResponse);

        // Merge AI commentary into supplier suggestions
        if (aiCommentary?.suppliers) {
          for (const aiSup of aiCommentary.suppliers) {
            const match = supplierSuggestions.find(
              s => s.supplier.toLowerCase() === aiSup.name?.toLowerCase()
            );
            if (match) {
              match.priority = aiSup.priority;
              match.commentary = aiSup.commentary;
              match.flags = aiSup.flags;
            }
          }
        }

        await log('info', 'ai_commentary_received', { 
          suppliers: aiCommentary?.suppliers?.length || 0 
        });
      } catch (e: any) {
        await log('error', 'ai_commentary_failed', { error: e.message });
      }
    }

    // ========== STEP 8: Persist Results ==========
    await log('info', 'persisting_results');

    // Update purchase_ai_runs
    const { error: updateError } = await supabase
      .from('purchase_ai_runs')
      .update({
        status: 'reviewing',
        purchase_stage: purchaseStage,
        prompt_key: promptKey,
        prompt_version: promptVersion,
        model: model,
        supplier_suggestions: supplierSuggestions,
        run_completed_at: new Date().toISOString(),
        computed_features_snapshot: {
          visit_rate_percent: visitRatePercent,
          total_customers: totalCustomers,
          visited_customers: visitedCustomers,
          stage_multipliers: stageConfig,
          open_po_totals_count: openPoTotals.size,
          ai_commentary: aiCommentary
        }
      })
      .eq('id', purchaseRunId);

    if (updateError) {
      throw new Error(`Failed to update purchase run: ${updateError.message}`);
    }

    const durationMs = Date.now() - startTime;
    await log('info', 'purchase_engine_complete', { 
      purchaseRunId,
      purchaseStage,
      supplierCount: supplierSuggestions.length,
      totalUnits: supplierSuggestions.reduce((s, sup) => s + sup.total_qty, 0),
      durationMs
    });

    return {
      success: true,
      purchase_stage: purchaseStage,
      visit_rate_percent: visitRatePercent,
      supplier_suggestions: supplierSuggestions,
      prompt_key: promptKey,
      prompt_version: promptVersion,
      model: model,
      ai_commentary: aiCommentary
    };

  } catch (e: any) {
    await log('error', 'purchase_engine_failed', { error: e?.message || String(e) });
    return {
      success: false,
      purchase_stage: 'early',
      visit_rate_percent: 0,
      supplier_suggestions: [],
      prompt_key: '',
      prompt_version: 0,
      model: '',
      error: e?.message || 'Purchase engine failed'
    };
  }
}

// Default prompts if not in DB
function getDefaultStagePrompt(stage: 'early' | 'mid' | 'closing'): string {
  const stageDescriptions = {
    early: 'EARLY (under 40% besøgt) - Aggressiv strategi',
    mid: 'MID (40-75% besøgt) - Balanceret strategi',
    closing: 'CLOSING (over 75% besøgt) - Konservativ strategi'
  };

  return `Du er en indkøbsrådgiver for 2-BIZ, en dansk mode-grossist.

## INDKØBS-STADIE: ${stageDescriptions[stage]}

## DIN OPGAVE
Analyser de beregnede indkøbsforslag og giv kommentarer per leverandør.
VIGTIGT: Du skal IKKE ændre mængderne - de er beregnet deterministisk.
Din rolle er at give prioritering, risiko-flags og kommentarer.

## INPUT DATA
{{purchase_data}}

## OUTPUT FORMAT (valid JSON):
{
  "suppliers": [
    {
      "name": "leverandør navn",
      "priority": "high" | "medium" | "low",
      "commentary": "Kort kommentar på dansk (max 2 sætninger)",
      "flags": []
    }
  ],
  "overall_summary": "Kort opsummering (1-2 sætninger)",
  "warnings": []
}`;
}
