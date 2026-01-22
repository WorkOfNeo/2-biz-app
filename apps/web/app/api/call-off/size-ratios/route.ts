import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/call-off/size-ratios
 * 
 * Compute size-% ratios from historical sales data for each style.
 * Uses per-style month overrides or falls back to default months.
 * 
 * Input:
 * {
 *   styleNos: string[],
 *   byStyleMonths?: Record<string, string[]>,  // { style_no: ['2024-01', '2024-02'] }
 *   defaultMonths: string[]  // ['2024-01', '2024-02']
 * }
 * 
 * Output:
 * {
 *   [style_no]: {
 *     sizes: string[],
 *     bySizeQty: Record<string, number>,
 *     totalQty: number,
 *     ratioBySize: Record<string, number>,  // 0.0 - 1.0
 *     monthsUsed: string[],
 *     isOverride: boolean,
 *     fallbackToDefault: boolean  // true if no historical data found
 *   }
 * }
 */

// Default size assortments when no historical data
const DEFAULT_ASSORTMENTS = {
  // Numeric 34-46: 36-46 ratio 1-2-2-2-2-1, 34 is loose (handled separately)
  numeric: {
    sizes: ['34', '36', '38', '40', '42', '44', '46'],
    ratios: [0, 0.1, 0.2, 0.2, 0.2, 0.2, 0.1], // 34 gets 0 by default (loose)
  },
  // S-XXL: 1-2-2-2-1
  letter: {
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    ratios: [0.125, 0.25, 0.25, 0.25, 0.125],
  },
};

// Detect size type
function detectSizeType(sizes: string[]): 'numeric' | 'letter' | 'unknown' {
  const numericPattern = /^\d+$/;
  const letterPattern = /^(XS|S|M|L|XL|XXL|XXXL)$/i;
  
  const numericCount = sizes.filter(s => numericPattern.test(s)).length;
  const letterCount = sizes.filter(s => letterPattern.test(s)).length;
  
  if (numericCount > letterCount) return 'numeric';
  if (letterCount > numericCount) return 'letter';
  return 'unknown';
}

// Get default ratio for a size
function getDefaultRatio(size: string, sizeType: 'numeric' | 'letter' | 'unknown'): number {
  if (sizeType === 'numeric') {
    const idx = DEFAULT_ASSORTMENTS.numeric.sizes.indexOf(size);
    if (idx >= 0) return DEFAULT_ASSORTMENTS.numeric.ratios[idx] ?? 0;
    return 0.14; // Fallback for unknown numeric sizes
  }
  if (sizeType === 'letter') {
    const idx = DEFAULT_ASSORTMENTS.letter.sizes.indexOf(size.toUpperCase());
    if (idx >= 0) return DEFAULT_ASSORTMENTS.letter.ratios[idx] ?? 0;
    return 0.2; // Fallback for unknown letter sizes
  }
  return 1 / 7; // Even distribution fallback
}

// Helper to normalize size strings: "44.00" -> "44"
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

