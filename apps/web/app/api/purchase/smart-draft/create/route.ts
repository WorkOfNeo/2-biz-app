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
 * Calculate follow-up reminder dates based on supplier lead time
 * 
 * Follow-up strategy:
 * 1. Initial confirmation (2 days after order) - Send order confirmation request
 * 2. 2 weeks before ETD - Check production status
 * 3. 1 week before ETD - Confirm everything on track
 * 4. ETD day - Request shipping confirmation
 */
function calculateFollowups(
  leadTimeDays: number,
  travelTimeDays: number,
  deadline?: string
): { type: string; date: string; description: string; draftType?: string }[] {
  const followups: { type: string; date: string; description: string; draftType?: string }[] = [];
  const now = new Date();
  
  // Calculate ETD (Ex-Factory Date = today + leadTimeDays)
  const etd = new Date(now);
  etd.setDate(etd.getDate() + leadTimeDays);
  
  // 1. Initial confirmation (2 days after order placed)
  const initialConfirm = new Date(now);
  initialConfirm.setDate(initialConfirm.getDate() + 2);
  followups.push({
    type: 'order_confirmation',
    date: initialConfirm.toISOString().split('T')[0] || '',
    description: 'Send order confirmation request to supplier',
    draftType: 'initial',
  });
  
  // 2. 2 weeks before ETD
  const twoWeeksBefore = new Date(etd);
  twoWeeksBefore.setDate(twoWeeksBefore.getDate() - 14);
  if (twoWeeksBefore > initialConfirm) {
    followups.push({
      type: 'followup_2weeks',
      date: twoWeeksBefore.toISOString().split('T')[0] || '',
      description: '2 weeks before ETD - Check production status',
      draftType: 'followup_2weeks',
    });
  }
  
  // 3. 1 week before ETD
  const oneWeekBefore = new Date(etd);
  oneWeekBefore.setDate(oneWeekBefore.getDate() - 7);
  if (oneWeekBefore > initialConfirm && oneWeekBefore > twoWeeksBefore) {
    followups.push({
      type: 'followup_1week',
      date: oneWeekBefore.toISOString().split('T')[0] || '',
      description: '1 week before ETD - Confirm on track',
      draftType: 'followup_1week',
    });
  }
  
  // 4. ETD day - Shipping confirmation
  followups.push({
    type: 'followup_etd',
    date: etd.toISOString().split('T')[0] || '',
    description: 'ETD - Request shipping confirmation',
    draftType: 'followup_etd',
  });
  
  // 5. ETA (Expected arrival)
  const eta = new Date(etd);
  eta.setDate(eta.getDate() + travelTimeDays);
  followups.push({
    type: 'expected_arrival',
    date: eta.toISOString().split('T')[0] || '',
    description: 'Expected delivery date',
  });
  
  // If deadline provided, add reminder 7 days before
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

