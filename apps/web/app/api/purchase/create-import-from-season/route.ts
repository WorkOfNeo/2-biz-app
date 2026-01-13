import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Allow up to 2 minutes for data processing

/**
 * Creates a purchase_sales_import from scraped season data
 * This enables using the AI Suggestions flow without manual CSV upload
 */
export async function POST(req: Request) {
  const startTime = Date.now();
  
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    const { seasonId } = body as { seasonId: string };

    if (!seasonId) {
      return NextResponse.json({ error: 'seasonId is required' }, { status: 400 });
    }

    console.log('[Create Import] Starting for season:', seasonId);

    // 1. Get season info
    const { data: season, error: seasonError } = await supabase
      .from('seasons')
      .select('id, name, year')
      .eq('id', seasonId)
      .single();

    if (seasonError || !season) {
      return NextResponse.json({ error: 'Season not found' }, { status: 404 });
    }

    console.log('[Create Import] Season:', season.name, season.year);

    // 2. Check if there's an existing recent import for this season
    const { data: existingImport } = await supabase
      .from('purchase_sales_imports')
      .select('id, created_at, row_count')
      .eq('season_id', seasonId)
      .eq('source', 'scrape')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // If import exists and was created less than 1 hour ago, reuse it
    if (existingImport) {
      const ageMs = Date.now() - new Date(existingImport.created_at).getTime();
      const oneHour = 60 * 60 * 1000;
      
      if (ageMs < oneHour) {
        console.log('[Create Import] Using existing recent import:', existingImport.id);
        return NextResponse.json({
          success: true,
          importId: existingImport.id,
          reused: true,
          message: 'Using existing import (created within last hour)',
          rowCount: existingImport.row_count,
        });
      }
    }

    // 3. Fetch style details data with pagination
    console.log('[Create Import] Fetching sales_style_details_rows...');
    
    let styleDetailsRows: any[] = [];
    let from = 0;
    const PAGE_SIZE = 5000;
    
    while (true) {
      const { data, error } = await supabase
        .from('sales_style_details_rows')
        .select('id, account_no, style_no, style_name, quality, color, size, qty, scraped_at')
        .eq('season_id', seasonId)
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.error('[Create Import] Error fetching style details:', error);
        return NextResponse.json({ error: 'Failed to fetch style details' }, { status: 500 });
      }

      styleDetailsRows.push(...(data || []));
      console.log('[Create Import] Fetched batch:', from, '-', from + (data?.length || 0) - 1, 'total:', styleDetailsRows.length);
      
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    if (styleDetailsRows.length === 0) {
      return NextResponse.json({ 
        error: 'No style details data found for this season. Please run the statistics scrape first.' 
      }, { status: 400 });
    }

    console.log('[Create Import] Total style detail rows:', styleDetailsRows.length);

    // 4. Fetch customers for enrichment (country, salesperson)
    console.log('[Create Import] Fetching customers...');
    
    const accountNos = [...new Set(styleDetailsRows.map(r => r.account_no))];
    const customerMap = new Map<string, { country: string; salesperson_id: string; company: string }>();
    
    // Batch fetch customers
    const customerBatchSize = 500;
    for (let i = 0; i < accountNos.length; i += customerBatchSize) {
      const batch = accountNos.slice(i, i + customerBatchSize);
      const { data: customers } = await supabase
        .from('customers')
        .select('customer_id, country, salesperson_id, company')
        .in('customer_id', batch);
      
      for (const c of (customers || [])) {
        customerMap.set(c.customer_id, {
          country: c.country || 'Unknown',
          salesperson_id: c.salesperson_id || '',
          company: c.company || '',
        });
      }
    }
    
    console.log('[Create Import] Customer lookup built:', customerMap.size, 'customers');

    // 5. Fetch salespersons for name lookup
    const { data: salespersons } = await supabase
      .from('salespersons')
      .select('id, name');
    
    const salespersonMap = new Map<string, string>();
    for (const sp of (salespersons || [])) {
      salespersonMap.set(sp.id, sp.name);
    }

    // 6. Fetch styles for supplier info
    console.log('[Create Import] Fetching styles for supplier info...');
    
    const styleNos = [...new Set(styleDetailsRows.map(r => r.style_no))];
    const styleMap = new Map<string, { supplier: string; image_url: string }>();
    
    const styleBatchSize = 500;
    for (let i = 0; i < styleNos.length; i += styleBatchSize) {
      const batch = styleNos.slice(i, i + styleBatchSize);
      const { data: styles } = await supabase
        .from('styles')
        .select('style_no, supplier, image_url')
        .in('style_no', batch);
      
      for (const s of (styles || [])) {
        styleMap.set(s.style_no, {
          supplier: s.supplier || 'Unknown',
          image_url: s.image_url || '',
        });
      }
    }
    
    console.log('[Create Import] Style lookup built:', styleMap.size, 'styles');

    // 7. Create the import record
    const importName = `${season.name} ${season.year || ''} - Auto Import`;
    
    const { data: importRecord, error: importError } = await supabase
      .from('purchase_sales_imports')
      .insert({
        season_id: seasonId,
        name: importName,
        source: 'scrape',
        status: 'processing',
        row_count: 0,
        style_count: 0,
        customer_count: 0,
        total_qty: 0,
        total_amount: 0,
      })
      .select('id')
      .single();

    if (importError || !importRecord) {
      console.error('[Create Import] Failed to create import record:', importError);
      return NextResponse.json({ error: 'Failed to create import record' }, { status: 500 });
    }

    const importId = importRecord.id;
    console.log('[Create Import] Created import record:', importId);

    // 8. Transform and insert purchase_sales_rows
    console.log('[Create Import] Transforming and inserting rows...');
    
    const BATCH_SIZE = 1000;
    let insertedCount = 0;
    let totalQty = 0;
    const uniqueStyles = new Set<string>();
    const uniqueCustomers = new Set<string>();

    for (let i = 0; i < styleDetailsRows.length; i += BATCH_SIZE) {
      const batch = styleDetailsRows.slice(i, i + BATCH_SIZE);
      
      const rows = batch.map((row, idx) => {
        const customer = customerMap.get(row.account_no);
        const style = styleMap.get(row.style_no);
        const salesRepName = customer?.salesperson_id 
          ? salespersonMap.get(customer.salesperson_id) || 'Unknown'
          : 'Unknown';
        
        // Create pseudonymized customer reference
        const customerRef = `C_${crypto.createHash('md5')
          .update(row.account_no || '')
          .digest('hex')
          .slice(0, 8)}`;
        
        uniqueStyles.add(row.style_no);
        uniqueCustomers.add(row.account_no);
        totalQty += Number(row.qty) || 0;
        
        return {
          import_id: importId,
          date: row.scraped_at ? row.scraped_at.split('T')[0] : new Date().toISOString().split('T')[0],
          customer_ref: customerRef,
          customer_display: customer?.company || row.account_no,
          customer_id: row.account_no,
          country: customer?.country || 'Unknown',
          sales_rep: salesRepName,
          salesperson_id: customer?.salesperson_id || null,
          style_no: row.style_no,
          style_name: row.style_name || '',
          color: row.color || 'Default',
          size: row.size || '',
          supplier: style?.supplier || 'Unknown',
          qty: Number(row.qty) || 0,
          net_amount: 0, // No price data in style details
          row_number: i + idx + 1,
        };
      });

      const { error: insertError } = await supabase
        .from('purchase_sales_rows')
        .insert(rows);

      if (insertError) {
        console.error('[Create Import] Insert error at batch', i, ':', insertError);
        // Continue with other batches
      } else {
        insertedCount += rows.length;
      }

      if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= styleDetailsRows.length) {
        console.log('[Create Import] Progress:', insertedCount, '/', styleDetailsRows.length, 'rows inserted');
      }
    }

    // 9. Update import record with final stats
    const { error: updateError } = await supabase
      .from('purchase_sales_imports')
      .update({
        status: 'completed',
        row_count: insertedCount,
        style_count: uniqueStyles.size,
        customer_count: uniqueCustomers.size,
        total_qty: totalQty,
        processed_at: new Date().toISOString(),
      })
      .eq('id', importId);

    if (updateError) {
      console.error('[Create Import] Failed to update import stats:', updateError);
    }

    const durationMs = Date.now() - startTime;
    console.log('[Create Import] Complete', {
      importId,
      rowCount: insertedCount,
      styleCount: uniqueStyles.size,
      customerCount: uniqueCustomers.size,
      totalQty,
      durationMs,
    });

    return NextResponse.json({
      success: true,
      importId,
      reused: false,
      message: 'Import created from scraped data',
      stats: {
        rowCount: insertedCount,
        styleCount: uniqueStyles.size,
        customerCount: uniqueCustomers.size,
        totalQty,
        durationMs,
      },
    });

  } catch (error: any) {
    console.error('[Create Import] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
