import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Types from Quick PO Flow
interface OrderPlan {
  style_no: string;
  style_name: string;
  color: string;
  total_qty: number;
  size_breakdown: Record<string, number>;
  size_source: 'historical' | 'default_assortment' | 'historical_only' | 'default_only' | 'smart_hybrid';
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

// Generate a PO number
function generatePoNo(): string {
  const date = new Date();
  const prefix = 'QPO';
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}-${dateStr}-${random}`;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { order_plans, color_breakdown_plans } = body as {
      order_plans?: OrderPlan[];
      color_breakdown_plans?: ColorBreakdownPlan[];
    };
    
    const results: Array<{
      type: 'order' | 'coloring';
      style_no: string;
      color?: string;
      poId?: string;
      poNo?: string;
      qty: number;
      status: 'created' | 'error';
      error?: string;
    }> = [];
    
    // Process order plans - group by supplier if possible
    const ordersToCreate = (order_plans || []).filter(p => p.action === 'create_po');
    
    // Get supplier info for styles
    const styleNos = [...new Set(ordersToCreate.map(o => o.style_no))];
    const { data: stylesData } = await supabase
      .from('styles')
      .select('style_no, supplier')
      .in('style_no', styleNos);
    
    const styleToSupplier = new Map<string, string>();
    for (const style of (stylesData || [])) {
      styleToSupplier.set(style.style_no, style.supplier || 'Unknown');
    }
    
    // Group orders by supplier
    const ordersBySupplier = new Map<string, OrderPlan[]>();
    for (const order of ordersToCreate) {
      const supplier = styleToSupplier.get(order.style_no) || 'Unknown';
      if (!ordersBySupplier.has(supplier)) {
        ordersBySupplier.set(supplier, []);
      }
      ordersBySupplier.get(supplier)!.push(order);
    }
    
    // Create one PO per supplier
    for (const [supplier, orders] of ordersBySupplier) {
      try {
        const poNo = generatePoNo();
        const totalQty = orders.reduce((sum, o) => sum + o.total_qty, 0);
        
        // Build items array for meta
        const items = orders.map(order => {
          const sizes = Object.keys(order.size_breakdown).sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return a.localeCompare(b);
          });
          const quantities = sizes.map(s => order.size_breakdown[s] || 0);
          
          return {
            style_no: order.style_no,
            style_name: order.style_name,
            color: order.color,
            sizes,
            quantities,
            total: order.total_qty,
            size_source: order.size_source,
          };
        });
        
        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier,
            styles: orders.length,
            ordered: totalQty,
            meta: {
              items,
              source: 'quick_po_flow',
              created_from_quick_po: true,
            },
          })
          .select('id, po_no')
          .single();
        
        if (poError || !newPo) {
          console.error('[Quick PO Create] Failed to create PO for', supplier, poError);
          for (const order of orders) {
            results.push({
              type: 'order',
              style_no: order.style_no,
              color: order.color,
              qty: order.total_qty,
              status: 'error',
              error: poError?.message || 'Failed to create PO',
            });
          }
          continue;
        }
        
        console.log('[Quick PO Create] Created PO', newPo.po_no, 'for', supplier, {
          items: orders.length,
          qty: totalQty,
        });
        
        for (const order of orders) {
          results.push({
            type: 'order',
            style_no: order.style_no,
            color: order.color,
            poId: newPo.id,
            poNo: newPo.po_no,
            qty: order.total_qty,
            status: 'created',
          });
        }
      } catch (err: any) {
        console.error('[Quick PO Create] Error for supplier', supplier, err);
        for (const order of orders) {
          results.push({
            type: 'order',
            style_no: order.style_no,
            color: order.color,
            qty: order.total_qty,
            status: 'error',
            error: err.message,
          });
        }
      }
    }
    
    // Process coloring plans
    for (const plan of (color_breakdown_plans || [])) {
      try {
        const poNo = generatePoNo();
        const supplier = styleToSupplier.get(plan.style_no) || 'Unknown';
        
        // Build items for each color in the breakdown
        const items = Object.entries(plan.color_distribution).map(([color, dist]) => ({
          style_no: plan.style_no,
          style_name: plan.style_name,
          color,
          total: dist.qty,
          source_color: plan.source_color,
          percentage: dist.pct,
        }));
        
        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier,
            styles: items.length,
            ordered: plan.target_quantity,
            meta: {
              items,
              source: 'quick_po_flow_coloring',
              created_from_quick_po: true,
              coloring_job: true,
              source_style: plan.style_no,
              source_color: plan.source_color,
              target_quantity: plan.target_quantity,
              color_distribution: plan.color_distribution,
            },
          })
          .select('id, po_no')
          .single();
        
        if (poError || !newPo) {
          console.error('[Quick PO Create] Failed to create coloring PO', poError);
          results.push({
            type: 'coloring',
            style_no: plan.style_no,
            qty: plan.target_quantity,
            status: 'error',
            error: poError?.message || 'Failed to create coloring PO',
          });
          continue;
        }
        
        console.log('[Quick PO Create] Created coloring PO', newPo.po_no, 'for', plan.style_no);
        
        results.push({
          type: 'coloring',
          style_no: plan.style_no,
          poId: newPo.id,
          poNo: newPo.po_no,
          qty: plan.target_quantity,
          status: 'created',
        });
      } catch (err: any) {
        console.error('[Quick PO Create] Error for coloring', plan.style_no, err);
        results.push({
          type: 'coloring',
          style_no: plan.style_no,
          qty: plan.target_quantity,
          status: 'error',
          error: err.message,
        });
      }
    }
    
    const success = results.filter(r => r.status === 'created').length;
    const failed = results.filter(r => r.status === 'error').length;
    
    return NextResponse.json({
      success,
      failed,
      results,
    });
    
  } catch (error: any) {
    console.error('[Quick PO Create] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
