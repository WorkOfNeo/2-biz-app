import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

type LogFn = (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;

// Format numbers in Danish style (1.000)
function formatDK(n: number): string {
  return new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 }).format(n);
}

// Size sorting order for letter sizes and combo sizes
const SIZE_ORDER: Record<string, number> = {
  'XXS': 1, 'XS': 2, 'S': 3, 'M': 4, 'L': 5, 'XL': 6, 'XXL': 7, 'XXXL': 8, '3XL': 8, '4XL': 9, '5XL': 10,
  // Combo sizes
  'XS/S': 2.5, 'S/M': 3.5, 'M/L': 4.5, 'L/XL': 5.5, 'XL/XXL': 6.5,
  // One size
  'ONE SIZE': 50, 'OS': 50, 'ONESIZE': 50,
};

// Sort sizes correctly: XS/S/M/L/XL/XXL, 34-48 numeric, and combo sizes
function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const aUpper = a.toUpperCase().trim();
    const bUpper = b.toUpperCase().trim();
    
    // Check if both are letter sizes
    const aOrder = SIZE_ORDER[aUpper];
    const bOrder = SIZE_ORDER[bUpper];
    
    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    
    // Check if both are numeric (34, 36, 38, etc.)
    const aNum = parseInt(aUpper, 10);
    const bNum = parseInt(bUpper, 10);
    
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return aNum - bNum;
    }
    
    // Letter sizes come before numeric
    if (aOrder !== undefined && !isNaN(bNum)) return -1;
    if (!isNaN(aNum) && bOrder !== undefined) return 1;
    
    // Fallback to alphabetical
    return aUpper.localeCompare(bUpper);
  });
}

