import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Configure route to accept larger payloads
export const maxDuration = 60; // 60 seconds max execution time
export const dynamic = 'force-dynamic';

type RawRow = Record<string, any>;

type ColumnMapping = {
  styleNo: string;
  styleName: string;
  size: string;
  quantity: string;
  date: string;
  orderType?: string;
  orderChannel?: string;
};

// Parse date from various formats including Excel serial numbers
function parseDate(dateStr: string | number): string | null {
  if (!dateStr && dateStr !== 0) return null;
  
  const str = String(dateStr).trim();
  
  // Excel serial number (days since 1900-01-01) - can have decimals for time
  if (/^\d+\.?\d*$/.test(str)) {
    const serial = parseFloat(str);
    if (serial > 1 && serial < 100000) {
      const utc_days = Math.floor(serial - 25569);
      const utc_value = utc_days * 86400;
      const date = new Date(utc_value * 1000);
      return date.toISOString().split('T')[0] || null;
    }
  }
  
  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy && dmy[1] && dmy[2] && dmy[3]) {
    const day = dmy[1];
    const month = dmy[2];
    const year = dmy[3];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  // YYYY-MM-DD
  const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd && ymd[1] && ymd[2] && ymd[3]) {
    const year = ymd[1];
    const month = ymd[2];
    const day = ymd[3];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  // Try standard Date parsing
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0] || null;
  }
  
  return null;
}

