import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Preview API: Returns a detailed data validation and preview before running AI analysis
 * 
 * This helps verify:
 * - Suppliers are correctly linked
 * - Styles are found in the database
 * - Comparison season has data
 * - All required data is present
 */

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const {
      importId,
      seasonId,
      comparisonSeasonId,
    } = body as {
      importId: string;
      seasonId?: string;
      comparisonSeasonId?: string;
    };

    if (!importId) {
      return NextResponse.json({ error: 'importId is required' }, { status: 400 });
    }

    console.log('[Preview API] Starting preview for import:', importId);

    // 1. Fetch import details
    const { data: importData, error: importError } = await supabase
      .from('purchase_sales_imports')
      .select('*')
      .eq('id', importId)
      .single();

    if (importError || !importData) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 });
    }

    // 2. Fetch all rows from the import (no limit - default is 1000!)
    const { data: salesRows, error: rowsError } = await supabase
      .from('purchase_sales_rows')
      .select('*')
      .eq('import_id', importId)
      .limit(50000);  // Override default 1000 limit

    if (rowsError) {
      return NextResponse.json({ error: 'Failed to fetch sales data' }, { status: 500 });
    }

    const rows = salesRows || [];

    // 3. First, look up all styles in the database to get their suppliers
    // This is critical - the CSV doesn't have supplier, we must look it up from styles table
    const uniqueStyleNos = [...new Set(rows.map(r => r.style_no).filter(Boolean))];
    console.log('[Preview API] Looking up', uniqueStyleNos.length, 'unique style numbers in database');
    
    const { data: dbStyles } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier')
      .in('style_no', uniqueStyleNos);

    const dbStyleMap = new Map((dbStyles || []).map(s => [s.style_no, s]));
    console.log('[Preview API] Found', dbStyleMap.size, 'styles in database');
    console.log('[Preview API] Sample style mappings:', 
      Array.from(dbStyleMap.entries()).slice(0, 5).map(([k, v]) => `${k} → ${v.supplier || '(no supplier)'}`)
    );

    // 4. Now analyze supplier coverage using the looked-up suppliers
    const supplierAnalysis: Record<string, { 
      styleCount: number; 
      qty: number; 
      amount: number;
      customers: Set<string>;
      styles: string[];
    }> = {};
    
    for (const row of rows) {
      // Look up the supplier from the styles table, NOT from the CSV row
      const dbStyle = dbStyleMap.get(row.style_no);
      const supplier = dbStyle?.supplier || '(Unknown)';
      
      if (!supplierAnalysis[supplier]) {
        supplierAnalysis[supplier] = { 
          styleCount: 0, 
          qty: 0, 
          amount: 0, 
          customers: new Set(),
          styles: [],
        };
      }
      const styleKey = `${row.style_no}|${row.color}`;
      if (!supplierAnalysis[supplier].styles.includes(styleKey)) {
        supplierAnalysis[supplier].styles.push(styleKey);
        supplierAnalysis[supplier].styleCount++;
      }
      supplierAnalysis[supplier].qty += Number(row.qty) || 0;
      supplierAnalysis[supplier].amount += Number(row.net_amount) || 0;
      supplierAnalysis[supplier].customers.add(row.customer_ref);
    }

    const supplierBreakdown = Object.entries(supplierAnalysis)
      .map(([name, data]) => ({
        name,
        styleCount: data.styleCount,
        qty: data.qty,
        amount: Math.round(data.amount),
        customerCount: data.customers.size,
        hasSupplier: name !== '(Unknown)',
      }))
      .sort((a, b) => b.qty - a.qty);
    
    const stylesInDb = uniqueStyleNos.filter(sn => dbStyleMap.has(sn));
    const stylesNotInDb = uniqueStyleNos.filter(sn => !dbStyleMap.has(sn));
    const stylesWithSupplierInDb = (dbStyles || []).filter(s => s.supplier).length;

    // 4b. Get unique suppliers from styles and check which exist in suppliers table
    const suppliersFromStyles = [...new Set(
      (dbStyles || [])
        .map(s => s.supplier)
        .filter(Boolean)
    )] as string[];
    
    console.log('[Preview API] Suppliers found in styles:', suppliersFromStyles);
    
    // Fetch existing suppliers from suppliers table
    const { data: existingSuppliers } = await supabase
      .from('suppliers')
      .select('id, name, external_name');
    
    const existingSupplierNames = new Set(
      (existingSuppliers || []).flatMap(s => [
        s.name?.toLowerCase(),
        s.external_name?.toLowerCase(),
      ].filter(Boolean))
    );
    
    // Find suppliers that need to be created
    const newSuppliers = suppliersFromStyles.filter(
      s => !existingSupplierNames.has(s.toLowerCase())
    );
    
    console.log('[Preview API] Existing suppliers in DB:', existingSuppliers?.length || 0);
    console.log('[Preview API] New suppliers to create:', newSuppliers);
    
    // Build supplier stats for new suppliers
    const newSupplierStats = newSuppliers.map(supplierName => {
      const stylesForSupplier = (dbStyles || []).filter(s => s.supplier === supplierName);
      const salesForSupplier = rows.filter(r => {
        const dbStyle = dbStyleMap.get(r.style_no);
        return dbStyle?.supplier === supplierName;
      });
      return {
        name: supplierName,
        styleCount: stylesForSupplier.length,
        salesQty: salesForSupplier.reduce((sum, r) => sum + (Number(r.qty) || 0), 0),
        salesAmount: Math.round(salesForSupplier.reduce((sum, r) => sum + (Number(r.net_amount) || 0), 0)),
      };
    }).sort((a, b) => b.salesQty - a.salesQty);

    // 5. Check comparison season data
    let comparisonSeasonData = null;
    if (comparisonSeasonId) {
      // Check season_statistics
      const { data: seasonStats, count: statsCount } = await supabase
        .from('season_statistics')
        .select('qty, amount', { count: 'exact' })
        .eq('season_id', comparisonSeasonId);

      let statsQty = 0;
      let statsAmount = 0;
      for (const row of (seasonStats || [])) {
        statsQty += Number(row.qty) || 0;
        statsAmount += Number(row.amount) || 0;
      }

      // Check sales_stats as fallback
      const { data: salesStats, count: salesCount } = await supabase
        .from('sales_stats')
        .select('qty, price', { count: 'exact' })
        .eq('season_id', comparisonSeasonId);

      let salesQty = 0;
      let salesAmount = 0;
      for (const row of (salesStats || [])) {
        salesQty += Number(row.qty) || 0;
        salesAmount += Number(row.price) || 0;
      }

      // Get season info
      const { data: seasonInfo } = await supabase
        .from('seasons')
        .select('name, year')
        .eq('id', comparisonSeasonId)
        .single();

      comparisonSeasonData = {
        seasonId: comparisonSeasonId,
        seasonName: seasonInfo ? `${seasonInfo.name} ${seasonInfo.year || ''}` : 'Unknown',
        seasonStatistics: {
          rowCount: statsCount || 0,
          totalQty: statsQty,
          totalAmount: Math.round(statsAmount),
          hasData: (statsCount || 0) > 0,
        },
        salesStats: {
          rowCount: salesCount || 0,
          totalQty: salesQty,
          totalAmount: Math.round(salesAmount),
          hasData: (salesCount || 0) > 0,
        },
        dataSource: (statsCount || 0) > 0 ? 'season_statistics' : ((salesCount || 0) > 0 ? 'sales_stats' : 'none'),
      };
    }

    // 6. Check current season data
    let currentSeasonData = null;
    if (seasonId) {
      const { data: seasonInfo } = await supabase
        .from('seasons')
        .select('name, year, is_current')
        .eq('id', seasonId)
        .single();

      // Check style_color_seasons for this season
      const { count: styleColorCount } = await supabase
        .from('style_color_seasons')
        .select('id', { count: 'exact' })
        .eq('season_id', seasonId);

      currentSeasonData = {
        seasonId,
        seasonName: seasonInfo ? `${seasonInfo.name} ${seasonInfo.year || ''}` : 'Unknown',
        isCurrent: seasonInfo?.is_current || false,
        styleColorsInSeason: styleColorCount || 0,
      };
    }

    // 7. Aggregate totals
    let totalQty = 0;
    let totalAmount = 0;
    const uniqueCustomers = new Set<string>();
    for (const row of rows) {
      totalQty += Number(row.qty) || 0;
      totalAmount += Number(row.net_amount) || 0;
      uniqueCustomers.add(row.customer_ref);
    }

    // 8. Identify issues/warnings
    const warnings: string[] = [];
    const errors: string[] = [];

    if (supplierBreakdown.find(s => s.name === '(Unknown)')) {
      const unknownData = supplierBreakdown.find(s => s.name === '(Unknown)')!;
      if (unknownData.styleCount === supplierBreakdown.reduce((sum, s) => sum + s.styleCount, 0)) {
        errors.push(`All ${unknownData.styleCount} style/colors have unknown supplier. Check if styles exist in the database with supplier field set.`);
      } else {
        warnings.push(`${unknownData.styleCount} style/colors have unknown supplier (style not in DB or missing supplier field).`);
      }
    }

    if (stylesNotInDb.length > 0) {
      warnings.push(`${stylesNotInDb.length} of ${uniqueStyleNos.length} styles not found in database.`);
    }

    if (comparisonSeasonData && comparisonSeasonData.dataSource === 'none') {
      errors.push(`Comparison season "${comparisonSeasonData.seasonName}" has no data in season_statistics or sales_stats.`);
    }

    if (rows.length === 0) {
      errors.push('No sales rows found in import.');
    }

    const preview = {
      import: {
        id: importId,
        name: importData.name,
        status: importData.status,
        rowCount: rows.length,
        createdAt: importData.created_at,
      },
      summary: {
        totalRows: rows.length,
        uniqueStyles: uniqueStyleNos.length,
        uniqueCustomers: uniqueCustomers.size,
        totalQty,
        totalAmount: Math.round(totalAmount),
      },
      // New suppliers detected (need to be created in suppliers table)
      newSuppliers: {
        count: newSuppliers.length,
        suppliers: newSupplierStats,
        existingSuppliersCount: existingSuppliers?.length || 0,
      },
      stylesCoverage: {
        total: uniqueStyleNos.length,
        foundInDb: stylesInDb.length,
        notFoundInDb: stylesNotInDb.length,
        withSupplierInDb: stylesWithSupplierInDb,
        missingStyles: stylesNotInDb.slice(0, 20), // Show first 20
      },
      supplierBreakdown,
      currentSeason: currentSeasonData,
      comparisonSeason: comparisonSeasonData,
      validation: {
        isValid: errors.length === 0,
        errors,
        warnings,
      },
    };

    console.log('[Preview API] Preview complete');
    console.log('[Preview API] Styles:', preview.stylesCoverage);
    console.log('[Preview API] Suppliers:', supplierBreakdown.map(s => `${s.name}: ${s.styleCount} styles`));
    console.log('[Preview API] Validation:', preview.validation);

    return NextResponse.json({
      success: true,
      preview,
    });
  } catch (error: any) {
    console.error('[Preview API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

