/**
 * Action Registry for the Agentic Chat
 * 
 * Each action has:
 * - name: stable identifier
 * - description: for the LLM to understand what it does
 * - inputSchema: JSON schema for parameters
 * - roles: which roles can execute this action (empty = all authenticated)
 * - mode: 'read' or 'write' (write requires confirmation)
 * - handler: server-side function that executes the action
 */

import { SupabaseClient } from '@supabase/supabase-js';

export type ActionMode = 'read' | 'write';

export interface ActionDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
  roles: string[]; // Empty array = all authenticated users
  mode: ActionMode;
  handler: (params: Record<string, any>, supabase: SupabaseClient, userId: string) => Promise<ActionResult>;
}

export interface ActionResult {
  success: boolean;
  data?: any;
  message: string;
  error?: string;
}

// ==================== Action Handlers ====================

async function getStyleStock(
  params: Record<string, any>,
  supabase: SupabaseClient,
  _userId: string
): Promise<ActionResult> {
  try {
    const styleNo = typeof params?.styleNo === 'string' ? params.styleNo.trim() : '';
    const color = typeof params?.color === 'string' ? params.color.trim() : '';
    if (!styleNo) {
      return {
        success: false,
        message: 'Missing required parameter: styleNo',
        error: 'styleNo is required',
      };
    }

    let query = supabase
      .from('style_stock')
      .select('style_no, color, section, sizes, quantities, scraped_at')
      .eq('style_no', styleNo);
    
    if (color) {
      query = query.eq('color', color);
    }
    
    const { data, error } = await query.order('scraped_at', { ascending: false }).limit(50);
    
    if (error) throw error;
    
    if (!data || data.length === 0) {
      return {
        success: true,
        data: [],
        message: `No stock data found for style ${styleNo}${color ? ` in color ${color}` : ''}.`,
      };
    }
    
    // Aggregate by color for a cleaner response
    const byColor: Record<string, { stock: number; colors: string[]; lastScraped: string }> = {};
    for (const row of data) {
      const color = typeof row?.color === 'string' ? row.color : String(row?.color ?? '');
      if (!color) continue;

      if (!byColor[color]) {
        byColor[color] = { stock: 0, colors: [], lastScraped: row.scraped_at };
      }
      if (row.section === 'Stock' && row.quantities) {
        const total = (row.quantities as number[]).reduce((a, b) => a + b, 0);
        byColor[color]!.stock = total;
      }
    }
    
    const summary = Object.entries(byColor).map(([color, info]) => ({
      color,
      stockTotal: info.stock,
      lastScraped: info.lastScraped,
    }));
    
    return {
      success: true,
      data: summary,
      message: `Found stock data for ${summary.length} color(s) of style ${styleNo}.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to fetch stock data: ${error.message}`,
    };
  }
}

