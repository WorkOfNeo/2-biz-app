import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SuggestionLine = {
  style_no: string;
  color: string;
  suggested_qty: number;
  reasoning?: string;
  priority?: 'high' | 'medium' | 'low';
  // User adjustments
  adjusted_qty?: number;
};

type SupplierCommit = {
  supplier_name: string;
  supplier_id?: string;
  lines: SuggestionLine[];
  verdict?: 'approved' | 'adjusted' | 'skipped';
  notes?: string;
};

type OrderItem = {
  style_no: string;
  color: string;
  quantities: number[]; // per-size quantities
  total: number;
};

/**
 * Distribute a total quantity across sizes based on historical distribution
 * or fall back to even distribution
 */
async function distributeBySizes(
  supabase: any,
  styleNo: string,
  color: string,
  totalQty: number
): Promise<{ sizes: string[]; quantities: number[] }> {
  // Try to get size distribution from style_stock
  const { data: stockData } = await supabase
    .from('style_stock')
    .select('sizes, values')
    .eq('style_no', styleNo)
    .eq('color', color)
    .eq('section', 'Stock')
    .order('scraped_at', { ascending: false })
    .limit(1);

  let sizes: string[] = [];
  let distribution: number[] = [];

  if (stockData && stockData.length > 0 && stockData[0].sizes) {
    sizes = stockData[0].sizes || [];
    
    // Try to get historical sales distribution
    const { data: historicalData } = await supabase
      .from('historical_sales')
      .select('size, quantity')
      .eq('style_no', styleNo)
      .eq('color', color);

    if (historicalData && historicalData.length > 0) {
      // Aggregate by size
      const sizeQty: Record<string, number> = {};
      for (const row of historicalData) {
        const size = String(row.size).trim();
        sizeQty[size] = (sizeQty[size] || 0) + (row.quantity || 0);
      }

      const totalHistorical = Object.values(sizeQty).reduce((a, b) => a + b, 0);
      
      if (totalHistorical > 0) {
        // Distribute based on historical ratios
        const exact = sizes.map(s => {
          const qty = sizeQty[s] || 0;
          return (qty / totalHistorical) * totalQty;
        });
        
        const floored = exact.map(v => Math.floor(v));
        let remaining = totalQty - floored.reduce((a, b) => a + b, 0);
        
        // Distribute remainder to sizes with highest fractions
        const fractional = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
        fractional.sort((a, b) => b.frac - a.frac);
        
        for (let k = 0; k < remaining && k < fractional.length; k++) {
          const item = fractional[k];
          if (item && item.i >= 0 && item.i < floored.length) {
            floored[item.i] = (floored[item.i] || 0) + 1;
          }
        }
        
        distribution = floored;
      }
    }
    
    // Fall back to even distribution if no historical data
    if (distribution.length === 0) {
      const perSize = Math.floor(totalQty / sizes.length);
      const remainder = totalQty % sizes.length;
      distribution = sizes.map((_, i) => perSize + (i < remainder ? 1 : 0));
    }
  } else {
    // No stock data, use default sizes
    sizes = ['S', 'M', 'L', 'XL'];
    const perSize = Math.floor(totalQty / sizes.length);
    const remainder = totalQty % sizes.length;
    distribution = sizes.map((_, i) => perSize + (i < remainder ? 1 : 0));
  }

  return { sizes, quantities: distribution };
}

/**
 * Generate a unique PO number for APP-created orders
 */