type StyleRatioResult = {
  sizes: string[];
  bySizeQty: Record<string, number>;
  totalQty: number;
  ratioBySize: Record<string, number>;
  monthsUsed: string[];
  isOverride: boolean;
  fallbackToDefault: boolean;
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { styleNos, byStyleMonths, defaultMonths } = body as {
      styleNos: string[];
      byStyleMonths?: Record<string, string[]>;
      defaultMonths: string[];
    };
    
    if (!Array.isArray(styleNos) || styleNos.length === 0) {
      return NextResponse.json({ error: 'styleNos array is required' }, { status: 400 });
    }
    
    if (!Array.isArray(defaultMonths) || defaultMonths.length === 0) {
      return NextResponse.json({ error: 'defaultMonths array is required' }, { status: 400 });
    }

    // Collect all months we need to query
    const allMonthsSet = new Set<string>(defaultMonths);
    if (byStyleMonths) {
      Object.values(byStyleMonths).forEach(months => {
        months.forEach(m => allMonthsSet.add(m));
      });
    }
    const allMonths = Array.from(allMonthsSet).sort();
    
    // Calculate date range from all months
    const dateRanges: Array<{ start: string; end: string }> = [];
    for (const month of allMonths) {
      const [year, m] = month.split('-').map(Number);
      if (!year || !m || m < 1 || m > 12) continue;
      const start = new Date(year, m - 1, 1);
      const end = new Date(year, m, 0);
      dateRanges.push({
        start: start.toISOString().split('T')[0] as string,
        end: end.toISOString().split('T')[0] as string
      });
    }
    
    if (dateRanges.length === 0) {
      return NextResponse.json({ error: 'No valid months provided' }, { status: 400 });
    }
    
    const allStarts = dateRanges.map(r => r.start).sort();
    const allEnds = dateRanges.map(r => r.end).sort();
    const queryStart = allStarts[0] || '';
    const queryEnd = allEnds[allEnds.length - 1] || '';

    // Fetch all historical sales for these styles in the overall date range
    const { data: rawData, error } = await supabase
      .from('historical_sales')
      .select('style_no, color, size, quantity, date')
      .in('style_no', styleNos)
      .gte('date', queryStart)
      .lte('date', queryEnd)
      .limit(100000);

    if (error) {
      console.error('[size-ratios] DB error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Index data by style_no
    const dataByStyle = new Map<string, Array<{ size: string; quantity: number; date: string }>>();
    for (const row of (rawData || [])) {
      if (!dataByStyle.has(row.style_no)) {
        dataByStyle.set(row.style_no, []);
      }
      dataByStyle.get(row.style_no)!.push({
        size: normalizeSize(row.size),
        quantity: row.quantity,
        date: row.date
      });
    }

    // Also fetch style_stock to get available sizes for each style
    const { data: stockData } = await supabase
      .from('style_stock')
      .select('style_no, sizes')
      .in('style_no', styleNos)
      .eq('section', 'Stock');

    // Build style -> sizes map
    const styleToSizes = new Map<string, string[]>();
    for (const row of (stockData || [])) {
      if (row.sizes && Array.isArray(row.sizes)) {
        const normalized = row.sizes.map(normalizeSize);
        if (!styleToSizes.has(row.style_no) || normalized.length > (styleToSizes.get(row.style_no)?.length || 0)) {
          styleToSizes.set(row.style_no, normalized);
        }
      }
    }

    // Compute ratios for each style
    const results: Record<string, StyleRatioResult> = {};
    
    for (const styleNo of styleNos) {
      const isOverride = byStyleMonths && byStyleMonths[styleNo] && byStyleMonths[styleNo].length > 0;
      const monthsToUse = isOverride ? byStyleMonths![styleNo] : defaultMonths;
      const monthSet = new Set(monthsToUse);
      
      // Filter historical data to only include rows in the selected months
      const styleData = dataByStyle.get(styleNo) || [];
      const filteredData = styleData.filter(row => {
        const rowMonth = row.date?.substring(0, 7);
        return rowMonth && monthSet.has(rowMonth);
      });
      
      // Get sizes for this style
      let sizes = styleToSizes.get(styleNo) || [];
      
      // Aggregate by size
      const bySizeQty: Record<string, number> = {};
      let totalQty = 0;
      
      for (const row of filteredData) {
        bySizeQty[row.size] = (bySizeQty[row.size] || 0) + row.quantity;
        totalQty += row.quantity;
      }
      
      // If we have historical data, derive sizes from it if not from stock
      if (totalQty > 0 && sizes.length === 0) {
        sizes = Object.keys(bySizeQty).sort((a, b) => {
          const numA = parseFloat(a);
          const numB = parseFloat(b);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.localeCompare(b);
        });
      }
      
      // Compute ratios
      const ratioBySize: Record<string, number> = {};
      let fallbackToDefault = totalQty === 0;
      
      if (totalQty > 0) {
        // Use historical data
        for (const size of sizes) {
          ratioBySize[size] = (bySizeQty[size] || 0) / totalQty;
        }
      } else {
        // Fallback to default assortment
        const sizeType = detectSizeType(sizes);
        for (const size of sizes) {
          ratioBySize[size] = getDefaultRatio(size, sizeType);
        }
        // Normalize to sum to 1
        const sum = Object.values(ratioBySize).reduce((a, b) => a + b, 0);
        if (sum > 0) {
          for (const size of sizes) {
            ratioBySize[size] = (ratioBySize[size] || 0) / sum;
          }
        }
      }
      
      results[styleNo] = {
        sizes,
        bySizeQty,
        totalQty,
        ratioBySize,
        monthsUsed: monthsToUse || [],
        isOverride: !!isOverride,
        fallbackToDefault
      };
    }

    return NextResponse.json({
      results,
      meta: {
        stylesProcessed: styleNos.length,
        defaultMonths,
        overrideCount: byStyleMonths ? Object.keys(byStyleMonths).length : 0
      }
    });
    
  } catch (error: any) {
    console.error('[size-ratios] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
