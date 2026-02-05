import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

type LogFn = (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;

// Format numbers in Danish style (1.000)
function formatDK(n: number): string {
  return new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 }).format(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
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

type SeasonOverridesValue = { nulled?: string[]; hidden?: string[] };

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
  size_level_details?: {
    sold_by_size: Record<string, number>;
    stock_by_size: Record<string, number>;
    po_by_size: Record<string, number>;
    net_need_by_size: Record<string, number>;
    suggested_by_size: Record<string, number>;
  };
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

function sumValuesArray(values: unknown): number {
  const arr: any[] = Array.isArray(values)
    ? (values as any[])
    : (() => {
        try {
          return JSON.parse(String(values || '[]'));
        } catch {
          return [];
        }
      })();

  return arr.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function roundLotUp(qty: number): { rounded: number; lotStep: number; rule: string } {
  if (qty <= 0) return { rounded: 0, lotStep: 0, rule: 'none' };
  // Bias toward "nice" lots: 200/300/400... (100-steps) for meaningful buys.
  // For smaller tops-ups, keep 50-steps.
  const lotStep = qty >= 150 ? 100 : 50;
  const rounded = Math.ceil(qty / lotStep) * lotStep;
  return { rounded, lotStep, rule: `ceil_to_${lotStep}` };
}

function rescaleBreakdownToTotal(
  breakdown: number[],
  targetTotal: number,
  step: number
): number[] {
  const baseSum = breakdown.reduce((a, b) => a + (Number(b) || 0), 0);
  if (targetTotal <= 0 || breakdown.length === 0) return breakdown.map(() => 0);
  if (baseSum <= 0) {
    // Even distribution fallback
    const per = Math.floor(targetTotal / breakdown.length);
    const out = breakdown.map((_, i) => (i === 0 ? targetTotal - per * (breakdown.length - 1) : per));
    return out.map(v => roundToStep(v, step));
  }

  const scaled = breakdown.map(v => (Number(v) || 0) * (targetTotal / baseSum));
  let rounded = scaled.map(v => roundToStep(Math.max(0, Math.round(v)), step));
  let sum = rounded.reduce((a, b) => a + b, 0);

  // Fix rounding drift by adjusting the largest bucket.
  if (sum !== targetTotal) {
    let idx = 0;
    let maxVal = -1;
    for (let i = 0; i < rounded.length; i++) {
      if (rounded[i]! > maxVal) {
        maxVal = rounded[i]!;
        idx = i;
      }
    }
    rounded[idx] = Math.max(0, (rounded[idx] || 0) + (targetTotal - sum));
    sum = rounded.reduce((a, b) => a + b, 0);
  }

  // As a final guard, ensure exact sum.
  if (sum !== targetTotal) {
    const diff = targetTotal - sum;
    rounded[0] = Math.max(0, (rounded[0] || 0) + diff);
  }
  return rounded;
}

// Load size-level data for detailed UI display
type SizeLevelData = {
  sold_by_size: Record<string, number>;
  stock_by_size: Record<string, number>;
  po_by_size: Record<string, number>;
};

async function loadSizeLevelData(
  supabase: SupabaseClient,
  styleDetails: any[],
  styleStockRows: any[],
  styleNos: string[],
  ignoreOpenPOs: boolean
): Promise<Map<string, SizeLevelData>> {
  const sizeLevelMap = new Map<string, SizeLevelData>();
  
  // 1. Aggregate sold quantities by size from styleDetails
  for (const row of styleDetails) {
    if (!row.style_no || !row.color || !row.size) continue;
    const key = `${row.style_no}|${row.color.toLowerCase()}`;
    
    if (!sizeLevelMap.has(key)) {
      sizeLevelMap.set(key, {
        sold_by_size: {},
        stock_by_size: {},
        po_by_size: {}
      });
    }
    
    const data = sizeLevelMap.get(key)!;
    data.sold_by_size[row.size] = (data.sold_by_size[row.size] || 0) + (Number(row.qty) || 0);
  }
  
  // 2. Process style_stock for stock and PO quantities by size
  // Group and deduplicate like the main flow does
  const grouped = new Map<string, any[]>();
  for (const r of styleStockRows) {
    if (!r.style_no || !r.color || !r.section) continue;
    const k = `${r.style_no}|${String(r.color).toLowerCase()}`;
    const arr = grouped.get(k) || [];
    arr.push(r);
    grouped.set(k, arr);
  }
  
  for (const [k, rows] of grouped.entries()) {
    // Deduplicate: latest per (section, row_label)
    const latestMap = new Map<string, any>();
    let unnamed = 0;
    for (const r of rows) {
      const lbl = String(r.row_label ?? '').trim();
      const dedupeKey = lbl ? `${r.section}|${lbl}` : `${r.section}|__unnamed_${unnamed++}`;
      const curr = latestMap.get(dedupeKey);
      const t = new Date(r.scraped_at || 0).getTime();
      const ct = curr ? new Date(curr.scraped_at || 0).getTime() : -1;
      if (!curr || t > ct) latestMap.set(dedupeKey, r);
    }
    const latestRows = Array.from(latestMap.values());
    
    const stockRows = latestRows.filter(r => r.section === 'Stock');
    const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
    
    if (!sizeLevelMap.has(k)) {
      sizeLevelMap.set(k, {
        sold_by_size: {},
        stock_by_size: {},
        po_by_size: {}
      });
    }
    
    const data = sizeLevelMap.get(k)!;
    
    // Extract stock by size
    if (stockRows.length > 0) {
      const stockRow = stockRows[0];
      const sizes = Array.isArray(stockRow.sizes) ? stockRow.sizes : JSON.parse(stockRow.sizes || '[]');
      const values = Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(stockRow.values || '[]');
      
      for (let i = 0; i < sizes.length && i < values.length; i++) {
        const size = String(sizes[i] || '');
        if (size) {
          data.stock_by_size[size] = Number(values[i]) || 0;
        }
      }
    }
    
    // Extract PO by size
    if (!ignoreOpenPOs && purchaseRows.length > 0) {
      for (const poRow of purchaseRows) {
        const sizes = Array.isArray(poRow.sizes) ? poRow.sizes : JSON.parse(poRow.sizes || '[]');
        const values = Array.isArray(poRow.values) ? poRow.values : JSON.parse(poRow.values || '[]');
        
        for (let i = 0; i < sizes.length && i < values.length; i++) {
          const size = String(sizes[i] || '');
          if (size) {
            data.po_by_size[size] = (data.po_by_size[size] || 0) + (Number(values[i]) || 0);
          }
        }
      }
    }
  }
  
  return sizeLevelMap;
}

// Calculate country signals for smart purchasing decisions
function calculateCountrySignals(data: {
  country_sales: Map<string, { qty: number; customers: Set<string> }>;
  country_visit_rates: Map<string, { visited: number; total: number }>;
}): {
  shouldWait: boolean;
  reason: string | null;
  dominantCountry: string | null;
  dominantHitRate: number;
} {
  // Find country with highest hit rate
  let dominantCountry: string | null = null;
  let maxHitRate = 0;
  
  for (const [country, sales] of data.country_sales) {
    const visitRate = data.country_visit_rates.get(country);
    if (!visitRate || visitRate.visited === 0) continue;
    
    const hitRate = sales.customers.size / visitRate.visited;
    
    if (hitRate > maxHitRate) {
      maxHitRate = hitRate;
      dominantCountry = country;
    }
  }
  
  // Check if dominant country is "done" (30%+ hit rate AND 80%+ visited)
  if (dominantCountry && maxHitRate >= 0.30) {
    const visitRate = data.country_visit_rates.get(dominantCountry);
    if (visitRate && (visitRate.visited / visitRate.total) >= 0.80) {
      // Check if any other country is showing interest (10%+ hit rate)
      const otherCountriesActive = Array.from(data.country_sales.entries())
        .some(([country, sales]) => {
          if (country === dominantCountry) return false;
          const vr = data.country_visit_rates.get(country);
          if (!vr || vr.visited === 0) return false;
          const hitRate = sales.customers.size / vr.visited;
          return hitRate > 0.10; // 10%+ hit rate = showing interest
        });
      
      return {
        shouldWait: !otherCountriesActive,
        reason: `${dominantCountry} dominant (${Math.round(maxHitRate * 100)}% hit rate) and 80%+ visited. ${otherCountriesActive ? 'Other countries active - buy now.' : 'Waiting for other countries to show interest.'}`,
        dominantCountry,
        dominantHitRate: maxHitRate
      };
    }
  }
  
  return { shouldWait: false, reason: null, dominantCountry, dominantHitRate: maxHitRate };
}

// Validate and fix AI response for a supplier
function validateAndFixAIDecision(
  aiDecision: AISupplierDecision,
  inputStyles: Map<string, {
    sizes: string[];
    sold_qty: number;
    open_po_qty: number; // from style_stock Purchase (Running + Shipped)
    current_stock: number; // from style_stock Stock
    style_name: string;
    active_salespeople: number;
    purchase_stage: 'early' | 'mid' | 'closing';
    // Country data for smart decision making
    country_sales?: Map<string, { qty: number; customers: Set<string> }>;
    country_visit_rates?: Map<string, { visited: number; total: number }>;
    // Optional signals for deterministic explanation in UI
    signals?: {
      dominant_country?: string | null;
      dominant_country_share_percent?: number | null;
      dominant_country_visit_rate_percent?: number | null;
      dominant_country_remaining_customers?: number | null;
      lot_rule?: string | null;
      target_demand_qty?: number | null;
      remaining_to_order_cap?: number | null;
      country_wait_reason?: string | null;
    };
  }>,
  moq: number,
  sizeLevelData: Map<string, SizeLevelData>,
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

    // Get sorted sizes from input
    const sizes = sortSizes(inputData.sizes);
    
    // Validate size breakdown
    let sizeBreakdown: number[] = [];
    if (aiStyle.size_breakdown && Object.keys(aiStyle.size_breakdown).length > 0) {
      // Map AI breakdown to our ordered sizes array
      sizeBreakdown = sizes.map(size => {
        const val = aiStyle.size_breakdown[size] || aiStyle.size_breakdown[size.toUpperCase()] || 
                    aiStyle.size_breakdown[size.toLowerCase()] || 0;
        // Temporarily keep raw; we'll round and rescale after we apply caps + lot rounding
        return Math.max(0, Math.round(val));
      });
      
      // Ensure sum matches qty
      const sizeSum = sizeBreakdown.reduce((a, b) => a + b, 0);
      if (sizeSum !== qty) {
        corrections.push(`${aiStyle.style_no}/${aiStyle.color}: size sum ${sizeSum} != ${qty}, adjusting`);
        
        // If sum is 0 but qty > 0, distribute evenly
        if (sizeSum === 0 && qty > 0 && sizes.length > 0) {
          const perSize = Math.floor(qty / sizes.length);
          sizeBreakdown = sizes.map((_, i) => i === 0 ? qty - (perSize * (sizes.length - 1)) : perSize);
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
      qty = sizeBreakdown.reduce((a, b) => a + b, 0);
    }

    // ---------- NEW: Net-need based calculation ----------
    const netNeed = Math.max(0, inputData.sold_qty - (inputData.open_po_qty || 0) - (inputData.current_stock || 0));
    const coveredQty = (inputData.open_po_qty || 0) + (inputData.current_stock || 0);
    let targetQty = Math.round((netNeed * 1.4) + 50);
    let countryWaitReason: string | null = null;
    
    // Check country logic for mid/closing stages
    if (inputData.purchase_stage !== 'early' && inputData.country_sales && inputData.country_visit_rates) {
      const countrySignal = calculateCountrySignals({
        country_sales: inputData.country_sales,
        country_visit_rates: inputData.country_visit_rates
      });
      if (countrySignal.shouldWait) {
        targetQty = 0;
        countryWaitReason = countrySignal.reason;
      }
    }
    
    const targetDemandQty = targetQty;
    const remainingToOrderCap = Math.max(0, targetQty);

    // If already covered, force 0 (prevents the “sold=905, PO=1625, still buy 1280” failure)
    // Override AI suggestion with our calculated qty
    if (qty !== targetQty) {
      corrections.push(`${aiStyle.style_no}/${aiStyle.color}: AI suggested ${qty}, overriding to ${targetQty} (net_need=${netNeed}, stage=${inputData.purchase_stage})`);
      qty = targetQty;
    }
    
    // If net need is 0 or negative, skip
    if (netNeed <= 0 && qty > 0) {
      corrections.push(`${aiStyle.style_no}/${aiStyle.color}: net_need=${netNeed} (already covered), forcing qty=0`);
      qty = 0;
      sizeBreakdown = sizes.map(() => 0);
    }
    
    // If waiting for countries, force 0
    if (countryWaitReason && qty > 0) {
      corrections.push(`${aiStyle.style_no}/${aiStyle.color}: ${countryWaitReason}`);
      qty = 0;
      sizeBreakdown = sizes.map(() => 0);
    }
    
    // Check MOQ per style/color (default 100, read from supplier)
    const styleMoq = moq > 0 ? moq : 100; // Default to 100 per style
    if (qty > 0 && qty < styleMoq) {
      corrections.push(`${aiStyle.style_no}/${aiStyle.color}: qty ${qty} < MOQ ${styleMoq}, skipping`);
      qty = 0;
      sizeBreakdown = sizes.map(() => 0);
    }

    // Apply "nice lot" rounding (allow small surplus up to one lotStep)
    let lotRule: string | null = null;
    if (qty > 0) {
      const lot = roundLotUp(qty);
      lotRule = lot.rule;
      const softMax = remainingToOrderCap + (lot.lotStep || 0);
      const roundedQty = clamp(lot.rounded, 0, softMax);
      if (roundedQty !== qty) {
        corrections.push(`${aiStyle.style_no}/${aiStyle.color}: lot-rounded ${qty} -> ${roundedQty} (${lot.rule})`);
        qty = roundedQty;
      }
    }

    // Final per-size rounding: 5/10 steps and exact sum to qty
    const step = qty >= 50 ? 10 : 5;
    sizeBreakdown = rescaleBreakdownToTotal(sizeBreakdown.length ? sizeBreakdown : sizes.map(() => 0), qty, step);

    // Attach signal fields for UI reasoning (even if prompt omits)
    const sig = inputData.signals || {};
    sig.lot_rule = lotRule;
    sig.target_demand_qty = targetDemandQty;
    sig.remaining_to_order_cap = netNeed;
    sig.country_wait_reason = countryWaitReason;

    // Get size-level details for this style/color (reuse key from above)
    const sizeData = sizeLevelData.get(key);
    
    // Calculate net need by size
    const netNeedBySize: Record<string, number> = {};
    if (sizeData) {
      for (const size of sizes) {
        const sold = sizeData.sold_by_size[size] || 0;
        const stock = sizeData.stock_by_size[size] || 0;
        const po = sizeData.po_by_size[size] || 0;
        netNeedBySize[size] = Math.max(0, sold - stock - po);
      }
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
      size_level_details: sizeData ? {
        sold_by_size: sizeData.sold_by_size,
        stock_by_size: sizeData.stock_by_size,
        po_by_size: sizeData.po_by_size,
        net_need_by_size: netNeedBySize,
        suggested_by_size: sizes.reduce((acc, size, idx) => {
          acc[size] = sizeBreakdown[idx] || 0;
          return acc;
        }, {} as Record<string, number>)
      } : undefined,
      active_salespeople_count: inputData.active_salespeople,
      rounding_step: step,
      reasoning: (() => {
        const base = (aiStyle.reasoning || '').trim();
        const parts: string[] = [];
        parts.push(`Net=${formatDK(netNeed)}`);
        parts.push(`Covered(stock+PO)=${formatDK(coveredQty)}`);
        parts.push(`Formula=(${netNeed}×1.4)+50=${formatDK(targetDemandQty)} (${inputData.purchase_stage})`);
        if (countryWaitReason) {
          parts.push(`Country: ${countryWaitReason}`);
        }
        if (sig.dominant_country) {
          const share = sig.dominant_country_share_percent != null ? `${Math.round(sig.dominant_country_share_percent)}%` : '?%';
          const vr = sig.dominant_country_visit_rate_percent != null ? `${Math.round(sig.dominant_country_visit_rate_percent)}%` : '?%';
          const rem = sig.dominant_country_remaining_customers != null ? formatDK(sig.dominant_country_remaining_customers) : '?';
          parts.push(`Dominant=${sig.dominant_country} (${share}, visit_rate~${vr}, rem=${rem})`);
        }
        if (sig.lot_rule) parts.push(`Lot=${sig.lot_rule}`);
        const suffix = `Signals: ${parts.join(' | ')}`;
        return base ? `${base}\n${suffix}` : suffix;
      })()
    });

    totalQty += qty;
  }

  // MOQ is now checked per-style/color (not supplier total) - see above

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
      .select('customer_id, salesperson_id, country, nulled, excluded, permanently_closed')
      .limit(10000);

    const totalCustomers = customers?.length || 0;
    
    // Get unique salespeople from customers (total active salespeople)
    const allSalespersonIds = new Set((customers || []).map(c => c.salesperson_id).filter(Boolean));
    const totalSalespeople = allSalespersonIds.size;
    
    await log('info', 'SEASON_LOADED', { name: season.name, totalCustomers, totalSalespeople, seasonDates });

    // Load season overrides (same semantics as statistics pages)
    const overridesKey = `season_overrides:${seasonId}`;
    const { data: overridesRow } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', overridesKey)
      .maybeSingle();
    const overridesVal = ((overridesRow?.value as SeasonOverridesValue | undefined) ?? {}) as SeasonOverridesValue;
    const seasonalHidden = new Set<string>(Array.isArray(overridesVal.hidden) ? overridesVal.hidden : []);
    const seasonalNulled = new Set<string>(Array.isArray(overridesVal.nulled) ? overridesVal.nulled : []);

    // Build quick customer index + "visitable" filter (exclude hidden/nulled/closed/excluded)
    type CustomerMeta = { country: string | null; salesperson_id: string | null; visitable: boolean };
    const customerMetaById = new Map<string, CustomerMeta>();
    for (const c of (customers || []) as any[]) {
      const id = String(c.customer_id || '');
      if (!id) continue;
      const excluded = Boolean(c.excluded);
      const closed = Boolean(c.permanently_closed);
      const nulled = Boolean(c.nulled);
      const visitable = !excluded && !closed && !nulled && !seasonalHidden.has(id) && !seasonalNulled.has(id);
      customerMetaById.set(id, {
        country: c.country ? String(c.country) : null,
        salesperson_id: c.salesperson_id ? String(c.salesperson_id) : null,
        visitable
      });
    }

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

    // Visitable visited customers set (for salesperson/country finish signals)
    const visitableVisitedCustomers = new Set<string>();
    for (const row of (salesStats || []) as any[]) {
      const acc = String(row.account_no || '');
      if (!acc) continue;
      const meta = customerMetaById.get(acc);
      if (meta?.visitable) visitableVisitedCustomers.add(acc);
    }

    // Salesperson progress (visit-rate proxy) over visitable customers
    const totalVisitableBySalesperson = new Map<string, number>();
    const visitedVisitableBySalesperson = new Map<string, number>();
    const totalVisitableByCountry = new Map<string, number>();
    const visitedVisitableByCountry = new Map<string, number>();

    for (const [custId, meta] of customerMetaById.entries()) {
      if (!meta.visitable) continue;
      const sp = meta.salesperson_id || '__unknown__';
      const ctry = meta.country || 'Unknown';
      totalVisitableBySalesperson.set(sp, (totalVisitableBySalesperson.get(sp) || 0) + 1);
      totalVisitableByCountry.set(ctry, (totalVisitableByCountry.get(ctry) || 0) + 1);
      if (visitableVisitedCustomers.has(custId)) {
        visitedVisitableBySalesperson.set(sp, (visitedVisitableBySalesperson.get(sp) || 0) + 1);
        visitedVisitableByCountry.set(ctry, (visitedVisitableByCountry.get(ctry) || 0) + 1);
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

    // ========== STEP 4: Load Stock + Purchased (Running + Shipped) from style_stock ==========
    await log('info', 'STEP_4_LOAD_STYLE_STOCK');
    const ignoreOpenPOs = payload.ignoreOpenPOs === true;

    const currentStockTotals = new Map<string, number>();
    const purchasedRunningShippedTotals = new Map<string, number>();
    let stockRowCount = 0;
    let purchaseRowCount = 0;

    const { data: styleStockRows } = await supabase
      .from('style_stock')
      .select('style_no, color, section, row_label, sizes, values, scraped_at')
      .in('style_no', styleNos.slice(0, 1000))
      .in('section', ['Stock', 'Purchase (Running + Shipped)']);

    // Deduplicate like stock-list: latest per (section,row_label); blank row_label treated as unique
    const grouped = new Map<string, any[]>();
    for (const r of (styleStockRows || []) as any[]) {
      if (!r.style_no || !r.color || !r.section) continue;
      const k = `${r.style_no}|${String(r.color).toLowerCase()}`;
      const arr = grouped.get(k) || [];
      arr.push(r);
      grouped.set(k, arr);
    }

    for (const [k, rows] of grouped.entries()) {
      const latestMap = new Map<string, any>();
      let unnamed = 0;
      for (const r of rows) {
        const lbl = String(r.row_label ?? '').trim();
        const dedupeKey = lbl ? `${r.section}|${lbl}` : `${r.section}|__unnamed_${unnamed++}`;
        const curr = latestMap.get(dedupeKey);
        const t = new Date(r.scraped_at || 0).getTime();
        const ct = curr ? new Date(curr.scraped_at || 0).getTime() : -1;
        if (!curr || t > ct) latestMap.set(dedupeKey, r);
      }
      const latestRows = Array.from(latestMap.values());

      const stockRows = latestRows.filter(r => r.section === 'Stock');
      const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');

      if (stockRows.length > 0) {
        // Match stock-list behavior: use a single Stock row for current stock totals
        stockRowCount += stockRows.length;
        const stockRow = stockRows[0];
        const total = stockRow ? sumValuesArray(stockRow.values) : 0;
        currentStockTotals.set(k, total);
      }

      if (!ignoreOpenPOs && purchaseRows.length > 0) {
        purchaseRowCount += purchaseRows.length;
        const total = purchaseRows.reduce((sum, r) => sum + sumValuesArray(r.values), 0);
        purchasedRunningShippedTotals.set(k, total);
      }
    }

    await log('info', 'STYLE_STOCK_LOADED', {
      ignoreOpenPOs,
      uniqueStyleColors: grouped.size,
      stockRowCount,
      purchaseRowCount,
      uniqueWithStock: currentStockTotals.size,
      uniqueWithPurchase: purchasedRunningShippedTotals.size
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
    const buyersByStyleColor = new Map<string, Set<string>>();
    const countryQtyByStyleColor = new Map<string, Map<string, number>>();
    
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

      // Buyers set (visitable customers only) for hit-rate signals
      if (row.account_no) {
        const acc = String(row.account_no || '');
        const meta = customerMetaById.get(acc);
        if (meta?.visitable) {
          const buyers = buyersByStyleColor.get(key) || new Set<string>();
          buyers.add(acc);
          buyersByStyleColor.set(key, buyers);
        }
      }

      // Country sales mix (visitable customers only)
      if (row.account_no) {
        const acc = String(row.account_no || '');
        const meta = customerMetaById.get(acc);
        if (meta?.visitable) {
          const ctry = meta.country || 'Unknown';
          const m = countryQtyByStyleColor.get(key) || new Map<string, number>();
          m.set(ctry, (m.get(ctry) || 0) + (Number(row.qty) || 0));
          countryQtyByStyleColor.set(key, m);
        }
      }
      
      if (row.size) {
        agg.sizeMix.set(row.size, (agg.sizeMix.get(row.size) || 0) + (Number(row.qty) || 0));
      }
    }

    await log('info', 'SALES_AGGREGATED', { uniqueStyleColors: styleColorAgg.size });

    // ========== STEP 5.5: Load Size-Level Data for UI Display ==========
    await log('info', 'STEP_5_5_LOAD_SIZE_LEVEL_DATA');
    const sizeLevelData = await loadSizeLevelData(
      supabase,
      styleDetails,
      styleStockRows || [],
      styleNos,
      ignoreOpenPOs
    );
    await log('info', 'SIZE_LEVEL_DATA_LOADED', { count: sizeLevelData.size });

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
      
      const openQty = ignoreOpenPOs ? 0 : (purchasedRunningShippedTotals.get(key) || 0);
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

    // Helper: dominant country and country finish proxy for a style/color
    function dominantCountrySignals(styleColorKey: string): {
      dominant_country: string | null;
      dominant_country_share_percent: number | null;
      dominant_country_visit_rate_percent: number | null;
      dominant_country_remaining_customers: number | null;
    } {
      const m = countryQtyByStyleColor.get(styleColorKey);
      if (!m || m.size === 0) {
        return {
          dominant_country: null,
          dominant_country_share_percent: null,
          dominant_country_visit_rate_percent: null,
          dominant_country_remaining_customers: null
        };
      }
      let domCountry: string | null = null;
      let domQty = -1;
      let total = 0;
      for (const [ctry, qty] of m.entries()) {
        total += qty;
        if (qty > domQty) {
          domQty = qty;
          domCountry = ctry;
        }
      }
      const share = total > 0 ? (domQty / total) * 100 : null;
      const totalVis = domCountry ? (totalVisitableByCountry.get(domCountry) || 0) : 0;
      const visitedVis = domCountry ? (visitedVisitableByCountry.get(domCountry) || 0) : 0;
      const vr = totalVis > 0 ? (visitedVis / totalVis) * 100 : null;
      const rem = totalVis > 0 ? Math.max(0, totalVis - visitedVis) : null;
      return {
        dominant_country: domCountry,
        dominant_country_share_percent: share,
        dominant_country_visit_rate_percent: vr,
        dominant_country_remaining_customers: rem
      };
    }

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
        const inputStylesMap = new Map<string, {
          sizes: string[];
          sold_qty: number;
          open_po_qty: number;
          current_stock: number;
          style_name: string;
          active_salespeople: number;
          purchase_stage: 'early' | 'mid' | 'closing';
          country_sales?: Map<string, { qty: number; customers: Set<string> }>;
          country_visit_rates?: Map<string, { visited: number; total: number }>;
          signals?: {
            dominant_country?: string | null;
            dominant_country_share_percent?: number | null;
            dominant_country_visit_rate_percent?: number | null;
            dominant_country_remaining_customers?: number | null;
            lot_rule?: string | null;
            target_demand_qty?: number | null;
            remaining_to_order_cap?: number | null;
          };
        }>();
        for (const s of supplierStyles) {
          const key = `${s.style_no}|${s.color.toLowerCase()}`;
          const dom = dominantCountrySignals(key);
          
          // Build country sales data for this style/color
          const countrySales = new Map<string, { qty: number; customers: Set<string> }>();
          const countryQty = countryQtyByStyleColor.get(key);
          const buyers = buyersByStyleColor.get(key) || new Set<string>();
          
          // Aggregate buyers by country
          for (const custId of buyers) {
            const meta = customerMetaById.get(custId);
            if (meta?.visitable) {
              const ctry = meta.country || 'Unknown';
              const entry = countrySales.get(ctry) || { qty: 0, customers: new Set<string>() };
              entry.customers.add(custId);
              countrySales.set(ctry, entry);
            }
          }
          
          // Add quantities from countryQtyByStyleColor
          if (countryQty) {
            for (const [ctry, qty] of countryQty.entries()) {
              const entry = countrySales.get(ctry) || { qty: 0, customers: new Set<string>() };
              entry.qty = qty;
              countrySales.set(ctry, entry);
            }
          }
          
          // Build country visit rates map
          const countryVisitRates = new Map<string, { visited: number; total: number }>();
          for (const ctry of countrySales.keys()) {
            countryVisitRates.set(ctry, {
              visited: visitedVisitableByCountry.get(ctry) || 0,
              total: totalVisitableByCountry.get(ctry) || 0
            });
          }
          
          inputStylesMap.set(key, { 
            sizes: s.sizes, 
            sold_qty: s.sold_qty, 
            open_po_qty: s.open_po_qty,
            current_stock: s.current_stock,
            style_name: s.style_name,
            active_salespeople: s.active_salespeople,
            purchase_stage: purchaseStage,
            country_sales: countrySales,
            country_visit_rates: countryVisitRates,
            signals: { ...dom }
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
        // IMPORTANT: remaining_to_order is based on target demand minus (stock + purchased running+shipped)
        const stylesData = JSON.stringify(supplierStyles.map(s => {
          const key = `${s.style_no}|${s.color.toLowerCase()}`;
          const prevFeedback = feedbackMap.get(key);
          const dom = dominantCountrySignals(key);
          const buyers = buyersByStyleColor.get(key) || new Set<string>();

          // Build top salesperson signals for this style/color (hit-rate + remaining customers)
          const buyersBySp = new Map<string, number>();
          for (const custId of buyers) {
            const meta = customerMetaById.get(custId);
            const sp = meta?.salesperson_id || '__unknown__';
            buyersBySp.set(sp, (buyersBySp.get(sp) || 0) + 1);
          }
          const topSp = Array.from(buyersBySp.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([spId, buyerCount]) => {
              const totalVis = totalVisitableBySalesperson.get(spId) || 0;
              const visitedVis = visitedVisitableBySalesperson.get(spId) || 0;
              const vr = totalVis > 0 ? Math.round((visitedVis / totalVis) * 1000) / 10 : null;
              const remaining = totalVis > 0 ? Math.max(0, totalVis - visitedVis) : null;
              const hit = visitedVis > 0 ? Math.round((buyerCount / visitedVis) * 1000) / 10 : null;
              return {
                salesperson_id: spId,
                visit_rate_percent: vr,
                remaining_customers: remaining,
                style_hit_rate_percent: hit,
                buyers_count: buyerCount,
                visited_customers: visitedVis
              };
            });

          // Target demand + remaining-to-order (used as guidance; engine enforces cap deterministically too)
          const maxMultiplier =
            purchaseStage === 'early' ? 1.5 :
            purchaseStage === 'mid' ? 1.2 :
            1.0;
          const targetDemandQty = Math.round(s.sold_qty * maxMultiplier);
          const coveredQty = (s.open_po_qty || 0) + (s.current_stock || 0);
          const remainingToOrder = Math.max(0, targetDemandQty - coveredQty);

          return {
            style_no: s.style_no,
            style_name: s.style_name,
            color: s.color,
            sold_qty: s.sold_qty,
            // Backwards-compatible fields (older prompts expect these)
            open_po_qty: s.open_po_qty,
            current_stock: s.current_stock,
            net_need: Math.max(0, s.sold_qty - (s.open_po_qty || 0) - (s.current_stock || 0)),
            // New fields (v4+ prompts)
            purchased_running_shipped_qty: s.open_po_qty,
            current_stock_qty: s.current_stock,
            already_covered_qty: coveredQty,
            purchase_stage: purchaseStage,
            target_demand_qty: targetDemandQty,
            remaining_to_order_qty: remainingToOrder,
            sizes: s.sizes,
            size_distribution_percent: s.size_distribution,
            active_salespeople_for_style: s.active_salespeople,
            total_salespeople: totalSalespeople,
            salespeople_coverage_percent: totalSalespeople > 0 
              ? Math.round((s.active_salespeople / totalSalespeople) * 100) 
              : 0,
            dominant_country: dom.dominant_country,
            dominant_country_share_percent: dom.dominant_country_share_percent,
            dominant_country_visit_rate_percent: dom.dominant_country_visit_rate_percent,
            dominant_country_remaining_customers: dom.dominant_country_remaining_customers,
            country_finish_risk: (dom.dominant_country && (dom.dominant_country_share_percent || 0) >= 50 && (dom.dominant_country_visit_rate_percent || 0) >= 80)
              ? 'high'
              : (dom.dominant_country && (dom.dominant_country_share_percent || 0) >= 50 && (dom.dominant_country_visit_rate_percent || 0) >= 65)
                ? 'medium'
                : 'low',
            top_salesperson_signals: topSp,
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
            sizeLevelData,
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

          const finalDecision: 'buy' | 'skip' | 'wait' =
            validation.totalQty > 0
              ? aiDecision.decision
              : (aiDecision.decision === 'skip' ? 'skip' : 'wait');

          await log('info', 'AI_DECISION', { 
            supplier: supplierName, 
            decision: finalDecision,
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
            decision: finalDecision,
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
          ignoreOpenPOs,
          style_stock_unique_with_stock: currentStockTotals.size,
          style_stock_unique_with_purchase: purchasedRunningShippedTotals.size,
          season_overrides: {
            key: overridesKey,
            hidden_count: seasonalHidden.size,
            nulled_count: seasonalNulled.size
          }
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
