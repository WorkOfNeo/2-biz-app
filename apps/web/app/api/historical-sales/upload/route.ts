import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

type UploadRow = {
  style_no: string;
  color: string;
  date: string; // Can be single date or range like "2025-01-01 to 2025-01-31"
  size: string;
  quantity: number;
};

type ProcessedRow = {
  style_id: string | null;
  style_no: string;
  color: string;
  date: string; // Single date (YYYY-MM-DD)
  size: string;
  quantity: number;
};

function parseDateRange(dateStr: string): string[] {
  const trimmed = dateStr.trim();
  
  // Check if it's a date range (contains "to", " - ", or similar)
  const rangePatterns = [
    / to /i,
    / - /,
    /–/, // en dash
    /—/, // em dash
  ];
  
  let isRange = false;
  let startStr = '';
  let endStr = '';
  
  for (const pattern of rangePatterns) {
    if (pattern.test(trimmed)) {
      const parts = trimmed.split(pattern);
      if (parts.length === 2) {
        startStr = parts[0]?.trim() || '';
        endStr = parts[1]?.trim() || '';
        isRange = true;
        break;
      }
    }
  }
  
  if (!isRange) {
    // Single date
    return [trimmed];
  }
  
  // Parse start and end dates
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);
  
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error(`Invalid date range: ${dateStr}`);
  }
  
  if (startDate > endDate) {
    throw new Error(`Start date after end date: ${dateStr}`);
  }
  
  // Generate all dates in range
  const dates: string[] = [];
  const current = new Date(startDate);
  
  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0] || '');
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { rows } = body;
    
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
    }

    // Validate and process rows
    const errors: string[] = [];
    const processedRows: ProcessedRow[] = [];
    
    // Fetch all unique style_nos to get style_ids
    const uniqueStyleNos = Array.from(new Set(rows.map((r: UploadRow) => r.style_no)));
    const { data: styles, error: stylesError } = await supabase
      .from('styles')
      .select('id, style_no')
      .in('style_no', uniqueStyleNos);
    
    if (stylesError) {
      return NextResponse.json({ error: stylesError.message }, { status: 500 });
    }
    
    const styleMap = new Map<string, string>();
    (styles || []).forEach((s: any) => {
      styleMap.set(s.style_no, s.id);
    });
    
    // Fetch all style_colors to validate style_no + color combinations
    const styleIds = Array.from(styleMap.values());
    const { data: styleColors, error: colorsError } = await supabase
      .from('style_colors')
      .select('style_id, color')
      .in('style_id', styleIds);
    
    if (colorsError) {
      return NextResponse.json({ error: colorsError.message }, { status: 500 });
    }
    
    // Build a map of valid style_id + color combinations (case-insensitive)
    const validStyleColorMap = new Map<string, boolean>();
    (styleColors || []).forEach((sc: any) => {
      const key = `${sc.style_id}|${String(sc.color || '').trim().toLowerCase()}`;
      validStyleColorMap.set(key, true);
    });
    
    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as UploadRow;
      
      try {
        // Validate required fields
        if (!row.style_no || !row.color || !row.date || !row.size) {
          errors.push(`Row ${i + 1}: Missing required fields`);
          continue;
        }
        
        const styleId = styleMap.get(row.style_no);
        if (!styleId) {
          errors.push(`Row ${i + 1}: Style ${row.style_no} not found in database`);
          continue;
        }
        
        // Validate that the color exists for this style
        const colorKey = `${styleId}|${String(row.color || '').trim().toLowerCase()}`;
        if (!validStyleColorMap.has(colorKey)) {
          errors.push(`Row ${i + 1}: Color "${row.color}" not found for style ${row.style_no}`);
          continue;
        }
        
        const quantity = Number(row.quantity);
        if (isNaN(quantity)) {
          errors.push(`Row ${i + 1}: Invalid quantity ${row.quantity}`);
          continue;
        }
        
        // Parse date or date range
        const dates = parseDateRange(row.date);
        const qtyPerDay = Math.trunc(quantity / dates.length);
        const remainder = quantity - qtyPerDay * dates.length;
        
        // Create a row for each date
        dates.forEach((date, idx) => {
          const remainderAdjustment =
            remainder > 0 ? (idx < remainder ? 1 : 0) :
            remainder < 0 ? (idx < -remainder ? -1 : 0) :
            0;
          processedRows.push({
            style_id: styleId,
            style_no: row.style_no,
            color: row.color,
            date,
            size: row.size,
            quantity: qtyPerDay + remainderAdjustment // Distribute remainder (supports negatives)
          });
        });
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }
    
    if (processedRows.length === 0) {
      return NextResponse.json({ 
        error: 'No valid rows to insert', 
        errors,
        successCount: 0,
        errorCount: rows.length 
      }, { status: 400 });
    }
    
    // Insert in batches (upsert to handle duplicates)
    const batchSize = 500;
    let successCount = 0;
    
    for (let i = 0; i < processedRows.length; i += batchSize) {
      const batch = processedRows.slice(i, i + batchSize);
      
      const { error: insertError } = await supabase
        .from('historical_sales')
        .upsert(batch, { 
          onConflict: 'style_no,color,date,size',
          ignoreDuplicates: false 
        });
      
      if (insertError) {
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${insertError.message}`);
      } else {
        successCount += batch.length;
      }
    }
    
    return NextResponse.json({ 
      successCount,
      errorCount: errors.length,
      totalProcessed: processedRows.length,
      totalInput: rows.length,
      errors: errors.slice(0, 50) // Limit error messages
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

