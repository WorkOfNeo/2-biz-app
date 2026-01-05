import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Get size distribution for a list of style/color combinations
 * Returns the sizes available and suggested distribution based on historical data
 */

type StyleColorRequest = {
  style_no: string;
  color: string;
  suggested_qty: number;
};

type SizeDistribution = {
  style_no: string;
  color: string;
  sizes: string[];
  quantities: number[];
  total: number;
  source: 'historical' | 'even' | 'default';
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { items } = body as { items: StyleColorRequest[] };

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }

    console.log('[Sizes API] Computing size distribution for', items.length, 'items');

    const results: SizeDistribution[] = [];

    for (const item of items) {
      const { style_no, color, suggested_qty } = item;
      
      let sizes: string[] = [];
      let quantities: number[] = [];
      let source: 'historical' | 'even' | 'default' = 'default';

      // Try to get sizes from style_stock
      const { data: stockData } = await supabase
        .from('style_stock')
        .select('sizes, values')
        .eq('style_no', style_no)
        .eq('color', color)
        .eq('section', 'Stock')
        .order('scraped_at', { ascending: false })
        .limit(1);

      if (stockData && stockData.length > 0 && stockData[0].sizes) {
        sizes = stockData[0].sizes || [];
        
        // Try to get historical sales distribution
        const { data: historicalData } = await supabase
          .from('historical_sales')
          .select('size, quantity')
          .eq('style_no', style_no)
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
              return (qty / totalHistorical) * suggested_qty;
            });
            
            const floored = exact.map(v => Math.floor(v));
            let remaining = suggested_qty - floored.reduce((a, b) => a + b, 0);
            
            // Distribute remainder to sizes with highest fractions
            const fractional = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
            fractional.sort((a, b) => b.frac - a.frac);
            
            for (let k = 0; k < remaining && k < fractional.length; k++) {
              const idx = fractional[k]?.i;
              if (idx !== undefined && idx >= 0 && idx < floored.length) {
                floored[idx] = (floored[idx] || 0) + 1;
              }
            }
            
            quantities = floored;
            source = 'historical';
          }
        }
        
        // Fall back to even distribution if no historical data
        if (quantities.length === 0 && sizes.length > 0) {
          const perSize = Math.floor(suggested_qty / sizes.length);
          const remainder = suggested_qty % sizes.length;
          quantities = sizes.map((_, i) => perSize + (i < remainder ? 1 : 0));
          source = 'even';
        }
      }
      
      // Fall back to default sizes
      if (sizes.length === 0) {
        // Try to get size_set from styles table
        const { data: styleData } = await supabase
          .from('styles')
          .select('size_set')
          .eq('style_no', style_no)
          .single();
        
        if (styleData?.size_set && Array.isArray(styleData.size_set)) {
          sizes = styleData.size_set;
        } else {
          // Default to common sizes
          sizes = ['S', 'M', 'L', 'XL'];
        }
        
        const perSize = Math.floor(suggested_qty / sizes.length);
        const remainder = suggested_qty % sizes.length;
        quantities = sizes.map((_, i) => perSize + (i < remainder ? 1 : 0));
        source = 'default';
      }

      results.push({
        style_no,
        color,
        sizes,
        quantities,
        total: quantities.reduce((a, b) => a + b, 0),
        source,
      });
    }

    console.log('[Sizes API] Computed distribution for', results.length, 'items');

    return NextResponse.json({
      success: true,
      distributions: results,
    });
  } catch (error: any) {
    console.error('[Sizes API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