// Fuzzy matching helper
function fuzzyScore(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();
  
  if (aLower === bLower) return 1.0;
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.9;
  
  const aSet = new Set(aLower.split(''));
  const bSet = new Set(bLower.split(''));
  const intersection = new Set([...aSet].filter(x => bSet.has(x)));
  const union = new Set([...aSet, ...bSet]);
  return intersection.size / union.size;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { rows: rawRows, columnMapping } = body as { rows: RawRow[]; columnMapping: ColumnMapping };
    
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
    }
    
    if (!columnMapping || !columnMapping.styleNo || !columnMapping.styleName || 
        !columnMapping.size || !columnMapping.quantity || !columnMapping.date) {
      return NextResponse.json({ error: 'Complete column mapping is required' }, { status: 400 });
    }

    console.log('[Historical Sales Upload Raw] Starting processing:', {
      totalRows: rawRows.length,
      columnMapping,
      timestamp: new Date().toISOString(),
    });
    
    // Fetch all styles and colors upfront
    console.log('[Historical Sales Upload Raw] Fetching styles...');
    const { data: styles, error: stylesError } = await supabase
      .from('styles')
      .select('id, style_no, style_name')
      .order('style_no');
    
    if (stylesError) {
      console.error('[Historical Sales Upload Raw] Styles query failed:', stylesError);
      return NextResponse.json({ error: stylesError.message }, { status: 500 });
    }
    
    console.log('[Historical Sales Upload Raw] Fetching style colors...');
    const { data: styleColors, error: colorsError } = await supabase
      .from('style_colors')
      .select('id, style_id, color')
      .order('color');
    
    if (colorsError) {
      console.error('[Historical Sales Upload Raw] Colors query failed:', colorsError);
      return NextResponse.json({ error: colorsError.message }, { status: 500 });
    }
    
    console.log('[Historical Sales Upload Raw] Loaded', styles?.length || 0, 'styles and', styleColors?.length || 0, 'colors');
    
    // Build lookup maps
    const styleMap = new Map(styles?.map(s => [s.style_no.toLowerCase(), s]) || []);
    const styleNameMap = new Map(styles?.map(s => [s.style_name?.toLowerCase() || '', s]) || []);
    
    const colorsByStyleNo = new Map<string, string[]>();
    (styleColors || []).forEach(sc => {
      const style = styles?.find(s => s.id === sc.style_id);
      if (style) {
        if (!colorsByStyleNo.has(style.style_no)) {
          colorsByStyleNo.set(style.style_no, []);
        }
        colorsByStyleNo.get(style.style_no)!.push(sc.color);
      }
    });
    
    // Process first 10 rows as validation
    console.log('[Historical Sales Upload Raw] Validating first 10 rows...');
    const sampleSize = Math.min(10, rawRows.length);
    const sampleValidation = [];
    
    for (let i = 0; i < sampleSize; i++) {
      const raw = rawRows[i];
      if (!raw) continue;
      
      const parsedDate = parseDate(raw[columnMapping.date]);
      const qty = typeof raw[columnMapping.quantity] === 'number' 
        ? raw[columnMapping.quantity] 
        : parseInt(String(raw[columnMapping.quantity] || '0'), 10);
      
      sampleValidation.push({
        index: i,
        styleNo: String(raw[columnMapping.styleNo] || '').trim(),
        styleName: String(raw[columnMapping.styleName] || '').trim(),
        size: String(raw[columnMapping.size] || '').trim(),
        quantity: qty,
        date: parsedDate,
        hasStyleNo: !!String(raw[columnMapping.styleNo] || '').trim(),
        hasStyleName: !!String(raw[columnMapping.styleName] || '').trim(),
        hasSize: !!String(raw[columnMapping.size] || '').trim(),
        validQuantity: !isNaN(qty) && qty > 0,
        validDate: !!parsedDate,
      });
    }
    
    const sampleErrors = sampleValidation.filter(s => 
      !s.hasStyleNo || !s.hasStyleName || !s.hasSize || !s.validQuantity || !s.validDate
    );
    
    if (sampleErrors.length > 0) {
      return NextResponse.json({
        error: 'Sample validation failed',
        sampleValidation,
        message: `${sampleErrors.length}/${sampleSize} sample rows failed validation. Fix these issues before uploading.`,
      }, { status: 400 });
    }
    
    console.log('[Historical Sales Upload Raw] Sample validation passed, processing all rows...');
    
    // Parse and match all rows
    const processedRecords: any[] = [];
    const stats = {
      total: rawRows.length,
      parsed: 0,
      matched: 0,
      unmatchedStyle: 0,
      unmatchedColor: 0,
      filteredInvalid: 0,
    };
    
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      if (!raw) continue;
      
      // Parse row
      const parsedDate = parseDate(raw[columnMapping.date]);
      const qty = typeof raw[columnMapping.quantity] === 'number' 
        ? raw[columnMapping.quantity] 
        : parseInt(String(raw[columnMapping.quantity] || '0'), 10);
      
      const parsed = {
        styleNo: String(raw[columnMapping.styleNo] || '').trim(),
        styleName: String(raw[columnMapping.styleName] || '').trim(),
        size: String(raw[columnMapping.size] || '').trim(),
        quantity: isNaN(qty) ? 0 : qty,
        date: parsedDate || '',
        orderType: columnMapping.orderType ? String(raw[columnMapping.orderType] || '').trim() : undefined,
        orderChannel: columnMapping.orderChannel ? String(raw[columnMapping.orderChannel] || '').trim() : undefined,
      };
      
      // Filter invalid
      if (!parsed.styleNo || !parsed.styleName || !parsed.size || parsed.quantity <= 0 || !parsed.date) {
        stats.filteredInvalid++;
        continue;
      }
      
      stats.parsed++;
      
      // Match style
      let matchedStyleNo: string | null = null;
      let matchedStyle = styleMap.get(parsed.styleNo.toLowerCase());
      
      if (matchedStyle) {
        matchedStyleNo = matchedStyle.style_no;
      } else {
        // Try fuzzy match on style name
        let bestMatch = null;
        let bestScore = 0;
        
        for (const style of styles || []) {
          if (!style.style_name) continue;
          const score = fuzzyScore(parsed.styleName, style.style_name);
          if (score > bestScore && score >= 0.7) {
            bestScore = score;
            bestMatch = style;
          }
        }
        
        if (bestMatch) {
          matchedStyleNo = bestMatch.style_no;
        }
      }
      
      if (!matchedStyleNo) {
        stats.unmatchedStyle++;
        continue;
      }
      
      // Match color - just use first available color
      const colors = colorsByStyleNo.get(matchedStyleNo) || [];
      if (colors.length === 0) {
        stats.unmatchedColor++;
        continue;
      }
      
      const matchedColor = colors[0];
      stats.matched++;
      
      // Add to records
      processedRecords.push({
        style_no: matchedStyleNo,
        color: matchedColor,
        date: parsed.date,
        size: parsed.size,
        quantity: parsed.quantity,
        order_type: parsed.orderType || null,
        order_channel: parsed.orderChannel || null,
      });
      
      // Log progress every 10k rows
      if (i > 0 && i % 10000 === 0) {
        console.log(`[Historical Sales Upload Raw] Processed ${i}/${rawRows.length} rows (${Math.round(i/rawRows.length*100)}%)`);
      }
    }
    
    console.log('[Historical Sales Upload Raw] Matching complete:', stats);
    
    if (processedRecords.length === 0) {
      return NextResponse.json({
        error: 'No valid matched rows to insert',
        stats,
      }, { status: 400 });
    }
    
    // Deduplicate records by aggregating quantities for the same style/color/date/size
    console.log('[Historical Sales Upload Raw] Deduplicating records...');
    const dedupeMap = new Map<string, typeof processedRecords[0]>();
    
    for (const record of processedRecords) {
      const key = `${record.style_no}|${record.color}|${record.date}|${record.size}`;
      const existing = dedupeMap.get(key);
      
      if (existing) {
        // Sum quantities for duplicates
        existing.quantity += record.quantity;
        // Keep first order_type and order_channel if they exist
        if (!existing.order_type && record.order_type) existing.order_type = record.order_type;
        if (!existing.order_channel && record.order_channel) existing.order_channel = record.order_channel;
      } else {
        dedupeMap.set(key, { ...record });
      }
    }
    
    const dedupedRecords = Array.from(dedupeMap.values());
    console.log('[Historical Sales Upload Raw] Deduplicated', processedRecords.length, 'records to', dedupedRecords.length, 'unique records');
    
    // Insert in batches
    console.log('[Historical Sales Upload Raw] Inserting', dedupedRecords.length, 'records...');
    const batchSize = 500;
    let inserted = 0;
    
    for (let i = 0; i < dedupedRecords.length; i += batchSize) {
      const batch = dedupedRecords.slice(i, i + batchSize);
      
      const { error: insertError } = await supabase
        .from('historical_sales')
        .upsert(batch, {
          onConflict: 'style_no,color,date,size',
          ignoreDuplicates: false
        });
      
      if (insertError) {
        console.error(`[Historical Sales Upload Raw] Batch ${Math.floor(i / batchSize) + 1} failed:`, insertError);
        return NextResponse.json({
          error: `Database insert failed: ${insertError.message}`,
          stats,
          insertedSoFar: inserted,
        }, { status: 500 });
      }
      
      inserted += batch.length;
      
      // Log progress every 10 batches
      if (Math.floor(i / batchSize) % 10 === 0) {
        console.log(`[Historical Sales Upload Raw] Inserted ${inserted}/${dedupedRecords.length} records`);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('[Historical Sales Upload Raw] Complete:', {
      duration: `${duration}s`,
      stats,
      inserted,
    });
    
    return NextResponse.json({
      success: true,
      stats,
      inserted,
      duration: `${duration}s`,
    });
  } catch (error: any) {
    console.error('[Historical Sales Upload Raw] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      stack: error.stack,
    }, { status: 500 });
  }
}
