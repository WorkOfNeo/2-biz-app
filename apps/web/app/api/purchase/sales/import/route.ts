import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { pseudonymizeCustomer } from '../../../../../lib/ai/pseudonymize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Expected CSV columns (extended schema):
 * Frontend parses and aggregates size-level rows before sending here.
 * 
 * Column mappings supported:
 * - date / Date: YYYY-MM-DD (may have leading = from Excel)
 * - customer_name / Customer Name: customer identifier
 * - country / Country: country code or name
 * - sales_rep / Salesperson: salesperson name or ID
 * - style_no / Style No: style number (may have leading = from Excel)
 * - color / Color: color name
 * - supplier: supplier name (fetched from styles if not provided)
 * - qty / Size Quantity Ordered: quantity sold (aggregated from size level)
 * - net_amount / Sales Price Exchange Total: net sales amount (auto-converted from cents if detected)
 * - currency: currency code, defaults to DKK
 */

type CSVRow = {
  date: string;
  customer_name?: string;
  customer_id?: string;
  country?: string;
  sales_rep?: string;
  style_no: string;
  style_name?: string;
  color: string;
  size?: string;
  supplier?: string;
  qty: number | string;
  net_amount?: number | string;
  currency?: string;
  order_ref?: string;
  channel?: string;
};

