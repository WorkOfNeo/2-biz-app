import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Compare API: Returns comparison aggregates for purchase analysis
 * 
 * - Overall: current-to-date qty/amount vs last-year-to-date-proxy and "gap to target"
 * - By supplier: qty/amount share, top movers
 * - By country (DK/SE/NO/FI): totals + top styles
 * - By sales_rep: totals + top styles
 * - Top 10 styles (this season) + per-country top 10
 */

type ComparisonResult = {
  overall: {
    currentSeason: { qty: number; amount: number };
    lastSeasonTotal: { qty: number; amount: number };
    lastSeasonToDateProxy: { qty: number; amount: number };
    gapToTarget: { qty: number; amount: number; qtyPercent: string; amountPercent: string };
    weeksCovered: number;
  };
  bySupplier: Array<{
    supplier: string;
    qty: number;
    amount: number;
    styleCount: number;
    qtyShare: string;
    amountShare: string;
  }>;
  byCountry: Array<{
    country: string;
    qty: number;
    amount: number;
    customerCount: number;
    topStyles: Array<{ style_no: string; style_name: string; color: string; qty: number }>;
  }>;
  bySalesRep: Array<{
    sales_rep: string;
    qty: number;
    amount: number;
    customerCount: number;
    topStyles: Array<{ style_no: string; style_name: string; color: string; qty: number }>;
  }>;
  top10Styles: Array<{
    style_no: string;
    style_name: string;
    color: string;
    supplier: string | null;
    qty: number;
    amount: number;
    customerCount: number;
  }>;
  top10ByCountry: Record<string, Array<{
    style_no: string;
    style_name: string;
    color: string;
    qty: number;
  }>>;
  weeklyBreakdown: Array<{
    week: string;
    qty: number;
    amount: number;
    cumulativeQty: number;
    cumulativeAmount: number;
  }>;
};

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const {
      importId,
      seasonId, // Current season
      comparisonSeasonId, // Last year's season for comparison
    } = body as {
      importId: string;
      seasonId?: string;
      comparisonSeasonId?: string;
    };

    if (!importId) {
      return NextResponse.json({ error: 'importId is required' }, { status: 400 });
    }

    console.log('[Compare API] Starting comparison for import:', importId);

    // Fetch import details
    const { data: importData, error: importError } = await supabase
      .from('purchase_sales_imports')
      .select('*')
      .eq('id', importId)
      .single();

    if (importError || !importData) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 });
    }

    // Fetch all rows from the import
    const { data: salesRows, error: rowsError } = await supabase
      .from('purchase_sales_rows')
      .select('*')
      .eq('import_id', importId);

    if (rowsError) {
      console.error('[Compare API] Failed to fetch rows:', rowsError);
      return NextResponse.json({ error: 'Failed to fetch sales data' }, { status: 500 });
    }

    const rows = salesRows || [];
    console.log('[Compare API] Fetched', rows.length, 'rows');

    // Get unique style numbers and fetch style names
    const uniqueStyleNos = [...new Set(rows.map(r => r.style_no).filter(Boolean))];
    console.log('[Compare API] Unique style numbers:', uniqueStyleNos.length);
    
    // Clean style numbers (remove Excel formatting like ="xxx")
    const cleanedStyleNos = uniqueStyleNos.map(s => 
      s.replace(/^="?|"?$/g, '').trim()
    );
    
    // Build style name lookup map
    const styleNameMap: Record<string, string> = {};
    if (cleanedStyleNos.length > 0) {
      const { data: stylesData, error: stylesError } = await supabase
        .from('styles')
        .select('style_no, style_name')
        .in('style_no', cleanedStyleNos);
      
      if (stylesError) {
        console.error('[Compare API] Error fetching styles:', stylesError);
      } else {
        for (const style of (stylesData || [])) {
          if (style.style_no && style.style_name) {
            styleNameMap[style.style_no] = style.style_name;
          }
        }
        console.log('[Compare API] Found style names for', Object.keys(styleNameMap).length, 'styles');
      }
    }
    
    // Helper to get style name
    const getStyleName = (styleNo: string): string => {
      const cleaned = styleNo.replace(/^="?|"?$/g, '').trim();
      return styleNameMap[cleaned] || styleNo;
    };

    // Calculate current season totals
    let currentQty = 0;
    let currentAmount = 0;
    for (const row of rows) {
      currentQty += Number(row.qty) || 0;
      currentAmount += Number(row.net_amount) || 0;
    }

    // Fetch last season totals if comparison season provided
    let lastSeasonTotalQty = 0;
    let lastSeasonTotalAmount = 0;

    if (comparisonSeasonId) {
      console.log('[Compare API] Fetching last season stats for comparison season:', comparisonSeasonId);
      
      const { data: lastSeasonStats, error: lastSeasonError } = await supabase
        .from('season_statistics')
        .select('qty, amount')
        .eq('season_id', comparisonSeasonId);

      if (lastSeasonError) {
        console.error('[Compare API] Error fetching last season stats:', lastSeasonError);
      } else {
        console.log('[Compare API] Found', lastSeasonStats?.length || 0, 'season_statistics rows for comparison season');
      }

      for (const row of (lastSeasonStats || [])) {
        lastSeasonTotalQty += Number(row.qty) || 0;
        lastSeasonTotalAmount += Number(row.amount) || 0;
      }

      console.log('[Compare API] Last season totals:', {
        qty: lastSeasonTotalQty,
        amount: lastSeasonTotalAmount,
        rowCount: lastSeasonStats?.length || 0,
      });
      
      // If no data found, let's also check sales_stats table as fallback
      if (lastSeasonTotalQty === 0) {
        console.log('[Compare API] No season_statistics found, checking sales_stats table...');
        const { data: salesStats, error: salesStatsError } = await supabase
          .from('sales_stats')
          .select('qty, price')
          .eq('season_id', comparisonSeasonId);
        
        if (salesStatsError) {
          console.error('[Compare API] Error fetching sales_stats:', salesStatsError);
        } else if (salesStats && salesStats.length > 0) {
          console.log('[Compare API] Found', salesStats.length, 'sales_stats rows');
          for (const row of salesStats) {
            lastSeasonTotalQty += Number(row.qty) || 0;
            lastSeasonTotalAmount += Number(row.price) || 0;
          }
          console.log('[Compare API] Sales stats totals:', {
            qty: lastSeasonTotalQty,
            amount: lastSeasonTotalAmount,
          });
        }
      }
    }

    // Build weekly breakdown from CSV dates
    const weeklyData: Record<string, { qty: number; amount: number }> = {};
    for (const row of rows) {
      const date = new Date(row.date);
      // Get ISO week number
      const startOfYear = new Date(date.getFullYear(), 0, 1);
      const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
      const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { qty: 0, amount: 0 };
      }
      weeklyData[weekKey].qty += Number(row.qty) || 0;
      weeklyData[weekKey].amount += Number(row.net_amount) || 0;
    }

    // Sort weeks and compute cumulative
    const sortedWeeks = Object.keys(weeklyData).sort();
    const weeklyBreakdown: ComparisonResult['weeklyBreakdown'] = [];
    let cumulativeQty = 0;
    let cumulativeAmount = 0;

    for (const week of sortedWeeks) {
      cumulativeQty += weeklyData[week]!.qty;
      cumulativeAmount += weeklyData[week]!.amount;
      weeklyBreakdown.push({
        week,
        qty: weeklyData[week]!.qty,
        amount: Math.round(weeklyData[week]!.amount),
        cumulativeQty,
        cumulativeAmount: Math.round(cumulativeAmount),
      });
    }

    // Derive last-year-to-date proxy using current weekly distribution
    // Allocate last year totals proportionally based on current week pattern
    const weeksCovered = sortedWeeks.length;
    let lastYearToDateProxyQty = 0;
    let lastYearToDateProxyAmount = 0;

    if (lastSeasonTotalQty > 0 && currentQty > 0) {
      // Simple approach: assume same % progress as current week distribution
      // More sophisticated: could use week-of-season mapping
      const progressRatio = currentQty / lastSeasonTotalQty;
      lastYearToDateProxyQty = Math.round(lastSeasonTotalQty * Math.min(progressRatio * 1.0, 1.0));
      lastYearToDateProxyAmount = Math.round(lastSeasonTotalAmount * Math.min(progressRatio * 1.0, 1.0));
    }

    // Gap to target
    const gapQty = lastYearToDateProxyQty - currentQty;
    const gapAmount = lastYearToDateProxyAmount - currentAmount;
    const gapQtyPercent = lastYearToDateProxyQty > 0 
      ? ((currentQty / lastYearToDateProxyQty) * 100).toFixed(1) + '%'
      : 'N/A';
    const gapAmountPercent = lastYearToDateProxyAmount > 0
      ? ((currentAmount / lastYearToDateProxyAmount) * 100).toFixed(1) + '%'
      : 'N/A';

    // By Supplier aggregation
    const supplierAgg: Record<string, { qty: number; amount: number; styles: Set<string> }> = {};
    for (const row of rows) {
      const supplier = row.supplier || 'Unknown';
      if (!supplierAgg[supplier]) {
        supplierAgg[supplier] = { qty: 0, amount: 0, styles: new Set() };
      }
      supplierAgg[supplier].qty += Number(row.qty) || 0;
      supplierAgg[supplier].amount += Number(row.net_amount) || 0;
      supplierAgg[supplier].styles.add(`${row.style_no}|${row.color}`);
    }

    const bySupplier = Object.entries(supplierAgg)
      .map(([supplier, data]) => ({
        supplier,
        qty: data.qty,
        amount: Math.round(data.amount),
        styleCount: data.styles.size,
        qtyShare: currentQty > 0 ? ((data.qty / currentQty) * 100).toFixed(1) + '%' : '0%',
        amountShare: currentAmount > 0 ? ((data.amount / currentAmount) * 100).toFixed(1) + '%' : '0%',
      }))
      .sort((a, b) => b.qty - a.qty);

    // By Country aggregation
    const countryAgg: Record<string, { qty: number; amount: number; customers: Set<string>; styles: Map<string, number> }> = {};
    for (const row of rows) {
      const country = row.country || 'Unknown';
      if (!countryAgg[country]) {
        countryAgg[country] = { qty: 0, amount: 0, customers: new Set(), styles: new Map() };
      }
      countryAgg[country].qty += Number(row.qty) || 0;
      countryAgg[country].amount += Number(row.net_amount) || 0;
      countryAgg[country].customers.add(row.customer_ref);

      const styleKey = `${row.style_no}|${row.color}`;
      const currentStyleQty = countryAgg[country].styles.get(styleKey) || 0;
      countryAgg[country].styles.set(styleKey, currentStyleQty + (Number(row.qty) || 0));
    }

    const byCountry = Object.entries(countryAgg)
      .map(([country, data]) => {
        const topStyles = [...data.styles.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([key, qty]) => {
            const [style_no, color] = key.split('|');
            return { 
              style_no: style_no || '', 
              style_name: getStyleName(style_no || ''),
              color: color || '', 
              qty 
            };
          });

        return {
          country,
          qty: data.qty,
          amount: Math.round(data.amount),
          customerCount: data.customers.size,
          topStyles,
        };
      })
      .sort((a, b) => b.qty - a.qty);

    // By Sales Rep aggregation
    const repAgg: Record<string, { qty: number; amount: number; customers: Set<string>; styles: Map<string, number> }> = {};
    for (const row of rows) {
      const rep = row.sales_rep || 'Unknown';
      if (!repAgg[rep]) {
        repAgg[rep] = { qty: 0, amount: 0, customers: new Set(), styles: new Map() };
      }
      repAgg[rep].qty += Number(row.qty) || 0;
      repAgg[rep].amount += Number(row.net_amount) || 0;
      repAgg[rep].customers.add(row.customer_ref);

      const styleKey = `${row.style_no}|${row.color}`;
      const currentStyleQty = repAgg[rep].styles.get(styleKey) || 0;
      repAgg[rep].styles.set(styleKey, currentStyleQty + (Number(row.qty) || 0));
    }

    const bySalesRep = Object.entries(repAgg)
      .map(([sales_rep, data]) => {
        const topStyles = [...data.styles.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([key, qty]) => {
            const [style_no, color] = key.split('|');
            return { 
              style_no: style_no || '', 
              style_name: getStyleName(style_no || ''),
              color: color || '', 
              qty 
            };
          });

        return {
          sales_rep,
          qty: data.qty,
          amount: Math.round(data.amount),
          customerCount: data.customers.size,
          topStyles,
        };
      })
      .sort((a, b) => b.qty - a.qty);

    // Top 10 Styles overall
    const styleAgg: Record<string, { supplier: string | null; qty: number; amount: number; customers: Set<string> }> = {};
    for (const row of rows) {
      const key = `${row.style_no}|${row.color}`;
      if (!styleAgg[key]) {
        styleAgg[key] = { supplier: row.supplier, qty: 0, amount: 0, customers: new Set() };
      }
      styleAgg[key].qty += Number(row.qty) || 0;
      styleAgg[key].amount += Number(row.net_amount) || 0;
      styleAgg[key].customers.add(row.customer_ref);
    }

    const top10Styles = Object.entries(styleAgg)
      .map(([key, data]) => {
        const [style_no, color] = key.split('|');
        return {
          style_no: style_no || '',
          style_name: getStyleName(style_no || ''),
          color: color || '',
          supplier: data.supplier,
          qty: data.qty,
          amount: Math.round(data.amount),
          customerCount: data.customers.size,
        };
      })
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10);

    // Top 10 by Country (for main Nordic countries)
    const mainCountries = ['Denmark', 'Sweden', 'Norway', 'Finland', 'DK', 'SE', 'NO', 'FI'];
    const top10ByCountry: Record<string, Array<{ style_no: string; style_name: string; color: string; qty: number }>> = {};

    for (const countryData of byCountry) {
      const countryKey = countryData.country.toUpperCase();
      const isMainCountry = mainCountries.some(c => 
        countryKey.includes(c.toUpperCase()) || c.toUpperCase().includes(countryKey)
      );
      if (isMainCountry) {
        // Re-aggregate top 10 for this country
        const countryStylesMap: Map<string, number> = new Map();
        for (const row of rows) {
          if ((row.country || '').toUpperCase() === countryData.country.toUpperCase()) {
            const key = `${row.style_no}|${row.color}`;
            countryStylesMap.set(key, (countryStylesMap.get(key) || 0) + (Number(row.qty) || 0));
          }
        }
        
        top10ByCountry[countryData.country] = [...countryStylesMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([key, qty]) => {
            const [style_no, color] = key.split('|');
            return { 
              style_no: style_no || '', 
              style_name: getStyleName(style_no || ''),
              color: color || '', 
              qty 
            };
          });
      }
    }

    const result: ComparisonResult = {
      overall: {
        currentSeason: { qty: currentQty, amount: Math.round(currentAmount) },
        lastSeasonTotal: { qty: lastSeasonTotalQty, amount: Math.round(lastSeasonTotalAmount) },
        lastSeasonToDateProxy: { qty: lastYearToDateProxyQty, amount: lastYearToDateProxyAmount },
        gapToTarget: { 
          qty: gapQty, 
          amount: Math.round(gapAmount), 
          qtyPercent: gapQtyPercent, 
          amountPercent: gapAmountPercent 
        },
        weeksCovered,
      },
      bySupplier,
      byCountry,
      bySalesRep,
      top10Styles,
      top10ByCountry,
      weeklyBreakdown,
    };

    console.log('[Compare API] Comparison complete');
    console.log('[Compare API] Overall:', result.overall);
    console.log('[Compare API] Suppliers:', bySupplier.length);
    console.log('[Compare API] Countries:', byCountry.length);
    console.log('[Compare API] Sales reps:', bySalesRep.length);

    return NextResponse.json({
      success: true,
      comparison: result,
      importId,
      seasonId,
      comparisonSeasonId,
    });
  } catch (error: any) {
    console.error('[Compare API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

