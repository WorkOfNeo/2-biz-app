import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig } from '../../../../lib/ai/prompts';

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
  parsed_successfully: boolean;
  parse_error: string | null;
}

interface OrderPlan {
  style_no: string;
  style_name: string;
  color: string;
  total_qty: number;
  size_breakdown: Record<string, number>;
  size_source: 'historical' | 'default_assortment';
  current_stock: number;
  current_on_order: number;
  net_need_before: number;
  net_need_after: number;
  warning: string | null;
  action: 'create_po' | 'skip_overstocked' | 'review_needed';
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
}

interface ColorBreakdownPlan {
  style_no: string;
  style_name: string;
  source_color: string;
  target_quantity: number;
  color_distribution: Record<string, { qty: number; pct: number }>;
  source_stock_needed: number;
  source_stock_available: number;
  source_stock_remaining: number;
  action: string;
  look_sales: boolean;
  stock_table?: StockTableData;
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
- "look sales" or "look stock" is a modifier for COLOR_BREAKDOWN
- Be flexible with formatting - users don't always use exact syntax
- Extract quantities even if written as "400pcs", "400 pieces", "400", "four hundred"

## OUTPUT FORMAT:
Return a JSON array of parsed commands:
[
  {
    "line_number": 1,
    "original_text": "RANY WHITE - ORDER 400pcs",
    "style_name": "RANY",
    "color": "WHITE",
    "command_type": "order",
    "quantity": 400,
    "wait_weeks": null,
    "look_sales": false,
    "parsed_successfully": true,
    "parse_error": null
  }
]

command_type must be one of: "order", "color_breakdown", "wait", "stock_fix", "unknown"
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

// Default assortments
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
          
          // Get size ratio
          const ratio = sizeRatios[styleNo];
          let sizeBreakdown: Record<string, number>;
          let sizeSource: 'historical' | 'default_assortment';
          let sizes = stockInfo.sizes.length > 0 ? stockInfo.sizes : ['36', '38', '40', '42', '44', '46'];
          
          if (ratio && Object.keys(ratio.ratioBySize).length > 0) {
            sizeBreakdown = calculateSizeBreakdown(cmd.quantity, ratio.ratioBySize, ratio.sizes.length > 0 ? ratio.sizes : sizes);
            sizeSource = 'historical';
          } else {
            // Use default assortment
            const isNumeric = sizes.some(s => /^\d+$/.test(s));
            const defaultRatio = isNumeric ? DEFAULT_ASSORTMENT_NUMERIC : DEFAULT_ASSORTMENT_LETTER;
            sizeBreakdown = calculateSizeBreakdown(cmd.quantity, defaultRatio, sizes);
            sizeSource = 'default_assortment';
          }
          