interface PurchaseRoundPayload {
  seasonId: string;
  comparisonSeasonId?: string;
  purchaseRoundNumber?: number;
  purchaseRunId: string;
  ignoreOpenPOs?: boolean; // If true, don't subtract open PO quantities from suggestions
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
  current_stock: number;
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
  decision?: 'buy' | 'skip' | 'wait';
  days_until_must_order?: number | null;
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

// AI response types
interface AIStyleDecision {
  style_no: string;
  color: string;
  recommended_qty: number;
  size_breakdown: Record<string, number>;
  reasoning: string;
}

interface AISupplierDecision {
  supplier: string;
  decision: 'buy' | 'skip' | 'wait';
  reasoning: string;
  days_until_must_order: number | null;
  moq_status: 'met' | 'below' | 'not_applicable';
  total_qty: number;
  styles: AIStyleDecision[];
  flags: string[];
}

function computePurchaseStage(visitRatePercent: number): 'early' | 'mid' | 'closing' {
  if (visitRatePercent < 40) return 'early';
  if (visitRatePercent < 75) return 'mid';
  return 'closing';
}

// Round value to nearest step (5 or 10)
function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

// Validate and fix AI response for a supplier
function validateAndFixAIDecision(
  aiDecision: AISupplierDecision,
  inputStyles: Map<string, { sizes: string[]; sold_qty: number; open_po_qty: number; current_stock: number; style_name: string; active_salespeople: number }>,
  moq: number,
  log: (msg: string, data?: any) => void
): { styles: StyleColorSuggestion[]; totalQty: number; corrections: string[] } {
  const corrections: string[] = [];
  const resultStyles: StyleColorSuggestion[] = [];
  let totalQty = 0;

  for (const aiStyle of aiDecision.styles || []) {
    const key = `${aiStyle.style_no}|${(aiStyle.color || '').toLowerCase()}`;
    const inputData = inputStyles.get(key);
    
    if (!inputData) {
      corrections.push(`AI returned unknown style ${aiStyle.style_no}/${aiStyle.color}, skipping`);
      continue;
    }

    // Validate and fix quantity
    let qty = Math.max(0, Math.round(aiStyle.recommended_qty || 0));
    
    // Apply rounding
    const step = qty >= 50 ? 10 : 5;
    qty = roundToStep(qty, step);

    // Get sorted sizes from input
    const sizes = sortSizes(inputData.sizes);
    
    // Validate size breakdown
    let sizeBreakdown: number[] = [];
    if (aiStyle.size_breakdown && Object.keys(aiStyle.size_breakdown).length > 0) {
      // Map AI breakdown to our ordered sizes array
      sizeBreakdown = sizes.map(size => {
        const val = aiStyle.size_breakdown[size] || aiStyle.size_breakdown[size.toUpperCase()] || 
                    aiStyle.size_breakdown[size.toLowerCase()] || 0;
        return roundToStep(Math.max(0, Math.round(val)), step);
      });
      
      // Ensure sum matches qty
      const sizeSum = sizeBreakdown.reduce((a, b) => a + b, 0);
      if (sizeSum !== qty) {
        corrections.push(`${aiStyle.style_no}/${aiStyle.color}: size sum ${sizeSum} != ${qty}, adjusting`);
        
        // If sum is 0 but qty > 0, distribute evenly
        if (sizeSum === 0 && qty > 0 && sizes.length > 0) {
          const perSize = Math.floor(qty / sizes.length);
          sizeBreakdown = sizes.map((_, i) => i === 0 ? qty - (perSize * (sizes.length - 1)) : perSize);
          sizeBreakdown = sizeBreakdown.map(v => roundToStep(v, step));
          qty = sizeBreakdown.reduce((a, b) => a + b, 0);
        } else {
          // Adjust qty to match sum of rounded sizes
          qty = sizeSum;
        }
      }
    } else if (qty > 0 && sizes.length > 0) {
      // AI didn't provide breakdown, distribute evenly
      corrections.push(`${aiStyle.style_no}/${aiStyle.color}: no size breakdown, distributing evenly`);
      const perSize = Math.floor(qty / sizes.length);
      sizeBreakdown = sizes.map((_, i) => i === 0 ? qty - (perSize * (sizes.length - 1)) : perSize);
      sizeBreakdown = sizeBreakdown.map(v => roundToStep(v, step));
      qty = sizeBreakdown.reduce((a, b) => a + b, 0);
    }

    resultStyles.push({
      style_no: aiStyle.style_no,
      style_name: inputData.style_name,
      color: aiStyle.color,
      sold_qty: inputData.sold_qty,
      open_po_qty: inputData.open_po_qty,
      current_stock: inputData.current_stock,
      suggested_qty_total: qty,
      sizes,
      size_breakdown: sizeBreakdown,
      active_salespeople_count: inputData.active_salespeople,
      rounding_step: step,
      reasoning: aiStyle.reasoning || ''
    });

    totalQty += qty;
  }

  // Check MOQ
  if (aiDecision.decision === 'buy' && totalQty < moq && moq > 0) {
    corrections.push(`AI said buy but total ${totalQty} < MOQ ${moq}`);
  }

  return { styles: resultStyles, totalQty, corrections };
}

export async function runPurchaseRoundEngine(
  supabase: SupabaseClient,
  payload: PurchaseRoundPayload,
  log: LogFn
): Promise<PurchaseRoundResult> {
  const startTime = Date.now();
  const { seasonId, purchaseRunId } = payload;

  try {
    await log('info', 'PURCHASE_ENGINE_START', { seasonId, purchaseRunId });

    // ========== STEP 1: Load Season + Customers ==========
    await log('info', 'STEP_1_LOAD_SEASON');
    
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
    
    // Get unique salespeople from customers (total active salespeople)
    const allSalespersonIds = new Set((customers || []).map(c => c.salesperson_id).filter(Boolean));
    const totalSalespeople = allSalespersonIds.size;
    
    await log('info', 'SEASON_LOADED', { name: season.name, totalCustomers, totalSalespeople, seasonDates });

    // ========== STEP 2: Load Sales Stats + Style Details ==========
    await log('info', 'STEP_2_LOAD_SALES');

    const { data: salesStats } = await supabase
      .from('sales_stats')
      .select('account_no, qty, salesperson_id')
      .eq('season_id', seasonId);

    const visitedCustomers = new Set((salesStats || []).map(r => r.account_no).filter(Boolean)).size;
    const visitRatePercent = totalCustomers > 0 
      ? Math.round((visitedCustomers / totalCustomers) * 1000) / 10 
      : 0;
    const remainingCustomers = totalCustomers - visitedCustomers;
    const remainingPotentialPercent = Math.round((100 - visitRatePercent) * 10) / 10;

    // Salespeople who have made sales this season
    const activeSalespersonIds = new Set((salesStats || []).map(r => r.salesperson_id).filter(Boolean));
    const activeSalespeople = activeSalespersonIds.size;

    const purchaseStage = computePurchaseStage(visitRatePercent);
    await log('info', 'STAGE_COMPUTED', { 
      visitRatePercent, 
      purchaseStage, 
      visitedCustomers, 
      totalCustomers,
      remainingCustomers,
      activeSalespeople,
      totalSalespeople
    });

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
      await log('progress', 'LOADING_STYLE_DETAILS', { from });
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
    await log('info', 'STYLE_DETAILS_LOADED', { count: styleDetails.length });

    // ========== STEP 3: Load Styles + Suppliers ==========
    await log('info', 'STEP_3_LOAD_SUPPLIERS');

    const styleNos = Array.from(new Set(styleDetails.map(r => r.style_no).filter(Boolean)));

    const { data: styles } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier')
      .in('style_no', styleNos.slice(0, 1000));

    const styleSupplierMap = new Map<string, { supplier: string; style_name: string }>();
    for (const s of styles || []) {
      styleSupplierMap.set(s.style_no, { supplier: s.supplier || 'Unknown', style_name: s.style_name || '' });
    }

    const { data: suppliers } = await supabase
      .from('suppliers')
      .select('id, name, moq, lead_time_days, travel_time_days, active');

    const supplierMasterMap = new Map<string, SupplierMaster>();
    for (const s of suppliers || []) {
      supplierMasterMap.set(s.name.toLowerCase(), s as SupplierMaster);
    }

    await log('info', 'SUPPLIERS_LOADED', { 
      stylesWithSupplier: styles?.length || 0, 
      suppliersMaster: suppliers?.length || 0 
    });

    // ========== STEP 4: Load Open POs (SPY + APP) ==========
    const openPoTotals = new Map<string, number>();
    
    // Check if we should ignore open POs
    const ignoreOpenPOs = payload.ignoreOpenPOs === true;
    
    if (ignoreOpenPOs) {
      await log('info', 'STEP_4_SKIP_OPEN_POS', { 
        reason: 'ignoreOpenPOs flag is set - not subtracting open PO quantities' 
      });
    } else {
      await log('info', 'STEP_4_LOAD_OPEN_POS');

      const { data: openSpyPoItems } = await supabase
        .from('purchase_order_items')
        .select('style_no, color, qty, po_no');

      const { data: openSpyPos } = await supabase
        .from('purchase_orders')
        .select('po_no, status')
        .in('status', ['Running', 'Shipped']);

      const openSpyPoNos = new Set((openSpyPos || []).map(p => p.po_no));
      
      for (const item of openSpyPoItems || []) {
        if (!item.style_no || !openSpyPoNos.has(item.po_no)) continue;
        const key = `${item.style_no}|${(item.color || '').toLowerCase()}`;
        openPoTotals.set(key, (openPoTotals.get(key) || 0) + (item.qty || 0));
      }

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

      await log('info', 'OPEN_POS_LOADED', { 
        spyPoItems: openSpyPoItems?.length || 0, 
        appPos: openAppPos?.length || 0,
        uniqueStyleColors: openPoTotals.size
      });
    }

    // ========== STEP 4.5: Load Current Stock Levels ==========
    await log('info', 'STEP_4_5_LOAD_STOCK');

    // Fetch stock levels from style_stock (section = 'Stock', row_label = 'Total sold' or null for current stock)
    const { data: stockRows } = await supabase
      .from('style_stock')
      .select('style_no, color, section, row_label, values')
      .in('style_no', styleNos.slice(0, 1000))
      .eq('section', 'Stock');

    // Build stock totals by style+color (sum of all stock values)
    const currentStockTotals = new Map<string, number>();
    for (const row of stockRows || []) {
      if (!row.style_no || !row.color) continue;
      const key = `${row.style_no}|${(row.color || '').toLowerCase()}`;
      // Values is an array of numbers per size, sum them for total stock
      const values = Array.isArray(row.values) ? row.values : [];
      const total = values.reduce((sum: number, v: any) => sum + (Number(v) || 0), 0);
      currentStockTotals.set(key, (currentStockTotals.get(key) || 0) + total);
    }

    await log('info', 'STOCK_LOADED', { 
      stockRowsCount: stockRows?.length || 0,
      uniqueStyleColorsWithStock: currentStockTotals.size
    });

    // ========== STEP 5: Aggregate Sales by Style+Color with Size Mix ==========
    await log('info', 'STEP_5_AGGREGATE_SALES');

    type StyleColorData = {
      style_no: string;
      style_name: string;
      color: string;
      total_qty: number;
      salespeople: Set<string>;
      sizeMix: Map<string, number>;
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
      
      if (row.account_no) {
        const spId = accountSalesperson.get(row.account_no);
        if (spId) agg.salespeople.add(spId);
      }
      
      if (row.size) {
        agg.sizeMix.set(row.size, (agg.sizeMix.get(row.size) || 0) + (Number(row.qty) || 0));
      }
    }

    await log('info', 'SALES_AGGREGATED', { uniqueStyleColors: styleColorAgg.size });

    // ========== STEP 6: Group by Supplier and Prepare AI Context ==========
    await log('info', 'STEP_6_GROUP_BY_SUPPLIER');

    type SupplierStyleData = {
      style_no: string;
      style_name: string;
      color: string;
      sold_qty: number;
      open_po_qty: number;
      current_stock: number;
      sizes: string[];
      size_distribution: Record<string, number>;
      active_salespeople: number;
    };

    const bySupplier = new Map<string, SupplierStyleData[]>();
    let zeroStockCount = 0;
    let missingStockRowCount = 0;
    
    for (const [key, data] of styleColorAgg) {
      const styleMeta = styleSupplierMap.get(data.style_no);
      const supplierName = styleMeta?.supplier || 'Unknown';
      
      const openQty = openPoTotals.get(key) || 0;
      const hasStockRow = currentStockTotals.has(key);
      const currentStock = currentStockTotals.get(key) || 0;
      
      // Track diagnostics (but don't skip - zero stock styles often need buying!)
      if (!hasStockRow) {
        missingStockRowCount++;
      } else if (currentStock === 0) {
        zeroStockCount++;
      }
      
      if (!bySupplier.has(supplierName)) {
        bySupplier.set(supplierName, []);
      }

      const sizes = sortSizes(Array.from(data.sizeMix.keys()));
      
      // Build size distribution as percentages
      const totalMixQty = Array.from(data.sizeMix.values()).reduce((a, b) => a + b, 0);
      const sizeDistribution: Record<string, number> = {};
      for (const [size, qty] of data.sizeMix) {
        sizeDistribution[size] = totalMixQty > 0 ? Math.round((qty / totalMixQty) * 100) : 0;
      }

      bySupplier.get(supplierName)!.push({
        style_no: data.style_no,
        style_name: data.style_name,
        color: data.color,
        sold_qty: data.total_qty,
        open_po_qty: openQty,
        current_stock: currentStock,
        sizes,
        size_distribution: sizeDistribution,
        active_salespeople: data.salespeople.size
      });
    }

    await log('info', 'GROUPED_BY_SUPPLIER', { 
      supplierCount: bySupplier.size,
      totalStyleColors: styleColorAgg.size,
      zeroStockCount,
      missingStockRowCount
    });

    // ========== STEP 6.5: Load Historical Feedback for Learning ==========
    await log('info', 'STEP_6_5_LOAD_FEEDBACK');
    
    // Get all style_no + color combinations we're processing
    const allStyleColorKeys = Array.from(styleColorAgg.keys());
    const styleNosForFeedback = Array.from(new Set(allStyleColorKeys.map(k => k.split('|')[0])));
    
    // Load recent feedback from previous purchase rounds (same season)
    const { data: historicalFeedback } = await supabase
      .from('purchase_ai_line_feedback')
      .select('style_no, color, suggested_qty, adjusted_qty, verdict, created_at')
      .eq('season_id', seasonId)
      .in('style_no', styleNosForFeedback.slice(0, 500))
      .order('created_at', { ascending: false });
    
    // Build feedback map: key -> { suggested, adjusted, verdict, adjustment_ratio }
    type FeedbackEntry = { 
      suggested: number; 
      adjusted: number | null; 
      verdict: string;
      adjustment_ratio: number | null;
    };
    const feedbackMap = new Map<string, FeedbackEntry>();
    
    for (const fb of historicalFeedback || []) {
      const key = `${fb.style_no}|${(fb.color || '').toLowerCase()}`;
      // Only keep the most recent feedback per style/color
      if (!feedbackMap.has(key)) {
        const adjustmentRatio = fb.adjusted_qty && fb.suggested_qty > 0 
          ? Math.round((fb.adjusted_qty / fb.suggested_qty) * 100) / 100
          : null;
        feedbackMap.set(key, {
          suggested: fb.suggested_qty,
          adjusted: fb.adjusted_qty,
          verdict: fb.verdict,
          adjustment_ratio: adjustmentRatio
        });
      }
    }
    
    // Calculate overall adjustment trend (how much does user typically adjust?)
    const adjustedEntries = Array.from(feedbackMap.values()).filter(f => f.adjusted !== null && f.suggested > 0);
    const avgAdjustmentRatio = adjustedEntries.length > 0
      ? Math.round((adjustedEntries.reduce((sum, f) => sum + (f.adjustment_ratio || 1), 0) / adjustedEntries.length) * 100) / 100
      : null;
    
    await log('info', 'FEEDBACK_LOADED', { 
      feedbackCount: feedbackMap.size,
      adjustedCount: adjustedEntries.length,
      avgAdjustmentRatio
    });

    // ========== STEP 7: Call AI for Each Supplier ==========
    await log('info', 'STEP_7_AI_DECISIONS');

    const openaiApiKey = process.env.OPENAI_API_KEY;
    const supplierSuggestions: SupplierSuggestion[] = [];
    
    let promptKey = 'purchase_decision_per_supplier_v1';
    let promptVersion = 1;
    let model = 'gpt-4o';

    // Load prompt from DB
    const { data: dbPrompt } = await supabase
      .from('ai_prompts')
      .select('key, version, content, model, temperature, max_tokens')
      .eq('key', promptKey)
      .eq('active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const promptTemplate = dbPrompt?.content || '';
    model = dbPrompt?.model || 'gpt-4o';
    promptVersion = dbPrompt?.version || 1;

    if (!openaiApiKey || !promptTemplate) {
      await log('error', 'AI_CONFIG_MISSING', { hasApiKey: !!openaiApiKey, hasPrompt: !!promptTemplate });
      throw new Error('Missing OpenAI API key or prompt template');
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Process suppliers in parallel (batches of 3 to avoid rate limits)
    const supplierEntries = Array.from(bySupplier.entries());
    const BATCH_SIZE = 3;

    for (let batchStart = 0; batchStart < supplierEntries.length; batchStart += BATCH_SIZE) {
      const batch = supplierEntries.slice(batchStart, batchStart + BATCH_SIZE);
      
      await log('progress', 'AI_BATCH_PROCESSING', { 
        batch: Math.floor(batchStart / BATCH_SIZE) + 1, 
        total: Math.ceil(supplierEntries.length / BATCH_SIZE),
        suppliers: batch.map(([name]) => name)
      });

      const batchPromises = batch.map(async ([supplierName, supplierStyles]) => {
        const supplierMaster = supplierMasterMap.get(supplierName.toLowerCase());
        const moq = supplierMaster?.moq || 0;
        const leadTime = supplierMaster?.lead_time_days || 0;
        const travelTime = supplierMaster?.travel_time_days || 0;

        // Build input styles map for validation
        const inputStylesMap = new Map<string, { sizes: string[]; sold_qty: number; open_po_qty: number; current_stock: number; style_name: string; active_salespeople: number }>();
        for (const s of supplierStyles) {
          const key = `${s.style_no}|${s.color.toLowerCase()}`;
          inputStylesMap.set(key, { 
            sizes: s.sizes, 
            sold_qty: s.sold_qty, 
            open_po_qty: s.open_po_qty,
            current_stock: s.current_stock,
            style_name: s.style_name,
            active_salespeople: s.active_salespeople
          });
        }

        // Prepare supplier info
        const supplierInfo = JSON.stringify({
          name: supplierName,
          moq: moq,
          lead_time_days: leadTime,
          travel_time_days: travelTime,
          total_lead_time: leadTime + travelTime
        }, null, 2);

        // Prepare season context with customer/salespeople growth potential
        const seasonContext = JSON.stringify({
          season_name: season.name,
          season_year: season.year,
          purchase_stage: purchaseStage,
          visit_rate_percent: visitRatePercent,
          remaining_potential_percent: remainingPotentialPercent,
          total_customers: totalCustomers,
          visited_customers: visitedCustomers,
          remaining_customers: remainingCustomers,
          total_salespeople: totalSalespeople,
          active_salespeople: activeSalespeople,
          start_sale: seasonDates.start_sale,
          end_sale: seasonDates.end_sale,
          latest_delivery: seasonDates.latest_delivery,
          days_since_start_sale: seasonDates.days_since_start,
          days_until_end_sale: seasonDates.days_until_end,
          days_until_latest_delivery: seasonDates.days_until_latest_delivery
        }, null, 2);

        // Prepare styles data
        // net_need = max(0, sold_qty - open_po_qty - current_stock) per prompt definition
        const stylesData = JSON.stringify(supplierStyles.map(s => {
          const key = `${s.style_no}|${s.color.toLowerCase()}`;
          const prevFeedback = feedbackMap.get(key);
          return {
            style_no: s.style_no,
            style_name: s.style_name,
            color: s.color,
            sold_qty: s.sold_qty,
            open_po_qty: s.open_po_qty,
            current_stock: s.current_stock,
            net_need: Math.max(0, s.sold_qty - s.open_po_qty - s.current_stock),
            sizes: s.sizes,
            size_distribution_percent: s.size_distribution,
            active_salespeople_for_style: s.active_salespeople,
            total_salespeople: totalSalespeople,
            salespeople_coverage_percent: totalSalespeople > 0 
              ? Math.round((s.active_salespeople / totalSalespeople) * 100) 
              : 0,
            // Previous feedback for learning (if any)
            previous_ai_suggested: prevFeedback?.suggested || null,
            previous_user_adjusted: prevFeedback?.adjusted || null,
            previous_adjustment_ratio: prevFeedback?.adjustment_ratio || null
          };
        }), null, 2);

        // Prepare feedback context summary
        const feedbackContext = JSON.stringify({
          has_previous_feedback: feedbackMap.size > 0,
          styles_with_feedback: feedbackMap.size,
          avg_adjustment_ratio: avgAdjustmentRatio,
          interpretation: avgAdjustmentRatio !== null 
            ? (avgAdjustmentRatio > 1.1 
              ? `User typically INCREASES AI suggestions by ${Math.round((avgAdjustmentRatio - 1) * 100)}%` 
              : avgAdjustmentRatio < 0.9 
                ? `User typically DECREASES AI suggestions by ${Math.round((1 - avgAdjustmentRatio) * 100)}%`
                : 'User typically accepts AI suggestions as-is')
            : 'No previous feedback available'
        }, null, 2);

        // Build prompt
        const prompt = promptTemplate
          .replace('{{supplier_info}}', supplierInfo)
          .replace('{{season_context}}', seasonContext)
          .replace('{{styles_data}}', stylesData)
          .replace('{{feedback_context}}', feedbackContext)
          .replace('{{moq}}', String(moq))
          .replace('{{supplier_name}}', supplierName);

        await log('info', 'AI_CALL_SUPPLIER_START', { 
          supplier: supplierName, 
          styles_count: supplierStyles.length, 
          moq,
          lead_time: leadTime + travelTime
        });

        try {
          const completion = await openai.chat.completions.create({
            model,
            max_tokens: 4000,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' }
          });

          const rawResponse = completion.choices[0]?.message?.content || '{}';
          
          await log('info', 'AI_RESPONSE_RAW', { 
            supplier: supplierName, 
            response_length: rawResponse.length 
          });

          let aiDecision: AISupplierDecision;
          try {
            aiDecision = JSON.parse(rawResponse);
          } catch {
            await log('error', 'AI_RESPONSE_PARSE_ERROR', { supplier: supplierName, raw: rawResponse.slice(0, 500) });
            throw new Error('Failed to parse AI response');
          }

          // Validate and fix AI decision
          const validation = validateAndFixAIDecision(
            aiDecision,
            inputStylesMap,
            moq,
            (msg, data) => log('info', msg, data)
          );

          if (validation.corrections.length > 0) {
            await log('info', 'VALIDATION_ADJUSTMENTS', { 
              supplier: supplierName, 
              corrections: validation.corrections 
            });
          }

          // Compute actual moq_status from validation totals (more accurate than AI claim)
          const computedMoqStatus = moq === 0 ? 'not_applicable' : 
            (validation.totalQty >= moq ? 'met' : 'below');

          await log('info', 'AI_DECISION', { 
            supplier: supplierName, 
            decision: aiDecision.decision,
            total_qty: validation.totalQty,
            moq_status: computedMoqStatus,
            moq,
            styles_count: validation.styles.length,
            flags: aiDecision.flags
          });

          // Build supplier suggestion
          const soldQtyTotal = supplierStyles.reduce((s, st) => s + st.sold_qty, 0);

          return {
            supplier: supplierName,
            moq,
            lead_time_days: leadTime,
            travel_time_days: travelTime,
            total_qty: validation.totalQty,
            below_moq: validation.totalQty > 0 && validation.totalQty < moq,
            moq_topped_up: false,
            moq_topup_reason: aiDecision.moq_status === 'below' ? aiDecision.reasoning : undefined,
            sold_qty_total: soldQtyTotal,
            decision: aiDecision.decision,
            days_until_must_order: aiDecision.days_until_must_order,
            priority: aiDecision.decision === 'buy' ? 
              (validation.totalQty > 500 ? 'high' : validation.totalQty > 100 ? 'medium' : 'low') : 
              undefined,
            commentary: aiDecision.reasoning,
            flags: aiDecision.flags,
            styles: validation.styles
          } as SupplierSuggestion;

        } catch (aiError: any) {
          await log('error', 'AI_CALL_FAILED', { supplier: supplierName, error: aiError.message });
          
          // Fallback: return empty suggestion
          return {
            supplier: supplierName,
            moq,
            lead_time_days: leadTime,
            travel_time_days: travelTime,
            total_qty: 0,
            below_moq: false,
            moq_topped_up: false,
            sold_qty_total: supplierStyles.reduce((s, st) => s + st.sold_qty, 0),
            decision: 'wait' as const,
            commentary: `AI call failed: ${aiError.message}`,
            flags: ['ai_error'],
            styles: []
          } as SupplierSuggestion;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      supplierSuggestions.push(...batchResults);
    }

    // Sort by total qty descending
    supplierSuggestions.sort((a, b) => b.total_qty - a.total_qty);

    await log('info', 'AI_DECISIONS_COMPLETE', { 
      supplierCount: supplierSuggestions.length,
      totalUnits: supplierSuggestions.reduce((s, sup) => s + sup.total_qty, 0),
      buyDecisions: supplierSuggestions.filter(s => s.decision === 'buy').length,
      skipDecisions: supplierSuggestions.filter(s => s.decision === 'skip').length,
      waitDecisions: supplierSuggestions.filter(s => s.decision === 'wait').length,
      belowMoqCount: supplierSuggestions.filter(s => s.below_moq).length
    });

    // ========== STEP 8: Persist Results ==========
    await log('info', 'STEP_8_PERSIST_RESULTS');

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
          season_dates: seasonDates,
          open_po_totals_count: openPoTotals.size
        }
      })
      .eq('id', purchaseRunId);

    if (updateError) {
      await log('error', 'PERSIST_ERROR', { error: updateError.message });
      throw updateError;
    }

    const durationMs = Date.now() - startTime;
    await log('info', 'PURCHASE_ENGINE_COMPLETE', { 
      durationMs, 
      supplierCount: supplierSuggestions.length,
      totalUnits: supplierSuggestions.reduce((s, sup) => s + sup.total_qty, 0)
    });

    return {
      success: true,
      purchase_stage: purchaseStage,
      visit_rate_percent: visitRatePercent,
      supplier_suggestions: supplierSuggestions,
      prompt_key: promptKey,
      prompt_version: promptVersion,
      model
    };

  } catch (error: any) {
    await log('error', 'PURCHASE_ENGINE_ERROR', { error: error.message, stack: error.stack });
    
    // Try to update run status to failed
    try {
      await supabase
        .from('purchase_ai_runs')
        .update({
          status: 'cancelled',
          error: error.message
        })
        .eq('id', purchaseRunId);
    } catch {}

    return {
      success: false,
      purchase_stage: 'early',
      visit_rate_percent: 0,
      supplier_suggestions: [],
      prompt_key: 'purchase_decision_per_supplier_v1',
      prompt_version: 1,
      model: 'gpt-4o',
      error: error.message
    };
  }
}
