import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig } from '../../../../lib/ai/prompts';
import {
  fetchStyleStockData,
  aggregateStockData,
  isWhiteWeft,
  type StockRow
} from '../../../../lib/stock-aggregation';

export const runtime = 'nodejs';
export const maxDuration = 120;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Types
interface ParsedCommand {
  line_number: number;
  original_text: string;
  style_no: string | null;
  style_name: string | null;
  color: string | null;
  command_type: 'order' | 'color_breakdown' | 'wait' | 'stock_fix' | 'unknown';
  quantity: number | null;
  wait_weeks: number | null;
  look_sales: boolean; // "look sales" modifier for color_breakdown
  size_adjustments?: Record<string, 'extra' | 'less'>; // e.g., { "42": "extra", "44": "extra", "46": "extra" }
  parsed_successfully: boolean;
  parse_error: string | null;
}

interface StockTableRow {
  section: string;
  row_label: string | null;
  sizes: string[];
  values: number[];
  total: number;
}

interface StockTableData {
  sizes: string[];
  stock: number[];
  soldSum: number[];
  soldRows: StockTableRow[];
  purchaseSum: number[];
  purchaseRows: StockTableRow[];
  netNeed: number[];
  stockTotal: number;
  soldTotal: number;
  purchaseTotal: number;
  netNeedTotal: number;
  historicalSales?: number;
}

interface SizeFactors {
  baseWeight: number;
  historicalWeight: number;
  netNeedWeight: number;
  combinedWeight: number;
  quantity: number;
}

interface OrderPlan {
  style_no: string;
  style_name: string;
  color: string;
  total_qty: number;
  size_breakdown: Record<string, number>;
  size_source: 'smart_hybrid' | 'historical_only' | 'default_only' | 'historical' | 'default_assortment';
  size_factors?: Record<string, SizeFactors>;
  current_stock: number;
  current_on_order: number;
  net_need_before: number;
  net_need_after: number;
  warning: string | null;
  action: 'create_po' | 'skip_overstocked' | 'review_needed';
  stock_table?: StockTableData;
}

interface ColorBreakdownPlan {
  style_no: string;
  style_name: string;
  source_color: string;
  target_quantity: number;
  color_distribution: Record<string, { qty: number; pct: number }>;
  source_stock_needed: number;
  source_po_available: number;  // WHITE WEFT PO's available to color
  source_po_remaining: number;  // WHITE WEFT PO's remaining after coloring
  action: string;
  look_sales: boolean;
  stock_table?: StockTableData;
  white_weft_stock_table?: StockTableData; // WHITE WEFT source material stock levels
  white_weft_remaining_by_size?: number[]; // WHITE WEFT stock after colors are deducted
}

interface WaitReminder {
  style_no: string;
  color: string;
  weeks: number;
  reminder_date: string;
}

interface StockFixSuggestion {
  style_no: string;
  color: string;
  current_curve: Record<string, number>;
  suggested_additions: Record<string, number>;
  target_curve: Record<string, number>;
  total_to_add: number;
  reasoning: string;
}

// Helper: Parse command text into structured commands
// AI-powered command parsing
async function parseCommandsWithAI(text: string, availableStyles: Array<{ style_no: string; style_name: string }>): Promise<ParsedCommand[]> {
  const lines = text.split('\n').filter(l => l.trim());
  
  if (lines.length === 0) {
    return [];
  }

  // Build style reference for AI
  const styleReference = availableStyles.slice(0, 50).map(s => `${s.style_no}: ${s.style_name}`).join('\n');
  
  const systemPrompt = `You are a purchase order command parser for a fashion wholesale company.
Parse the user's text commands and return structured JSON.

## AVAILABLE STYLES (partial list for reference):
${styleReference}

## COMMAND TYPES TO RECOGNIZE:
1. ORDER - e.g., "RANY WHITE - ORDER 400pcs", "ORDER 600 RANY SAND"
2. COLOR_BREAKDOWN - e.g., "Color breakdown for 200pcs", "colour breakdown 300pcs. Look sales"  
3. WAIT - e.g., "Wait 2 weeks", "wait 3 wks"
4. STOCK_FIX - e.g., "Make sure stock is fixed", "fix the stock"

## PARSING RULES:
- Style names are uppercase like RANY, KAXY, KARCEMONA, ILLIE
- Colors are words like WHITE, BLACK, NAVY, SAND, DENIM, ROSE SMOKE, NEW KITT, OIL GREEN
- "look sales" or "look stock" is a modifier for COLOR_BREAKDOWN - set look_sales to true
- Size adjustment instructions like "add extra in 42, 44, 46" or "less in 34, 36" should be parsed into size_adjustments
- Be flexible with formatting - users don't always use exact syntax
- Extract quantities even if written as "400pcs", "400 pieces", "400", "four hundred"

## OUTPUT FORMAT:
Return a JSON object with a "commands" array:
{
  "commands": [
    {
      "line_number": 1,
      "original_text": "RANY WHITE - ORDER 400pcs. Add extra in 42, 44 and 46",
      "style_name": "RANY",
      "color": "WHITE",
      "command_type": "order",
      "quantity": 400,
      "wait_weeks": null,
      "look_sales": false,
      "size_adjustments": { "42": "extra", "44": "extra", "46": "extra" },
      "parsed_successfully": true,
      "parse_error": null
    }
  ]
}

command_type must be one of: "order", "color_breakdown", "wait", "stock_fix", "unknown"
size_adjustments is an object mapping size strings to "extra" or "less" (e.g., {"42": "extra", "44": "extra"})
If you can't parse a line, set parsed_successfully to false and explain in parse_error.`;

  const userPrompt = `Parse these commands:\n\n${text}`;

  console.log('========== [Quick PO] AI PARSING ==========');
  console.log('[Quick PO] System Prompt:', systemPrompt.substring(0, 500) + '...');
  console.log('[Quick PO] User Prompt:', userPrompt);
  console.log('============================================');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 4000
    });

    const responseText = completion.choices[0]?.message?.content || '{}';
    
    console.log('========== [Quick PO] AI RESPONSE ==========');
    console.log('[Quick PO] Raw AI Response:', responseText);
    console.log('=============================================');
    
    let parsed: any;
    
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error('[Quick PO] Failed to parse AI response as JSON:', responseText);
      // Fallback to basic parsing
      return parseCommandTextFallback(text);
    }

    // Handle both { commands: [...] } and direct array
    const commandsArray = Array.isArray(parsed) ? parsed : (parsed.commands || parsed.parsed_commands || []);
    
    console.log('[Quick PO] Parsed commands array:', JSON.stringify(commandsArray, null, 2));
    
    // Normalize the response
    const commands: ParsedCommand[] = commandsArray.map((cmd: any, idx: number) => ({
      line_number: cmd.line_number || idx + 1,
      original_text: cmd.original_text || lines[idx] || '',
      style_no: cmd.style_no || null,
      style_name: cmd.style_name || null,
      color: cmd.color || null,
      command_type: cmd.command_type || 'unknown',
      quantity: typeof cmd.quantity === 'number' ? cmd.quantity : null,
      wait_weeks: typeof cmd.wait_weeks === 'number' ? cmd.wait_weeks : null,
      look_sales: !!cmd.look_sales,
      size_adjustments: cmd.size_adjustments || undefined,
      parsed_successfully: cmd.parsed_successfully !== false,
      parse_error: cmd.parse_error || null
    }));

    console.log('[Quick PO] Normalized commands:', JSON.stringify(commands, null, 2));
    return commands;

  } catch (error: any) {
    console.error('[Quick PO] AI parsing failed:', error);
    // Fallback to rule-based parsing
    return parseCommandTextFallback(text);
  }
}