async function getPurchaseOrders(
  params: { status?: string; limit?: number },
  supabase: SupabaseClient
): Promise<ActionResult> {
  try {
    let query = supabase
      .from('purchase_orders')
      .select('id, po_no, supplier, status, total_qty, created_at, expected_delivery')
      .order('created_at', { ascending: false })
      .limit(params.limit || 20);
    
    if (params.status) {
      query = query.eq('status', params.status);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    return {
      success: true,
      data: data || [],
      message: `Found ${data?.length || 0} purchase orders${params.status ? ` with status "${params.status}"` : ''}.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to fetch purchase orders: ${error.message}`,
    };
  }
}

async function getPurchaseOrderDetails(
  params: { poNo: string },
  supabase: SupabaseClient
): Promise<ActionResult> {
  try {
    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('po_no', params.poNo)
      .single();
    
    if (poError) throw poError;
    
    const { data: items, error: itemsError } = await supabase
      .from('purchase_order_items')
      .select('style_no, color, qty, size_qty')
      .eq('po_no', params.poNo);
    
    if (itemsError) throw itemsError;
    
    return {
      success: true,
      data: { ...po, items: items || [] },
      message: `Purchase order ${params.poNo} has ${items?.length || 0} line items.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to fetch purchase order details: ${error.message}`,
    };
  }
}

async function getSalesOrders(
  params: { customer?: string; limit?: number },
  supabase: SupabaseClient
): Promise<ActionResult> {
  try {
    let query = supabase
      .from('sales_orders')
      .select('id, order_no, customer_name, total_qty, total_amount, order_date, status')
      .order('order_date', { ascending: false })
      .limit(params.limit || 20);
    
    if (params.customer) {
      query = query.ilike('customer_name', `%${params.customer}%`);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    return {
      success: true,
      data: data || [],
      message: `Found ${data?.length || 0} sales orders${params.customer ? ` for customer matching "${params.customer}"` : ''}.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to fetch sales orders: ${error.message}`,
    };
  }
}

async function getStatisticsSnapshot(
  params: Record<string, any>,
  supabase: SupabaseClient
): Promise<ActionResult> {
  try {
    // Get current season
    const { data: currentSeason } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date')
      .eq('is_current', true)
      .single();
    
    // Get basic stats
    const { count: styleCount } = await supabase
      .from('styles')
      .select('*', { count: 'exact', head: true });
    
    const { count: poCount } = await supabase
      .from('purchase_orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Running');
    
    const { count: supplierCount } = await supabase
      .from('suppliers')
      .select('*', { count: 'exact', head: true })
      .eq('active', true);
    
    return {
      success: true,
      data: {
        currentSeason: currentSeason?.name || 'Unknown',
        totalStyles: styleCount || 0,
        runningPOs: poCount || 0,
        activeSuppliers: supplierCount || 0,
      },
      message: `Current season: ${currentSeason?.name || 'Unknown'}. ${styleCount || 0} styles, ${poCount || 0} running POs, ${supplierCount || 0} active suppliers.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to fetch statistics: ${error.message}`,
    };
  }
}

async function createDraftPurchaseOrder(
  params: { supplierId: string; supplierName: string; lines: Array<{ styleNo: string; color: string; qty: number }> },
  supabase: SupabaseClient,
  userId: string
): Promise<ActionResult> {
  try {
    // Generate a draft PO number
    const draftPoNo = `DRAFT-${Date.now()}`;
    
    // Calculate totals
    const totalQty = params.lines.reduce((sum, line) => sum + line.qty, 0);
    
    // Insert the PO
    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert({
        po_no: draftPoNo,
        supplier: params.supplierName,
        supplier_id: params.supplierId,
        status: 'Draft',
        total_qty: totalQty,
        created_by: userId,
      })
      .select()
      .single();
    
    if (poError) throw poError;
    
    // Insert line items
    const lineItems = params.lines.map(line => ({
      po_no: draftPoNo,
      style_no: line.styleNo,
      color: line.color,
      qty: line.qty,
    }));
    
    const { error: itemsError } = await supabase
      .from('purchase_order_items')
      .insert(lineItems);
    
    if (itemsError) throw itemsError;
    
    return {
      success: true,
      data: { poNo: draftPoNo, totalQty, lineCount: params.lines.length },
      message: `Created draft purchase order ${draftPoNo} with ${params.lines.length} lines totaling ${totalQty} units.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      message: `Failed to create draft PO: ${error.message}`,
    };
  }
}

// ==================== Action Registry ====================

export const ACTION_REGISTRY: ActionDefinition[] = [
  {
    name: 'get_style_stock',
    description: 'Get current stock levels for a specific style. Returns stock quantities by color.',
    inputSchema: {
      type: 'object',
      properties: {
        styleNo: {
          type: 'string',
          description: 'The style number to look up (e.g., "1010191")',
        },
        color: {
          type: 'string',
          description: 'Optional: specific color to filter by (e.g., "WHITE", "BLACK")',
        },
      },
      required: ['styleNo'],
    },
    roles: [], // All authenticated users
    mode: 'read',
    handler: getStyleStock,
  },
  {
    name: 'get_purchase_orders',
    description: 'List purchase orders, optionally filtered by status. Shows PO number, supplier, status, and quantities.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: "Draft", "Running", "Shipped", "Completed"',
          enum: ['Draft', 'Running', 'Shipped', 'Completed'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
    roles: ['admin', 'purchase'],
    mode: 'read',
    handler: getPurchaseOrders,
  },
  {
    name: 'get_purchase_order_details',
    description: 'Get detailed information about a specific purchase order including all line items.',
    inputSchema: {
      type: 'object',
      properties: {
        poNo: {
          type: 'string',
          description: 'The purchase order number (e.g., "PO-2024-001")',
        },
      },
      required: ['poNo'],
    },
    roles: ['admin', 'purchase'],
    mode: 'read',
    handler: getPurchaseOrderDetails,
  },
  {
    name: 'get_sales_orders',
    description: 'List recent sales orders, optionally filtered by customer name.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'Filter by customer name (partial match)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
    roles: ['admin', 'sales', 'finance'],
    mode: 'read',
    handler: getSalesOrders,
  },
  {
    name: 'get_statistics_snapshot',
    description: 'Get a quick overview of key business statistics: current season, style count, running POs, active suppliers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    roles: [],
    mode: 'read',
    handler: getStatisticsSnapshot,
  },
  {
    name: 'create_draft_purchase_order',
    description: 'Create a new draft purchase order. The PO will be in Draft status and can be reviewed before being finalized.',
    inputSchema: {
      type: 'object',
      properties: {
        supplierId: {
          type: 'string',
          description: 'The supplier UUID',
        },
        supplierName: {
          type: 'string',
          description: 'The supplier name',
        },
        lines: {
          type: 'array',
          description: 'Array of line items, each with styleNo, color, and qty',
        },
      },
      required: ['supplierId', 'supplierName', 'lines'],
    },
    roles: ['admin', 'purchase'],
    mode: 'write',
    handler: createDraftPurchaseOrder,
  },
];

// Helper to get action by name
export function getAction(name: string): ActionDefinition | undefined {
  return ACTION_REGISTRY.find(a => a.name === name);
}

// Helper to check if user has access to action
export function canUserAccessAction(action: ActionDefinition, userRoles: string[]): boolean {
  // If no roles specified, all authenticated users can access
  if (action.roles.length === 0) return true;
  // Admin can access everything
  if (userRoles.includes('admin')) return true;
  // Check if user has any of the required roles
  return action.roles.some(role => userRoles.includes(role));
}

// Build action descriptions for LLM
export function getActionsForLLM(userRoles: string[]): string {
  const accessibleActions = ACTION_REGISTRY.filter(a => canUserAccessAction(a, userRoles));
  
  return accessibleActions.map(action => {
    const paramsDesc = Object.entries(action.inputSchema.properties)
      .map(([key, val]) => `  - ${key} (${val.type}${action.inputSchema.required?.includes(key) ? ', required' : ''}): ${val.description}`)
      .join('\n');
    
    return `**${action.name}** [${action.mode}]
${action.description}
Parameters:
${paramsDesc || '  (none)'}`;
  }).join('\n\n');
}
