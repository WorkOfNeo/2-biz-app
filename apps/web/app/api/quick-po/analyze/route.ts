import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getPromptConfig, interpolatePrompt } from '../../../../../lib/ai/prompts';

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
function parseCommandText(text: string): ParsedCommand[] {
  const lines = text.split('\n').filter(l => l.trim());
  const commands: ParsedCommand[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const lineNum = i + 1;
    
    // Try to parse the line
    // Format: STYLE_NAME COLOR - COMMAND
    // E.g., "RANY WHITE - ORDER 400pcs"
    
    const cmd: ParsedCommand = {
      line_number: lineNum,
      original_text: line,
      style_no: null,
      style_name: null,
      color: null,
      command_type: 'unknown',
      quantity: null,
      wait_weeks: null,
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
    
    // Color breakdown for Xpcs
    const colorMatch = lowerCmd.match(/color\s+breakdown\s+(?:for\s+)?(\d+)\s*(?:pcs|pieces)?/i);
    if (colorMatch) {
      cmd.command_type = 'color_breakdown';
      cmd.quantity = parseInt(colorMatch[1]!, 10);
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
    
    // 1. Parse commands
    const parsedCommands = parseCommandText(commandText);
    
    // 2. Extract unique style names for lookup
    const styleNames = [...new Set(
      parsedCommands
        .filter(c => c.style_name)
        .map(c => c.style_name!.toLowerCase())
    )];
    
    // 3. Fetch styles from DB
    const { data: stylesData, error: stylesError } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier')
      .or(styleNames.map(n => `style_name.ilike.%${n}%`).join(','));
    
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
          
          // Look for WHITE WEFT stock
          const whiteWeftKey = `${styleNo}|white weft`.toLowerCase();
          const whiteWeftStock = stockMap.get(whiteWeftKey) || { stock: 0, on_order: 0, net_need: 0, sizes: [], stockBySize: {} };
          
          // Fetch historical color distribution
          const { data: colorHistorical } = await supabase
            .from('historical_sales')
            .select('color, quantity')
            .eq('style_no', styleNo)
            .not('color', 'ilike', '%white weft%');
          
          // Aggregate by color
          const colorTotals: Record<string, number> = {};
          let totalColorSales = 0;
          for (const row of (colorHistorical || [])) {
            colorTotals[row.color] = (colorTotals[row.color] || 0) + row.quantity;
            totalColorSales += row.quantity;
          }
          
          // Calculate distribution
          const colorDistribution: Record<string, { qty: number; pct: number }> = {};
          if (totalColorSales > 0) {
            for (const [clr, qty] of Object.entries(colorTotals)) {
              const pct = Math.round((qty / totalColorSales) * 100);
              const allocatedQty = Math.round((qty / totalColorSales) * cmd.quantity);
              colorDistribution[clr] = { qty: allocatedQty, pct };
            }
          } else {
            // No historical data - equal distribution across known colors
            const { data: styleColors } = await supabase
              .from('style_colors')
              .select('color')
              .eq('style_id', (stylesData || []).find(s => s.style_no === styleNo)?.id || '');
            
            const colors = (styleColors || []).map(c => c.color).filter(c => !c.toLowerCase().includes('white weft'));
            if (colors.length > 0) {
              const perColor = Math.round(cmd.quantity / colors.length);
              for (const clr of colors) {
                colorDistribution[clr] = { qty: perColor, pct: Math.round(100 / colors.length) };
              }
            }
          }
          
          colorBreakdownPlans.push({
            style_no: styleNo,
            style_name: cmd.style_name || styleNo,
            source_color: 'WHITE WEFT',
            target_quantity: cmd.quantity,
            color_distribution: colorDistribution,
            source_stock_needed: cmd.quantity,
            source_stock_available: whiteWeftStock.stock,
            source_stock_remaining: whiteWeftStock.stock - cmd.quantity,
            action: 'create_coloring_po'
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
    
    return NextResponse.json({
      parsed_commands: parsedCommands,
      order_plans: orderPlans,
      color_breakdown_plans: colorBreakdownPlans,
      wait_reminders: waitReminders,
      stock_fix_suggestions: stockFixSuggestions,
      summary,
      promptVersion
    });
    
  } catch (error: any) {
    console.error('[Quick PO] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