// Fallback rule-based parsing (used if AI fails)
function parseCommandTextFallback(text: string): ParsedCommand[] {
  const lines = text.split('\n').filter(l => l.trim());
  const commands: ParsedCommand[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const lineNum = i + 1;
    
    const cmd: ParsedCommand = {
      line_number: lineNum,
      original_text: line,
      style_no: null,
      style_name: null,
      color: null,
      command_type: 'unknown',
      quantity: null,
      wait_weeks: null,
      look_sales: false,
      parsed_successfully: false,
      parse_error: null
    };
    
    // Split by common separators
    const dashMatch = line.match(/^(.+?)\s*[-–—]\s*(.+)$/i);
    
    if (!dashMatch) {
      cmd.parse_error = 'Could not parse: expected format "STYLE COLOR - COMMAND"';
      commands.push(cmd);
      continue;
    }
    
    const styleColorPart = dashMatch[1]!.trim();
    const commandPart = dashMatch[2]!.trim();
    
    // Parse style and color (last word is usually color)
    const words = styleColorPart.split(/\s+/);
    if (words.length >= 2) {
      cmd.color = words.pop()!;
      cmd.style_name = words.join(' ');
    } else if (words.length === 1) {
      cmd.style_name = words[0] || null;
      cmd.color = null;
    }
    
    // Parse command type and parameters
    const lowerCmd = commandPart.toLowerCase();
    
    // ORDER Xpcs
    const orderMatch = lowerCmd.match(/order\s+(\d+)\s*(?:pcs|pieces)?/i);
    if (orderMatch) {
      cmd.command_type = 'order';
      cmd.quantity = parseInt(orderMatch[1]!, 10);
      cmd.parsed_successfully = true;
      commands.push(cmd);
      continue;
    }
    
    // Color breakdown for Xpcs (optionally with "look sales" modifier)
    const colorMatch = lowerCmd.match(/color\s+breakdown\s+(?:for\s+)?(\d+)\s*(?:pcs|pieces)?/i);
    if (colorMatch) {
      cmd.command_type = 'color_breakdown';
      cmd.quantity = parseInt(colorMatch[1]!, 10);
      cmd.look_sales = /look\s*(sales|stock)/i.test(lowerCmd);
      cmd.parsed_successfully = true;
      commands.push(cmd);
      continue;
    }
    
    // Wait X weeks
    const waitMatch = lowerCmd.match(/wait\s+(\d+)\s*weeks?/i);
    if (waitMatch) {
      cmd.command_type = 'wait';
      cmd.wait_weeks = parseInt(waitMatch[1]!, 10);
      cmd.parsed_successfully = true;
      commands.push(cmd);
      continue;
    }
    
    // Make sure stock is fixed
    if (lowerCmd.includes('stock') && (lowerCmd.includes('fixed') || lowerCmd.includes('fix'))) {
      cmd.command_type = 'stock_fix';
      cmd.parsed_successfully = true;
      commands.push(cmd);
      continue;
    }
    
    // Unknown command
    cmd.parse_error = `Unknown command: "${commandPart}"`;
    commands.push(cmd);
  }
  
  return commands;
}

