import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type OrderItem = {
  style_no: string;
  color: string;
  quantities: number[];
  total: number;
  sizes: string[];
  pressure?: {
    weights: number[];
    normalized: number[];
  };
  targetBuyUnits?: number;
};

type CreateInput = {
  items: OrderItem[];
  deadline?: string; // ISO date string
  notes?: string;
};

/**
 * Generate a unique PO number for smart draft orders
 */
function generatePoNo(): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SD-${year}${month}${day}-${rand}`;
}

/**
 * Calculate follow-up reminder dates based on supplier lead time and deadline
 */
function calculateFollowups(
  leadTimeDays: number,
  travelTimeDays: number,
  deadline?: string
): { type: string; date: string; description: string }[] {
  const followups: { type: string; date: string; description: string }[] = [];
  const now = new Date();
  
  // Calculate expected dates
  const totalLeadTime = leadTimeDays + travelTimeDays;
  
  // Reminder 1: After placing order (1-2 days)
  const orderPlaced = new Date(now);
  orderPlaced.setDate(orderPlaced.getDate() + 2);
  followups.push({
    type: 'order_confirmation',
    date: orderPlaced.toISOString().split('T')[0] || '',
    description: 'Confirm order receipt with supplier',
  });
  
  // Reminder 2: Mid-production check (at ~40% of lead time)
  const midProduction = new Date(now);
  midProduction.setDate(midProduction.getDate() + Math.floor(leadTimeDays * 0.4));
  if (midProduction > orderPlaced) {
    followups.push({
      type: 'production_check',
      date: midProduction.toISOString().split('T')[0] || '',
      description: 'Check production status with supplier',
    });
  }
  
  // Reminder 3: Pre-shipment (at ~80% of lead time)
  const preShipment = new Date(now);
  preShipment.setDate(preShipment.getDate() + Math.floor(leadTimeDays * 0.8));
  if (preShipment > midProduction) {
    followups.push({
      type: 'pre_shipment',
      date: preShipment.toISOString().split('T')[0] || '',
      description: 'Confirm shipment date and details',
    });
  }
  
  // Reminder 4: Expected arrival (lead time + travel time)
  const expectedArrival = new Date(now);
  expectedArrival.setDate(expectedArrival.getDate() + totalLeadTime);
  followups.push({
    type: 'expected_arrival',
    date: expectedArrival.toISOString().split('T')[0] || '',
    description: 'Expected delivery date',
  });
  
  // If deadline provided, add deadline-based reminder
  if (deadline) {
    const deadlineDate = new Date(deadline);
    const reminderBeforeDeadline = new Date(deadlineDate);
    reminderBeforeDeadline.setDate(reminderBeforeDeadline.getDate() - 7);
    
    if (reminderBeforeDeadline > now) {
      followups.push({
        type: 'deadline_reminder',
        date: reminderBeforeDeadline.toISOString().split('T')[0] || '',
        description: `7 days before deadline (${deadline})`,
      });
    }
  }
  
  // Sort by date
  followups.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  
  return followups;
}

/**
 * POST /api/purchase/smart-draft/create
 * 
 * Creates APP POs from smart draft items, grouped by supplier.
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { items, deadline, notes } = body as CreateInput;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }

    // Get unique style numbers to fetch supplier info
    const styleNos = Array.from(new Set(items.map(i => i.style_no)));

    // Fetch style metadata including supplier
    const { data: stylesData, error: stylesError } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier')
      .in('style_no', styleNos);

    if (stylesError) {
      return NextResponse.json({ error: stylesError.message }, { status: 500 });
    }

    const styleMetaMap = new Map<string, { style_name: string | null; supplier: string | null }>();
    for (const s of stylesData || []) {
      styleMetaMap.set(s.style_no, {
        style_name: s.style_name,
        supplier: s.supplier,
      });
    }

    // Fetch supplier details for lead times
    const supplierNames = Array.from(new Set(
      (stylesData || []).map(s => s.supplier).filter(Boolean)
    ));

    const { data: suppliersData } = await supabase
      .from('suppliers')
      .select('name, lead_time_days, travel_time_days')
      .in('name', supplierNames);

    const supplierDetailsMap = new Map<string, { lead_time_days: number; travel_time_days: number }>();
    for (const s of suppliersData || []) {
      supplierDetailsMap.set(s.name, {
        lead_time_days: s.lead_time_days || 49, // Default 7 weeks
        travel_time_days: s.travel_time_days || 4,
      });
    }

    // Group items by supplier
    const itemsBySupplier = new Map<string, OrderItem[]>();
    for (const item of items) {
      const meta = styleMetaMap.get(item.style_no);
      const supplier = meta?.supplier || 'Unknown Supplier';

      if (!itemsBySupplier.has(supplier)) {
        itemsBySupplier.set(supplier, []);
      }
      itemsBySupplier.get(supplier)!.push(item);
    }

    const createdPoIds: number[] = [];
    const results: Array<{
      supplier: string;
      poId?: number;
      poNo?: string;
      itemCount: number;
      totalQty: number;
      status: 'created' | 'error';
      error?: string;
      followups?: { type: string; date: string; description: string }[];
    }> = [];

    // Create one APP PO per supplier
    for (const [supplier, supplierItems] of itemsBySupplier) {
      try {
        const orderItems = supplierItems.map(item => ({
          style_no: item.style_no,
          color: item.color,
          quantities: item.quantities,
          total: item.total,
          sizes: item.sizes,
        }));

        const totalOrderQty = orderItems.reduce((sum, i) => sum + i.total, 0);
        const poNo = generatePoNo();

        // Get supplier lead times
        const supplierDetails = supplierDetailsMap.get(supplier) || {
          lead_time_days: 49,
          travel_time_days: 4,
        };

        // Calculate follow-up reminders
        const followups = calculateFollowups(
          supplierDetails.lead_time_days,
          supplierDetails.travel_time_days,
          deadline
        );

        // Build meta with pressure info
        const itemsWithMeta = supplierItems.map(item => ({
          style_no: item.style_no,
          color: item.color,
          quantities: item.quantities,
          total: item.total,
          pressure: item.pressure,
          targetBuyUnits: item.targetBuyUnits,
        }));

        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier,
            styles: orderItems.length,
            ordered: totalOrderQty,
            meta: {
              items: itemsWithMeta,
              source: 'smart_draft',
              created_from_smart_draft: true,
              deadline: deadline || null,
              notes: notes || null,
              followups,
              supplier_lead_time_days: supplierDetails.lead_time_days,
              supplier_travel_time_days: supplierDetails.travel_time_days,
            },
          })
          .select('id, po_no')
          .single();

        if (poError || !newPo) {
          console.error('[smart-draft/create] Failed to create PO for', supplier, poError);
          results.push({
            supplier,
            itemCount: orderItems.length,
            totalQty: totalOrderQty,
            status: 'error',
            error: poError?.message || 'Failed to create PO',
          });
          continue;
        }

        createdPoIds.push(newPo.id);
        results.push({
          supplier,
          poId: newPo.id,
          poNo: newPo.po_no,
          itemCount: orderItems.length,
          totalQty: totalOrderQty,
          status: 'created',
          followups,
        });

        console.log('[smart-draft/create] Created PO', newPo.po_no, 'for', supplier, {
          items: orderItems.length,
          qty: totalOrderQty,
        });
      } catch (err: any) {
        console.error('[smart-draft/create] Error processing', supplier, err);
        results.push({
          supplier,
          itemCount: supplierItems.length,
          totalQty: 0,
          status: 'error',
          error: err.message,
        });
      }
    }

    const totalCreated = results.filter(r => r.status === 'created').length;
    const totalErrors = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      success: true,
      summary: {
        created: totalCreated,
        errors: totalErrors,
        totalPOs: createdPoIds.length,
      },
      results,
      createdPoIds,
    });
  } catch (error: any) {
    console.error('[smart-draft/create] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