type ValidationError = {
  row: number;
  field: string;
  error: string;
};

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  
  // Strip leading = and quotes from Excel formula format (="2025-11-06")
  const cleaned = dateStr.replace(/^[="']+|["']+$/g, '').trim();
  
  // Try ISO format first (YYYY-MM-DD)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  
  // Try DD/MM/YYYY or DD-MM-YYYY
  const euroMatch = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (euroMatch) {
    const day = euroMatch[1]?.padStart(2, '0');
    const month = euroMatch[2]?.padStart(2, '0');
    return `${euroMatch[3]}-${month}-${day}`;
  }
  
  // Try MM/DD/YYYY
  const usMatch = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (usMatch) {
    const month = usMatch[1]?.padStart(2, '0');
    const day = usMatch[2]?.padStart(2, '0');
    return `${usMatch[3]}-${month}-${day}`;
  }
  
  return null;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { 
      rows, 
      seasonId, 
      name,
      fileName,
      fileSizeBytes 
    } = body as {
      rows: CSVRow[];
      seasonId?: string;
      name?: string;
      fileName?: string;
      fileSizeBytes?: number;
    };
    
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
    }

    console.log('[Purchase Sales Import] Processing', rows.length, 'rows');

    // Create import record
    const { data: importRecord, error: importError } = await supabase
      .from('purchase_sales_imports')
      .insert({
        season_id: seasonId || null,
        name: name || `Import ${new Date().toISOString().split('T')[0]}`,
        source: 'csv',
        file_name: fileName || null,
        file_size_bytes: fileSizeBytes || null,
        row_count: rows.length,
        status: 'processing',
      })
      .select('id')
      .single();

    if (importError || !importRecord) {
      console.error('[Purchase Sales Import] Failed to create import record:', importError);
      return NextResponse.json({ error: 'Failed to create import record' }, { status: 500 });
    }

    const importId = importRecord.id;
    const validationErrors: ValidationError[] = [];
    const processedRows: any[] = [];
    
    // Stats tracking
    const uniqueStyles = new Set<string>();
    const uniqueCustomers = new Set<string>();
    let totalQty = 0;
    let totalAmount = 0;
    let minDate: string | null = null;
    let maxDate: string | null = null;

    // Fetch supplier lookup (style_no -> supplier)
    // Clean style numbers (remove Excel formatting like ="xxx")
    const cleanStyleNo = (s: string) => s.replace(/^[="']+|["']+$/g, '').trim();
    const rawStyleNos = [...new Set(rows.map(r => r.style_no).filter(Boolean))];
    const styleNos = rawStyleNos.map(cleanStyleNo);
    
    console.log('[Purchase Sales Import] Looking up suppliers for', styleNos.length, 'unique styles');
    console.log('[Purchase Sales Import] Sample style numbers (raw -> cleaned):');
    for (let i = 0; i < Math.min(5, rawStyleNos.length); i++) {
      console.log(`  "${rawStyleNos[i]}" -> "${styleNos[i]}"`);
    }
    
    const { data: stylesData } = await supabase
      .from('styles')
      .select('style_no, supplier, style_name')
      .in('style_no', styleNos);
    
    const supplierMap = new Map<string, string>();
    const styleNameMap = new Map<string, string>();
    let stylesWithSupplier = 0;
    let stylesWithoutSupplier = 0;
    
    (stylesData || []).forEach((s: any) => {
      if (s.style_name) {
        styleNameMap.set(s.style_no, s.style_name);
      }
      if (s.supplier) {
        supplierMap.set(s.style_no, s.supplier);
        stylesWithSupplier++;
      } else {
        stylesWithoutSupplier++;
      }
    });
    
    // Log styles not found in DB
    const stylesNotInDb = styleNos.filter(sn => !stylesData?.find((s: any) => s.style_no === sn));
    
    console.log('[Purchase Sales Import] Styles found in DB:', (stylesData || []).length, 'of', styleNos.length);
    console.log('[Purchase Sales Import] Styles with supplier:', stylesWithSupplier);
    console.log('[Purchase Sales Import] Styles without supplier in DB:', stylesWithoutSupplier);
    console.log('[Purchase Sales Import] Styles NOT found in DB:', stylesNotInDb.length);
    if (stylesNotInDb.length > 0 && stylesNotInDb.length <= 20) {
      console.log('[Purchase Sales Import] Missing styles:', stylesNotInDb);
    }
    
    // Get supplier distribution
    const supplierCounts: Record<string, number> = {};
    for (const sup of supplierMap.values()) {
      supplierCounts[sup] = (supplierCounts[sup] || 0) + 1;
    }
    console.log('[Purchase Sales Import] Supplier distribution:', supplierCounts);

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      
      const rowNum = i + 2; // +2 for 1-indexed + header row
      
      // Validate required fields
      if (!row.style_no) {
        validationErrors.push({ row: rowNum, field: 'style_no', error: 'Missing style number' });
        continue;
      }
      if (!row.color) {
        validationErrors.push({ row: rowNum, field: 'color', error: 'Missing color' });
        continue;
      }
      if (!row.date) {
        validationErrors.push({ row: rowNum, field: 'date', error: 'Missing date' });
        continue;
      }
      
      // Parse date
      const parsedDate = parseDate(String(row.date));
      if (!parsedDate) {
        validationErrors.push({ row: rowNum, field: 'date', error: `Invalid date format: ${row.date}` });
        continue;
      }
      
      // Get customer identifier
      const customerOriginal = row.customer_name || row.customer_id || 'Unknown';
      const customerRef = pseudonymizeCustomer(customerOriginal);
      
      // Parse quantities
      const qty = Number(row.qty) || 0;
      const netAmount = Number(row.net_amount) || 0;
      
      // Clean style_no for lookups
      const cleanedStyleNo = cleanStyleNo(row.style_no);
      
      // Get supplier (from row or lookup)
      const supplier = row.supplier || supplierMap.get(cleanedStyleNo) || null;
      
      // Get style_name from lookup if not in row
      const styleName = row.style_name || styleNameMap.get(cleanedStyleNo) || null;
      
      // Track stats
      uniqueStyles.add(cleanedStyleNo);
      uniqueCustomers.add(customerRef);
      totalQty += qty;
      totalAmount += netAmount;
      
      if (!minDate || parsedDate < minDate) minDate = parsedDate;
      if (!maxDate || parsedDate > maxDate) maxDate = parsedDate;
      
      processedRows.push({
        import_id: importId,
        date: parsedDate,
        customer_ref: customerRef,
        customer_display: customerOriginal,
        customer_id: row.customer_id || null,
        country: row.country || null,
        sales_rep: row.sales_rep || null,
        style_no: cleanedStyleNo, // Use cleaned style number
        style_name: styleName,
        color: row.color,
        size: row.size || null,
        supplier: supplier,
        qty: qty,
        net_amount: netAmount,
        currency: row.currency || 'DKK',
        order_ref: row.order_ref || null,
        channel: row.channel || null,
        row_number: rowNum,
      });
    }

    // Insert rows in batches
    const BATCH_SIZE = 500;
    let insertedCount = 0;
    
    for (let i = 0; i < processedRows.length; i += BATCH_SIZE) {
      const batch = processedRows.slice(i, i + BATCH_SIZE);
      
      const { error: insertError } = await supabase
        .from('purchase_sales_rows')
        .insert(batch);
      
      if (insertError) {
        console.error(`[Purchase Sales Import] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, insertError);
        validationErrors.push({ 
          row: i + 1, 
          field: 'batch', 
          error: `Database insert failed: ${insertError.message}` 
        });
      } else {
        insertedCount += batch.length;
      }
    }

    // Update import record with stats
    const isValid = validationErrors.length === 0;
    const { error: updateError } = await supabase
      .from('purchase_sales_imports')
      .update({
        status: isValid ? 'completed' : 'completed',
        is_valid: isValid,
        validation_errors: validationErrors.slice(0, 100), // Limit stored errors
        row_count: insertedCount,
        style_count: uniqueStyles.size,
        customer_count: uniqueCustomers.size,
        total_qty: totalQty,
        total_amount: totalAmount,
        date_range_start: minDate,
        date_range_end: maxDate,
        processed_at: new Date().toISOString(),
      })
      .eq('id', importId);

    if (updateError) {
      console.error('[Purchase Sales Import] Failed to update import record:', updateError);
    }

    console.log('[Purchase Sales Import] Complete:', {
      importId,
      insertedCount,
      errorCount: validationErrors.length,
      uniqueStyles: uniqueStyles.size,
      uniqueCustomers: uniqueCustomers.size,
    });

    return NextResponse.json({
      success: true,
      importId,
      stats: {
        totalRows: rows.length,
        insertedRows: insertedCount,
        errorCount: validationErrors.length,
        styleCount: uniqueStyles.size,
        customerCount: uniqueCustomers.size,
        totalQty,
        totalAmount,
        dateRange: minDate && maxDate ? { start: minDate, end: maxDate } : null,
      },
      errors: validationErrors.slice(0, 50),
    });
  } catch (error: any) {
    console.error('[Purchase Sales Import] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET: List recent imports
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const seasonId = searchParams.get('seasonId');
    const limit = Number(searchParams.get('limit')) || 20;

    let query = supabase
      .from('purchase_sales_imports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (seasonId) {
      query = query.eq('season_id', seasonId);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ imports: data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