function generatePoNo(): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `APP-${year}${month}${day}-${rand}`;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const {
      purchaseRunId,
      suppliers,
      createSeparatePOs = true, // One PO per supplier (default) or combined
    } = body as {
      purchaseRunId: string;
      suppliers: SupplierCommit[];
      createSeparatePOs?: boolean;
    };

    if (!purchaseRunId) {
      return NextResponse.json({ error: 'purchaseRunId is required' }, { status: 400 });
    }

    if (!Array.isArray(suppliers) || suppliers.length === 0) {
      return NextResponse.json({ error: 'suppliers array is required' }, { status: 400 });
    }

    console.log('[AI Commit] Processing', suppliers.length, 'suppliers');

    // Fetch purchase run to get context
    const { data: purchaseRun, error: runError } = await supabase
      .from('purchase_ai_runs')
      .select('*')
      .eq('id', purchaseRunId)
      .single();

    if (runError || !purchaseRun) {
      return NextResponse.json({ error: 'Purchase run not found' }, { status: 404 });
    }

    const createdPoIds: number[] = [];
    const results: Array<{
      supplier: string;
      poId?: number;
      poNo?: string;
      itemCount: number;
      totalQty: number;
      status: 'created' | 'skipped' | 'error';
      error?: string;
    }> = [];

    // Process each supplier
    for (const supplierCommit of suppliers) {
      const { supplier_name, lines, verdict } = supplierCommit;

      // Skip if marked as skipped
      if (verdict === 'skipped') {
        results.push({
          supplier: supplier_name,
          itemCount: 0,
          totalQty: 0,
          status: 'skipped',
        });
        continue;
      }

      // Filter lines with quantity > 0
      const validLines = lines.filter(line => {
        const qty = line.adjusted_qty ?? line.suggested_qty;
        return qty > 0;
      });

      if (validLines.length === 0) {
        results.push({
          supplier: supplier_name,
          itemCount: 0,
          totalQty: 0,
          status: 'skipped',
        });
        continue;
      }

      try {
        // Build order items with size distribution
        const orderItems: OrderItem[] = [];
        let totalOrderQty = 0;

        for (const line of validLines) {
          const qty = line.adjusted_qty ?? line.suggested_qty;
          const { sizes, quantities } = await distributeBySizes(
            supabase,
            line.style_no,
            line.color,
            qty
          );

          const itemTotal = quantities.reduce((a, b) => a + b, 0);
          totalOrderQty += itemTotal;

          orderItems.push({
            style_no: line.style_no,
            color: line.color,
            quantities,
            total: itemTotal,
          });
        }

        // Create APP PO
        const poNo = generatePoNo();

        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier: supplier_name,
            styles: orderItems.length,
            ordered: totalOrderQty,
            meta: {
              items: orderItems,
              source: 'ai_suggestions',
              purchase_run_id: purchaseRunId,
              created_from_ai: true,
            },
          })
          .select('id, po_no')
          .single();

        if (poError || !newPo) {
          console.error('[AI Commit] Failed to create PO for', supplier_name, poError);
          results.push({
            supplier: supplier_name,
            itemCount: orderItems.length,
            totalQty: totalOrderQty,
            status: 'error',
            error: poError?.message || 'Failed to create PO',
          });
          continue;
        }

        createdPoIds.push(newPo.id);
        results.push({
          supplier: supplier_name,
          poId: newPo.id,
          poNo: newPo.po_no,
          itemCount: orderItems.length,
          totalQty: totalOrderQty,
          status: 'created',
        });

        console.log('[AI Commit] Created PO', newPo.po_no, 'for', supplier_name, {
          items: orderItems.length,
          qty: totalOrderQty,
        });
      } catch (err: any) {
        console.error('[AI Commit] Error processing', supplier_name, err);
        results.push({
          supplier: supplier_name,
          itemCount: validLines.length,
          totalQty: 0,
          status: 'error',
          error: err.message,
        });
      }
    }

    // Build user feedback for storage
    const userFeedback: Record<string, any> = {};
    for (const supplierCommit of suppliers) {
      userFeedback[supplierCommit.supplier_name] = {
        verdict: supplierCommit.verdict || 'approved',
        notes: supplierCommit.notes || null,
        adjustments: supplierCommit.lines
          .filter(l => l.adjusted_qty !== undefined && l.adjusted_qty !== l.suggested_qty)
          .map(l => ({
            style_no: l.style_no,
            color: l.color,
            original: l.suggested_qty,
            adjusted: l.adjusted_qty,
          })),
      };
    }

    // Update purchase_ai_runs with results
    const { error: updateError } = await supabase
      .from('purchase_ai_runs')
      .update({
        created_app_po_ids: createdPoIds,
        user_feedback: userFeedback,
        status: 'completed',
      })
      .eq('id', purchaseRunId);

    if (updateError) {
      console.error('[AI Commit] Failed to update purchase_ai_runs:', updateError);
    }

    const totalCreated = results.filter(r => r.status === 'created').length;
    const totalSkipped = results.filter(r => r.status === 'skipped').length;
    const totalErrors = results.filter(r => r.status === 'error').length;

    console.log('[AI Commit] Complete', {
      purchaseRunId,
      created: totalCreated,
      skipped: totalSkipped,
      errors: totalErrors,
      poIds: createdPoIds,
    });

    return NextResponse.json({
      success: true,
      summary: {
        created: totalCreated,
        skipped: totalSkipped,
        errors: totalErrors,
        totalPOs: createdPoIds.length,
      },
      results,
      createdPoIds,
    });
  } catch (error: any) {
    console.error('[AI Commit] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