// Helper: Normalize size string
function normalizeSize(size: string): string {
  const trimmed = String(size).trim();
  const num = parseFloat(trimmed);
  if (!isNaN(num) && trimmed.includes('.')) {
    if (Number.isInteger(num)) {
      return String(Math.floor(num));
    }
  }
  return trimmed;
}

// Helper: Calculate size breakdown from ratio and total
function calculateSizeBreakdown(
  total: number,
  ratioBySize: Record<string, number>,
  sizes: string[]
): Record<string, number> {
  const result: Record<string, number> = {};
  let assigned = 0;
  
  // First pass: floor values
  const remainders: Array<{ size: string; rem: number }> = [];
  for (const size of sizes) {
    const ratio = ratioBySize[size] || 0;
    const exact = total * ratio;
    const floor = Math.floor(exact);
    result[size] = floor;
    assigned += floor;
    remainders.push({ size, rem: exact - floor });
  }
  
  // Distribute remainder using largest remainder method
  remainders.sort((a, b) => b.rem - a.rem);
  let remaining = total - assigned;
  for (const item of remainders) {
    if (remaining <= 0) break;
    result[item.size] = (result[item.size] || 0) + 1;
    remaining--;
  }
  
  return result;
}

// Default assortments (base curve)
const DEFAULT_ASSORTMENT_NUMERIC: Record<string, number> = {
  '34': 0,
  '36': 1/10,
  '38': 2/10,
  '40': 2/10,
  '42': 2/10,
  '44': 2/10,
  '46': 1/10
};

const DEFAULT_ASSORTMENT_LETTER: Record<string, number> = {
  'S': 0.125,
  'M': 0.25,
  'L': 0.25,
  'XL': 0.25,
  'XXL': 0.125
};

// Smart size breakdown with hybrid logic
// Combines: base assortment + historical sales + current net need
interface SmartBreakdownParams {
  total: number;
  sizes: string[];
  netNeedBySize: number[]; // Current net need per size
  historicalRatioBySize?: Record<string, number>; // 0-1 ratio from historical sales
  feedbackAdjustment?: Record<string, number>; // Past corrections
  sizeAdjustments?: Record<string, 'extra' | 'less'>; // User-specified adjustments like "add extra in 42, 44"
}

interface SmartBreakdownResult {
  breakdown: Record<string, number>;
  factors: Record<string, {
    baseWeight: number;
    historicalWeight: number;
    netNeedWeight: number;
    combinedWeight: number;
    quantity: number;
  }>;
  sizeSource: 'smart_hybrid' | 'historical_only' | 'default_only';
}