          const netNeedBefore = stockInfo.net_need;
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
            current_stock: stockInfo.stock,
            current_on_order: stockInfo.on_order,
            net_need_before: netNeedBefore,
            net_need_after: netNeedAfter,
            warning,
            action
          });
          break;
        }
        
        case 'color_breakdown': {
          if (!styleNo || !cmd.quantity) break;
          
          // Fetch ALL stock data for this style (all colors) to get net need per color
          const { data: allStyleStock } = await supabase
            .from('style_stock')
            .select('style_no, color, section, row_label, sizes, values')
            .eq('style_no', styleNo);
          
          // Group by color
          const stockByColor = new Map<string, any[]>();
          for (const row of (allStyleStock || [])) {
            const clr = row.color?.toLowerCase() || '';
            if (!stockByColor.has(clr)) stockByColor.set(clr, []);
            stockByColor.get(clr)!.push(row);
          }
          
          // Get WHITE WEFT data
          const whiteWeftRows = stockByColor.get('white weft') || [];
          const whiteWeftStockRow = whiteWeftRows.find(r => r.section === 'Stock');
          const whiteWeftStock = whiteWeftStockRow?.values?.reduce((a: number, b: number) => a + (b || 0), 0) || 0;
          const whiteWeftSizes = whiteWeftStockRow?.sizes || [];
          
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
            if (clr !== 'white weft') {
              historicalByColor[clr] = (historicalByColor[clr] || 0) + row.quantity;
            }
          }
          
          for (const [clr, rows] of stockByColor) {
            if (clr === 'white weft') continue;
            
            const stockRow = rows.find((r: any) => r.section === 'Stock');
            const soldRows = rows.filter((r: any) => r.section === 'Sold');
            const purchaseRows = rows.filter((r: any) => r.section?.includes('Purchase'));
            const netNeedRow = rows.find((r: any) => r.section === 'Net Need');
            
            const sizes = stockRow?.sizes || [];
            const numSizes = sizes.length;
            const zero = Array(numSizes).fill(0);
            
            const stock = stockRow?.values || zero;
            const stockTotal = stock.reduce((a: number, b: number) => a + (b || 0), 0);
            
            const sold = soldRows.reduce((acc: number[], r: any) => {
              const vals = r.values || [];
              return acc.map((v, i) => v + (vals[i] || 0));
            }, zero.slice());
            const soldTotal = sold.reduce((a: number, b: number) => a + (b || 0), 0);
            
            const purchase = purchaseRows.reduce((acc: number[], r: any) => {
              const vals = r.values || [];
              return acc.map((v, i) => v + (vals[i] || 0));
            }, zero.slice());
            const purchaseTotal = purchase.reduce((a: number, b: number) => a + (b || 0), 0);
            
            let netNeed: number[];
            let netNeedTotal: number;
            
            if (netNeedRow?.values) {
              netNeed = netNeedRow.values;
              netNeedTotal = netNeedRow.values.reduce((a: number, b: number) => a + (b || 0), 0);
            } else {
              netNeed = stock.map((s: number, i: number) => -s + (sold[i] || 0) - (purchase[i] || 0));
              netNeedTotal = netNeed.reduce((a, b) => a + (b || 0), 0);
            }
            
            const displayColor = rows[0]?.color || clr;
            
            colorStockData.push({
              color: displayColor,
              sizes,
              stock,
              stockTotal,
              sold,
              soldTotal,
              purchase,
              purchaseTotal,
              netNeed,
              netNeedTotal,
              historicalSales: historicalByColor[clr] || 0
            });
            
            // Only count positive net need for distribution
            if (netNeedTotal > 0) {
              totalNetNeed += netNeedTotal;
            }
          }
          
          // Sort by net need descending (most needed first)
          colorStockData.sort((a, b) => b.netNeedTotal - a.netNeedTotal);
          
          // Calculate distribution based on net need proportions
          // BUT include ALL colors in the output (even those without need)
          type ColorDistItem = {
            qty: number;
            pct: number;
            stockData: ColorStockData;
            newNetNeed: number; // Net need after this order
          };
          const colorDistribution: Record<string, ColorDistItem> = {};
          
          console.log('[Quick PO] Color stock data for', styleNo, ':', colorStockData.map(c => ({
            color: c.color,
            stock: c.stockTotal,
            sold: c.soldTotal,
            purchase: c.purchaseTotal,
            netNeed: c.netNeedTotal,
            historical: c.historicalSales
          })));
          
          // Only distribute to colors with positive net need
          const colorsWithNeed = colorStockData.filter(c => c.netNeedTotal > 0);
          
          if (totalNetNeed > 0 && colorsWithNeed.length > 0) {
            // Distribute the coloring quantity proportionally to net need
            let allocated = 0;
            for (let i = 0; i < colorsWithNeed.length; i++) {
              const cn = colorsWithNeed[i]!;
              const pct = Math.round((cn.netNeedTotal / totalNetNeed) * 100);
              let qty: number;
              
              if (i === colorsWithNeed.length - 1) {
                // Last one gets the remainder to ensure total matches
                qty = cmd.quantity - allocated;
              } else {
                qty = Math.round((cn.netNeedTotal / totalNetNeed) * cmd.quantity);
              }
              
              allocated += qty;
              colorDistribution[cn.color] = {
                qty,
                pct,
                stockData: cn,
                newNetNeed: cn.netNeedTotal - qty // Net need after adding this order
              };
            }
            
            // Also add colors WITHOUT need (qty = 0) so they still appear
            for (const cn of colorStockData) {
              if (!colorDistribution[cn.color]) {
                colorDistribution[cn.color] = {
                  qty: 0,
                  pct: 0,
                  stockData: cn,
                  newNetNeed: cn.netNeedTotal
                };
              }
            }
          } else if (colorStockData.length > 0) {
            // No positive net need - distribute equally to all colors
            const perColor = Math.round(cmd.quantity / colorStockData.length);
            let allocated = 0;
            for (let i = 0; i < colorStockData.length; i++) {
              const cn = colorStockData[i]!;
              const qty = i === colorStockData.length - 1 ? cmd.quantity - allocated : perColor;
              allocated += qty;
              colorDistribution[cn.color] = {
                qty,
                pct: Math.round(100 / colorStockData.length),
                stockData: cn,
                newNetNeed: cn.netNeedTotal - qty
              };
            }
            warnings.push(`${styleNo}: No positive net need, distributing equally`);
          } else {
            // No stock data at all
            warnings.push(`${styleNo}: No stock data found for any colors`);
          }
          
          console.log('[Quick PO] Color distribution for', styleNo, ':', Object.entries(colorDistribution).map(([color, d]) => ({
            color,
            qty: d.qty,
            pct: d.pct,
            netNeed: d.stockData.netNeedTotal,
            newNetNeed: d.newNetNeed
          })));
          
          // Build stock table for WHITE WEFT if look_sales is true
          let stockTableData: StockTableData | undefined;
          if (cmd.look_sales && whiteWeftRows.length > 0) {
            const stockRows = whiteWeftRows.filter((r: any) => r.section === 'Stock');
            const soldRows = whiteWeftRows.filter((r: any) => r.section === 'Sold');
            const purchaseRows = whiteWeftRows.filter((r: any) => r.section?.includes('Purchase'));
            const netNeedRows = whiteWeftRows.filter((r: any) => r.section === 'Net Need');
            
            const sizes = stockRows[0]?.sizes || [];
            const numSizes = sizes.length;
            const zero = Array(numSizes).fill(0);
            
            const sumArrays = (rows: any[]): number[] => {
              return rows.reduce((acc, row) => {
                const vals = row.values || [];
                return acc.map((v: number, i: number) => v + (vals[i] || 0));
              }, zero.slice());
            };
            
            const sum = (arr: number[]) => arr.reduce((a, b) => a + (b || 0), 0);
            
            const stock = stockRows[0]?.values || zero;
            const soldSum = sumArrays(soldRows);
            const purchaseSum = sumArrays(purchaseRows);
            const netNeed = netNeedRows[0]?.values || stock.map((s: number, i: number) => s - (soldSum[i] ?? 0) + (purchaseSum[i] ?? 0));
            
            stockTableData = {
              sizes,
              stock,
              soldSum,
              soldRows: soldRows.map((r: any) => ({
                section: r.section,
                row_label: r.row_label,
                sizes: r.sizes || [],
                values: r.values || [],
                total: sum(r.values || [])
              })),
              purchaseSum,
              purchaseRows: purchaseRows.map((r: any) => ({
                section: r.section,
                row_label: r.row_label,
                sizes: r.sizes || [],
                values: r.values || [],
                total: sum(r.values || [])
              })),
              netNeed,
              stockTotal: sum(stock),
              soldTotal: sum(soldSum),
              purchaseTotal: sum(purchaseSum),
              netNeedTotal: sum(netNeed)
            };
          }
          
          colorBreakdownPlans.push({
            style_no: styleNo,
            style_name: cmd.style_name || styleNo,
            source_color: 'WHITE WEFT',
            target_quantity: cmd.quantity,
            color_distribution: colorDistribution,
            source_stock_needed: cmd.quantity,
            source_stock_available: whiteWeftStock,
            source_stock_remaining: whiteWeftStock - cmd.quantity,
            action: 'create_coloring_po',
            look_sales: cmd.look_sales,
            stock_table: stockTableData
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
        console.log(`  - Source available: ${plan.source_stock_available}`);
        console.log(`  - Colors in distribution:`, Object.keys(plan.color_distribution).length);
        Object.entries(plan.color_distribution).forEach(([color, dist]) => {
          console.log(`    • ${color}: qty=${dist.qty}, netNeed=${dist.stockData.netNeedTotal}, newNetNeed=${dist.newNetNeed}`);
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