function calculateSmartSizeBreakdown(params: SmartBreakdownParams): SmartBreakdownResult {
  const { total, sizes, netNeedBySize, historicalRatioBySize, feedbackAdjustment, sizeAdjustments } = params;
  
  // Determine if we have historical data
  const hasHistorical = historicalRatioBySize && Object.keys(historicalRatioBySize).length > 0;
  
  // Determine size type for default assortment
  const isNumeric = sizes.some(s => /^\d+$/.test(s));
  const defaultAssortment = isNumeric ? DEFAULT_ASSORTMENT_NUMERIC : DEFAULT_ASSORTMENT_LETTER;
  
  // Calculate total positive net need (sizes that actually need stock)
  const positiveNetNeed = netNeedBySize.reduce((sum, n) => sum + Math.max(0, n), 0);
  
  // Build weight factors for each size
  const factors: SmartBreakdownResult['factors'] = {};
  const weights: Array<{ size: string; weight: number }> = [];
  
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i] as string;
    const currentNetNeed = netNeedBySize[i] ?? 0;
    
    // 1. Base weight from default assortment (normalized to 0-1)
    const baseWeight = defaultAssortment[size] ?? (1 / sizes.length);
    
    // 2. Historical weight (if available, otherwise use base)
    const historicalWeight = hasHistorical 
      ? (historicalRatioBySize![size] ?? baseWeight)
      : baseWeight;
    
    // 3. Net need weight: prioritize sizes that actually need replenishment
    // Positive net need = needs stock, negative = surplus
    let netNeedWeight = 0;
    if (positiveNetNeed > 0) {
      netNeedWeight = Math.max(0, currentNetNeed) / positiveNetNeed;
    } else {
      // If all sizes are in surplus, use equal weight
      netNeedWeight = 1 / sizes.length;
    }
    
    // 4. Apply feedback adjustment if available
    const feedbackMult = feedbackAdjustment?.[size] ?? 1.0;
    
    // 5. Apply user-specified size adjustments ("add extra in 42, 44, 46")
    let userAdjMult = 1.0;
    if (sizeAdjustments) {
      const adj = sizeAdjustments[size];
      if (adj === 'extra') userAdjMult = 1.25; // +25% for "extra"
      else if (adj === 'less') userAdjMult = 0.75; // -25% for "less"
    }
    
    // Combined weight formula:
    // - 25% base assortment (keeps the "shape" of the curve)
    // - 45% historical sales (what actually sells)
    // - 30% net need (fill the gaps first)
    // Then multiply by feedback adjustment and user size adjustment
    const combinedWeight = (
      0.25 * baseWeight +
      0.45 * historicalWeight +
      0.30 * netNeedWeight
    ) * feedbackMult * userAdjMult;
    
    factors[size] = {
      baseWeight,
      historicalWeight,
      netNeedWeight,
      combinedWeight,
      quantity: 0 // Will be filled after distribution
    };
    
    weights.push({ size, weight: combinedWeight });
  }
  
  // Normalize weights to sum to 1
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight > 0) {
    for (const w of weights) {
      w.weight = w.weight / totalWeight;
    }
  }
  
  // Distribute quantity using largest remainder method
  const breakdown: Record<string, number> = {};
  let assigned = 0;
  const remainders: Array<{ size: string; rem: number }> = [];
  
  for (const { size, weight } of weights) {
    const exact = total * weight;
    const floor = Math.floor(exact);
    breakdown[size] = floor;
    assigned += floor;
    remainders.push({ size, rem: exact - floor });
  }
  
  // Distribute remainder to sizes with largest remainders
  remainders.sort((a, b) => b.rem - a.rem);
  let remaining = total - assigned;
  for (const item of remainders) {
    if (remaining <= 0) break;
    breakdown[item.size] = (breakdown[item.size] || 0) + 1;
    remaining--;
  }
  
  // Update factors with final quantities
  for (const size of sizes) {
    if (factors[size]) {
      factors[size].quantity = breakdown[size] ?? 0;
    }
  }
  
  // Determine source type
  let sizeSource: SmartBreakdownResult['sizeSource'];
  if (hasHistorical && positiveNetNeed > 0) {
    sizeSource = 'smart_hybrid';
  } else if (hasHistorical) {
    sizeSource = 'historical_only';
  } else {
    sizeSource = 'default_only';
  }
  
  console.log('[Smart Breakdown] Total:', total, 'Source:', sizeSource);
  console.log('[Smart Breakdown] Factors:', JSON.stringify(factors, null, 2));
  
  return { breakdown, factors, sizeSource };
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { commandText, months } = body as {
      commandText: string;
      months: string[];
    };
    
    if (!commandText?.trim()) {
      return NextResponse.json({ error: 'commandText is required' }, { status: 400 });
    }
    
    if (!Array.isArray(months) || months.length === 0) {
      return NextResponse.json({ error: 'months array is required' }, { status: 400 });
    }
    
    // 1. First fetch all styles for AI reference
    const { data: allStylesData } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier')
      .limit(500);
    
    const stylesForAI = (allStylesData || []).map(s => ({
      style_no: s.style_no,
      style_name: s.style_name || s.style_no
    }));
    
    // 2. Parse commands with AI
    console.log('[Quick PO] Parsing commands with AI...');
    const parsedCommands = await parseCommandsWithAI(commandText, stylesForAI);
    console.log('[Quick PO] Parsed', parsedCommands.length, 'commands');
    
    // 3. Extract unique style names for detailed lookup
    const styleNames = [...new Set(
      parsedCommands
        .filter(c => c.style_name)
        .map(c => c.style_name!.toLowerCase())
    )];
    
    // 4. Fetch styles from DB for matching
    const { data: stylesData, error: stylesError } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier')
      .or(styleNames.length > 0 ? styleNames.map(n => `style_name.ilike.%${n}%`).join(',') : 'id.is.null');
    
    if (stylesError) {
      console.error('[Quick PO] Error fetching styles:', stylesError);
    }
    
    // Build name -> style map (fuzzy)
    const styleByName = new Map<string, { style_no: string; style_name: string; id: string }>();
    for (const style of (stylesData || [])) {
      if (style.style_name) {
        const normalizedName = style.style_name.toLowerCase().trim();
        if (!styleByName.has(normalizedName)) {
          styleByName.set(normalizedName, {
            style_no: style.style_no,
            style_name: style.style_name,
            id: style.id
          });
        }
      }
    }
    
    // Match style_no to parsed commands
    for (const cmd of parsedCommands) {
      if (cmd.style_name) {
        const normalizedName = cmd.style_name.toLowerCase().trim();
        const match = styleByName.get(normalizedName);
        if (match) {
          cmd.style_no = match.style_no;
          cmd.style_name = match.style_name;
        } else {
          // Try partial match
          for (const [key, val] of styleByName) {
            if (key.includes(normalizedName) || normalizedName.includes(key)) {
              cmd.style_no = val.style_no;
              cmd.style_name = val.style_name;
              break;
            }
          }
        }
      }
    }
    
    // 4. Get style_nos for stock lookup
    const styleNos = [...new Set(
      parsedCommands.filter(c => c.style_no).map(c => c.style_no!)
    )];
    
    // 5. Fetch stock data
    const { data: stockData } = await supabase
      .from('style_stock')
      .select('style_no, color, section, sizes, quantities')
      .in('style_no', styleNos);
    
    // Build stock map: style_no|color -> { stock, on_order, sizes, quantities }
    type StockInfo = { stock: number; on_order: number; net_need: number; sizes: string[]; stockBySize: Record<string, number> };
    const stockMap = new Map<string, StockInfo>();
    
    for (const row of (stockData || [])) {
      const key = `${row.style_no}|${row.color}`.toLowerCase();
      if (!stockMap.has(key)) {
        stockMap.set(key, { stock: 0, on_order: 0, net_need: 0, sizes: [], stockBySize: {} });
      }
      const info = stockMap.get(key)!;
      
      const sizes = (row.sizes || []).map(normalizeSize);
      const quantities = row.quantities || [];
      
      if (row.section === 'Stock') {
        info.stock = quantities.reduce((a: number, b: number) => a + b, 0);
        info.sizes = sizes;
        for (let i = 0; i < sizes.length; i++) {
          info.stockBySize[sizes[i]!] = quantities[i] || 0;
        }
      } else if (row.section === 'Net Need') {
        info.net_need = quantities.reduce((a: number, b: number) => a + b, 0);
      } else if (row.section?.includes('PO') || row.section?.includes('Purchase')) {
        info.on_order += quantities.reduce((a: number, b: number) => a + b, 0);
      }
    }
    
    // 6. Fetch size ratios from historical sales
    let sizeRatios: Record<string, { ratioBySize: Record<string, number>; sizes: string[] }> = {};
    
    if (styleNos.length > 0) {
      const ratioRes = await fetch(new URL('/api/call-off/size-ratios', req.url).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: req.headers.get('cookie') || '' },
        body: JSON.stringify({
          styleNos,
          defaultMonths: months
        })
      });
      
      if (ratioRes.ok) {
        const ratioData = await ratioRes.json();
        sizeRatios = ratioData.results || {};
      }
    }
    
    // 6b. Fetch past feedback for these styles (for learning)
    type FeedbackAdjustment = Record<string, number>; // size -> multiplier
    const feedbackByStyle: Record<string, FeedbackAdjustment> = {};
    
    if (styleNos.length > 0) {
      const { data: feedbackData } = await supabase
        .from('call_off_feedback')
        .select('style_no, color, verdict, suggested_order, actual_order')
        .in('style_no', styleNos)
        .eq('verdict', 'incorrect')
        .order('created_at', { ascending: false })
        .limit(50);
      
      // Aggregate feedback to create adjustments
      // If a style has been marked "incorrect" multiple times, we try to learn from corrections
      if (feedbackData && feedbackData.length > 0) {
        console.log('[Quick PO] Found', feedbackData.length, 'past feedback entries for learning');
        
        for (const fb of feedbackData) {
          const styleNo = fb.style_no;
          if (!feedbackByStyle[styleNo]) {
            feedbackByStyle[styleNo] = {};
          }
          
          // If we have actual_order, compare it to suggested_order to learn
          if (fb.suggested_order && fb.actual_order) {
            const suggested = fb.suggested_order as Record<string, number>;
            const actual = fb.actual_order as Record<string, number>;
            
            for (const size of Object.keys(suggested)) {
              const suggestedQty = suggested[size] || 0;
              const actualQty = actual[size] || 0;
              
              if (suggestedQty > 0) {
                // Calculate adjustment multiplier
                const ratio = actualQty / suggestedQty;
                // Blend with existing adjustment (exponential moving average)
                const existing = feedbackByStyle[styleNo]![size] ?? 1.0;
                feedbackByStyle[styleNo]![size] = existing * 0.7 + ratio * 0.3;
              }
            }
          }
        }
        
        console.log('[Quick PO] Feedback adjustments:', feedbackByStyle);
      }
    }
    
    // 7. Process each command type
    const orderPlans: OrderPlan[] = [];
    const colorBreakdownPlans: ColorBreakdownPlan[] = [];
    const waitReminders: WaitReminder[] = [];
    const stockFixSuggestions: StockFixSuggestion[] = [];
    const warnings: string[] = [];
    
    for (const cmd of parsedCommands) {
      if (!cmd.parsed_successfully) continue;
      
      const styleNo = cmd.style_no;
      const color = cmd.color;
      const stockKey = `${styleNo}|${color}`.toLowerCase();
      const stockInfo = stockMap.get(stockKey) || { stock: 0, on_order: 0, net_need: 0, sizes: [], stockBySize: {} };
      
      switch (cmd.command_type) {
        case 'order': {
          if (!styleNo || !color || !cmd.quantity) break;
          
          // Fetch ALL stock data for this style using shared utility
          const allStyleStockRows = await fetchStyleStockData(supabase, styleNo);
          
          // Aggregate stock data for this specific color using shared logic
          // This matches exactly how /styles/stock-list aggregates data
          const aggregated = aggregateStockData(allStyleStockRows, styleNo, color);
          
          // Convert to StockTableData format
          let orderStockTable: StockTableData | undefined;
          if (aggregated) {
            orderStockTable = {
              sizes: aggregated.sizes,
              stock: aggregated.stock,
              soldSum: aggregated.soldSum,
              soldRows: aggregated.soldRows,
              purchaseSum: aggregated.purchaseSum,
              purchaseRows: aggregated.purchaseRows,
              netNeed: aggregated.netNeed,
              stockTotal: aggregated.stockTotal,
              soldTotal: aggregated.soldTotal,
              purchaseTotal: aggregated.purchaseTotal,
              netNeedTotal: aggregated.netNeedTotal
            };
          }
          
          // Get size ratio from historical data
          const ratio = sizeRatios[styleNo];
          const sizes = orderStockTable?.sizes || stockInfo.sizes || ['36', '38', '40', '42', '44', '46'];
          
          // Use smart hybrid breakdown that considers:
          // 1. Default assortment curve (25%)
          // 2. Historical sales ratio (45%)
          // 3. Current net need per size (30%)
          // 4. User-specified size adjustments ("add extra in 42, 44, 46")
          const smartResult = calculateSmartSizeBreakdown({
            total: cmd.quantity,
            sizes,
            netNeedBySize: orderStockTable?.netNeed || Array(sizes.length).fill(0),
            historicalRatioBySize: ratio?.ratioBySize,
            feedbackAdjustment: feedbackByStyle[styleNo],
            sizeAdjustments: cmd.size_adjustments
          });
          
          const sizeBreakdown = smartResult.breakdown;
          const sizeSource = smartResult.sizeSource;
          const sizeFactors = smartResult.factors;
          
          const netNeedBefore = orderStockTable?.netNeedTotal ?? stockInfo.net_need;
          const netNeedAfter = netNeedBefore - cmd.quantity;
          
          let warning: string | null = null;
          let action: 'create_po' | 'skip_overstocked' | 'review_needed' = 'create_po';
          
          if (netNeedBefore <= 0) {
            warning = `Already overstocked by ${Math.abs(netNeedBefore)} pcs`;
            action = 'skip_overstocked';
          } else if (cmd.quantity > netNeedBefore * 1.5) {
            warning = `Ordering ${cmd.quantity} but net need is only ${netNeedBefore}`;
            action = 'review_needed';
          }
          
          orderPlans.push({
            style_no: styleNo,
            style_name: cmd.style_name || styleNo,
            color,
            total_qty: cmd.quantity,
            size_breakdown: sizeBreakdown,
            size_source: sizeSource,
            size_factors: sizeFactors,
            current_stock: orderStockTable?.stockTotal ?? stockInfo.stock,
            current_on_order: orderStockTable?.purchaseTotal ?? stockInfo.on_order,
            net_need_before: netNeedBefore,
            net_need_after: netNeedAfter,
            warning,
            action,
            stock_table: orderStockTable
          });
          break;
        }
        
        case 'color_breakdown': {
          if (!styleNo || !cmd.quantity) break;
          
          // Fetch ALL stock data for this style using shared utility
          const allStyleStockRows = await fetchStyleStockData(supabase, styleNo);
          
          // Find WHITE WEFT color (exact match only)
          const whiteWeftColor = Array.from(new Set(allStyleStockRows.map(r => r.color)))
            .find(c => isWhiteWeft(c)) || null;
          
          if (!whiteWeftColor) {
            warnings.push(
              `⚠️ No WHITE WEFT found for ${styleNo}. ` +
              `Color breakdowns require WHITE WEFT PO's to be available. ` +
              `Please create a Purchase Order for ${styleNo} - WHITE WEFT first.`
            );
            break;
          }
          
          // Aggregate WHITE WEFT stock data using shared logic
          const whiteWeftAggregated = aggregateStockData(allStyleStockRows, styleNo, whiteWeftColor);
          
          if (!whiteWeftAggregated) {
            warnings.push(
              `⚠️ Could not aggregate WHITE WEFT data for ${styleNo}. ` +
              `Please ensure stock data is scraped for this style.`
            );
            break;
          }
          
          // Convert to StockTableData format
          const whiteWeftStockTable: StockTableData = {
            sizes: whiteWeftAggregated.sizes,
            stock: whiteWeftAggregated.stock,
            soldSum: whiteWeftAggregated.soldSum,
            soldRows: whiteWeftAggregated.soldRows,
            purchaseSum: whiteWeftAggregated.purchaseSum,
            purchaseRows: whiteWeftAggregated.purchaseRows,
            netNeed: whiteWeftAggregated.netNeed,
            stockTotal: whiteWeftAggregated.stockTotal,
            soldTotal: whiteWeftAggregated.soldTotal,
            purchaseTotal: whiteWeftAggregated.purchaseTotal,
            netNeedTotal: whiteWeftAggregated.netNeedTotal
          };
          
          // Use PO total as what's available to color, not stock
          const whiteWeftAvailable = whiteWeftAggregated.purchaseTotal;
          
          // Warn if no WHITE WEFT PO's available
          if (whiteWeftAvailable === 0) {
            warnings.push(
              `⚠️ No WHITE WEFT Purchase Orders found for ${styleNo}. ` +
              `Color breakdowns require WHITE WEFT PO's. ` +
              `Please create a Purchase Order for ${styleNo} - WHITE WEFT first.`
            );
          }
          
          console.log('[Quick PO] WHITE WEFT POs:', whiteWeftAvailable, 'Stock:', whiteWeftAggregated.stockTotal, 'sizes:', whiteWeftAggregated.sizes.length);
          console.log('[Quick PO] Available colors:', Array.from(stockByColor.keys()).join(', '));
          
          // Calculate full stock data for each color (excluding WHITE WEFT)
          type ColorStockData = {
            color: string;
            sizes: string[];
            stock: number[];
            stockTotal: number;
            sold: number[];
            soldTotal: number;
            purchase: number[];
            purchaseTotal: number;
            netNeed: number[];
            netNeedTotal: number;
            historicalSales?: number;
          };
          
          const colorStockData: ColorStockData[] = [];
          let totalNetNeed = 0;
          
          // Fetch historical sales for this style
          const { data: historicalData } = await supabase
            .from('historical_sales')
            .select('color, quantity')
            .eq('style_no', styleNo);
          
          const historicalByColor: Record<string, number> = {};
          for (const row of (historicalData || [])) {
            const clr = row.color?.toLowerCase() || '';
            if (!isWhiteWeft(clr)) {
              historicalByColor[clr] = (historicalByColor[clr] || 0) + row.quantity;
            }
          }
          
          // Get all unique colors from stock data (excluding WHITE WEFT)
          const allColors = Array.from(new Set(allStyleStockRows.map(r => r.color)))
            .filter(c => c && !isWhiteWeft(c));
          
          // Aggregate stock data for each color using shared utility
          for (const colorName of allColors) {
            const aggregated = aggregateStockData(allStyleStockRows, styleNo, colorName);
            if (!aggregated) continue;
            
            colorStockData.push({
              color: colorName,
              sizes: aggregated.sizes,
              stock: aggregated.stock,
              stockTotal: aggregated.stockTotal,
              sold: aggregated.soldSum,
              soldTotal: aggregated.soldTotal,
              purchase: aggregated.purchaseSum,
              purchaseTotal: aggregated.purchaseTotal,
              netNeed: aggregated.netNeed,
              netNeedTotal: aggregated.netNeedTotal,
              historicalSales: historicalByColor[colorName.toLowerCase()] || 0
            });
            
            // Only count positive net need for distribution
            if (aggregated.netNeedTotal > 0) {
              totalNetNeed += aggregated.netNeedTotal;
            }
          }
          
          // Sort by net need descending (most needed first)
          colorStockData.sort((a, b) => b.netNeedTotal - a.netNeedTotal);
          
          // The TARGET COLOR from the command gets ALL the quantity
          // Other colors are shown for reference with qty=0
          type ColorDistItem = {
            qty: number;
            pct: number;
            stockData: ColorStockData;
            newNetNeed: number; // Net need after this order
            isTarget: boolean; // Is this the target color from the command?
            newOrderBySize: number[]; // Size breakdown for new order
            newNetNeedBySize: number[]; // Net need by size after order
          };
          const colorDistribution: Record<string, ColorDistItem> = {};
          
          console.log('[Quick PO] Color breakdown command:', {
            styleNo,
            targetColor: color, // The color specified in the command (e.g., "ROSE SMOKE")
            quantity: cmd.quantity
          });
          
          console.log('[Quick PO] Color stock data for', styleNo, ':', colorStockData.map(c => ({
            color: c.color,
            stock: c.stockTotal,
            sold: c.soldTotal,
            purchase: c.purchaseTotal,
            netNeed: c.netNeedTotal,
            historical: c.historicalSales
          })));
          
          // Find the target color (fuzzy match the color from the command)
          const targetColorLower = (color || '').toLowerCase().trim();
          let matchedTargetColor: ColorStockData | null = null;
          
          for (const cn of colorStockData) {
            const cnLower = cn.color.toLowerCase();
            // Check for exact match or partial match
            if (cnLower === targetColorLower || 
                cnLower.includes(targetColorLower) || 
                targetColorLower.includes(cnLower.replace(/^\d+\s*/, ''))) { // Remove leading numbers like "3289 "
              matchedTargetColor = cn;
              break;
            }
          }
          
          console.log('[Quick PO] Matched target color:', matchedTargetColor?.color || 'NOT FOUND');
          
          // ONLY add the TARGET color to distribution (not all colors!)
          if (matchedTargetColor) {
            const cn = matchedTargetColor;
            const qty = cmd.quantity || 0;
            const numSizes = cn.sizes.length;
            
            // Calculate size breakdown for the target color using smart hybrid
            let newOrderBySize: number[] = Array(numSizes).fill(0);
            if (qty > 0) {
              const ratio = sizeRatios[styleNo];
              const smartResult = calculateSmartSizeBreakdown({
                total: qty,
                sizes: cn.sizes,
                netNeedBySize: cn.netNeed,
                historicalRatioBySize: ratio?.ratioBySize,
                feedbackAdjustment: feedbackByStyle[styleNo],
                sizeAdjustments: cmd.size_adjustments
              });
              newOrderBySize = cn.sizes.map(sz => smartResult.breakdown[sz] || 0);
            }
            
            // Calculate new net need by size
            const newNetNeedBySize = cn.netNeed.map((need, i) => need - (newOrderBySize[i] || 0));
            
            colorDistribution[cn.color] = {
              qty,
              pct: 100,
              stockData: cn,
              newNetNeed: cn.netNeedTotal - qty,
              isTarget: true,
              newOrderBySize,
              newNetNeedBySize
            };
          }
          
          // If target color wasn't found, add a warning
          if (!matchedTargetColor && targetColorLower) {
            warnings.push(`${styleNo}: Target color "${color}" not found in stock data. Available colors: ${colorStockData.map(c => c.color).join(', ')}`);
          }
          
          console.log('[Quick PO] Color distribution for', styleNo, ':', Object.entries(colorDistribution).map(([clr, d]) => ({
            color: clr,
            qty: d.qty,
            pct: d.pct,
            isTarget: d.isTarget,
            netNeed: d.stockData.netNeedTotal,
            newNetNeed: d.newNetNeed
          })));
          
          // Build stock table for WHITE WEFT if look_sales is true
          let stockTableData: StockTableData | undefined;
          if (cmd.look_sales && whiteWeftAggregated) {
            stockTableData = {
              sizes: whiteWeftAggregated.sizes,
              stock: whiteWeftAggregated.stock,
              soldSum: whiteWeftAggregated.soldSum,
              soldRows: whiteWeftAggregated.soldRows,
              purchaseSum: whiteWeftAggregated.purchaseSum,
              purchaseRows: whiteWeftAggregated.purchaseRows,
              netNeed: whiteWeftAggregated.netNeed,
              stockTotal: whiteWeftAggregated.stockTotal,
              soldTotal: whiteWeftAggregated.soldTotal,
              purchaseTotal: whiteWeftAggregated.purchaseTotal,
              netNeedTotal: whiteWeftAggregated.netNeedTotal
            };
          }
          
          // Calculate remaining WHITE WEFT PO's by size after deducting the color order
          // We use PO's as the source (what's on order to be colored), not stock
          const whiteWeftRemainingBySize = whiteWeftAggregated
            ? whiteWeftAggregated.purchaseSum.map((poQty: number, i: number) => {
                // Sum up all order quantities for this size from colorDistribution
                let totalOrderedForSize = 0;
                for (const [_, dist] of Object.entries(colorDistribution)) {
                  if (dist.isTarget && dist.newOrderBySize && dist.newOrderBySize[i]) {
                    totalOrderedForSize += dist.newOrderBySize[i];
                  }
                }
                return poQty - totalOrderedForSize;
              })
            : [];
          
          colorBreakdownPlans.push({
            style_no: styleNo,
            style_name: cmd.style_name || styleNo,
            source_color: 'WHITE WEFT',
            target_quantity: cmd.quantity,
            color_distribution: colorDistribution,
            source_stock_needed: cmd.quantity,
            source_po_available: whiteWeftAvailable,  // PO's available to color
            source_po_remaining: whiteWeftAvailable - cmd.quantity,  // PO's remaining after coloring
            action: 'create_coloring_po',
            look_sales: cmd.look_sales,
            stock_table: stockTableData,
            white_weft_stock_table: whiteWeftStockTable,
            white_weft_remaining_by_size: whiteWeftRemainingBySize
          });
          break;
        }
        
        case 'wait': {
          if (!styleNo || !color || !cmd.wait_weeks) break;
          
          const reminderDate = new Date();
          reminderDate.setDate(reminderDate.getDate() + cmd.wait_weeks * 7);
          
          waitReminders.push({
            style_no: styleNo,
            color,
            weeks: cmd.wait_weeks,
            reminder_date: reminderDate.toISOString().split('T')[0] || ''
          });
          break;
        }
        
        case 'stock_fix': {
          if (!styleNo || !color) break;
          
          // Analyze the current stock curve
          const currentCurve = stockInfo.stockBySize;
          const sizes = Object.keys(currentCurve).sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return a.localeCompare(b);
          });
          
          if (sizes.length === 0) break;
          
          // Find "jumps" - sizes where stock drops significantly
          const values = sizes.map(s => currentCurve[s] || 0);
          const maxVal = Math.max(...values);
          const suggestedAdditions: Record<string, number> = {};
          const targetCurve: Record<string, number> = {};
          let totalToAdd = 0;
          
          for (let i = 0; i < sizes.length; i++) {
            const size = sizes[i]!;
            const current = values[i] || 0;
            const prev = i > 0 ? values[i - 1] || 0 : current;
            const next = i < values.length - 1 ? values[i + 1] || 0 : current;
            
            // Target should be smooth - average of neighbors
            const targetVal = Math.round((prev + next) / 2);
            const shouldBe = Math.max(current, Math.min(targetVal, maxVal));
            
            if (shouldBe > current) {
              suggestedAdditions[size] = shouldBe - current;
              totalToAdd += shouldBe - current;
            }
            targetCurve[size] = shouldBe;
          }
          
          if (totalToAdd > 0) {
            stockFixSuggestions.push({
              style_no: styleNo,
              color,
              current_curve: currentCurve,
              suggested_additions: suggestedAdditions,
              target_curve: targetCurve,
              total_to_add: totalToAdd,
              reasoning: 'Smoothed curve to eliminate jumps between sizes'
            });
          }
          break;
        }
      }
    }
    
    // Build summary
    const summary = {
      total_orders: orderPlans.length,
      total_units_to_order: orderPlans.filter(p => p.action === 'create_po').reduce((a, b) => a + b.total_qty, 0),
      total_coloring_jobs: colorBreakdownPlans.length,
      total_reminders: waitReminders.length,
      warnings
    };
    
    // Add warnings for unparsed commands
    for (const cmd of parsedCommands) {
      if (!cmd.parsed_successfully) {
        summary.warnings.push(`Line ${cmd.line_number}: ${cmd.parse_error}`);
      } else if (!cmd.style_no) {
        summary.warnings.push(`Line ${cmd.line_number}: Could not find style "${cmd.style_name}"`);
      }
    }
    
    // Get prompt version for display
    let promptVersion = 'quick_po_flow_v1';
    try {
      const config = await getPromptConfig('quick_po_flow_v1');
      promptVersion = `${config.key}_v${config.version}`;
    } catch {}
    
    const response = {
      parsed_commands: parsedCommands,
      order_plans: orderPlans,
      color_breakdown_plans: colorBreakdownPlans,
      wait_reminders: waitReminders,
      stock_fix_suggestions: stockFixSuggestions,
      summary,
      promptVersion
    };
    
    console.log('========== [Quick PO] FINAL RESPONSE ==========');
    console.log('[Quick PO] Parsed commands:', parsedCommands.length);
    console.log('[Quick PO] Order plans:', orderPlans.length);
    console.log('[Quick PO] Color breakdown plans:', colorBreakdownPlans.length);
    if (colorBreakdownPlans.length > 0) {
      colorBreakdownPlans.forEach((plan, idx) => {
        console.log(`[Quick PO] Breakdown ${idx + 1}: ${plan.style_name} - WHITE WEFT`);
        console.log(`  - Target: ${plan.target_quantity} pcs`);
        console.log(`  - WHITE WEFT PO's available: ${plan.source_po_available}`);
        console.log(`  - Colors in distribution:`, Object.keys(plan.color_distribution).length);
        Object.entries(plan.color_distribution).forEach(([color, dist]: [string, any]) => {
          console.log(`    • ${color}: qty=${dist.qty}, netNeed=${dist.stockData?.netNeedTotal ?? 'N/A'}, newNetNeed=${dist.newNetNeed ?? 'N/A'}`);
        });
      });
    }
    console.log('[Quick PO] Summary:', summary);
    console.log('================================================');
    
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error('[Quick PO] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
