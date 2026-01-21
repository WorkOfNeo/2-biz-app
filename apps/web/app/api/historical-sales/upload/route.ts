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

// Parse a single date string into YYYY-MM-DD format
// Supports: YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, Excel serial numbers
function parseDate(dateStr: string): string | null {
  const trimmed = dateStr.trim();
  
  // Check for Excel serial number (number between 1 and 60000)
  const numVal = Number(trimmed);
  if (!isNaN(numVal) && numVal > 1 && numVal < 60000) {
    // Excel date serial: days since 1899-12-30 (with Excel's leap year bug)
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + numVal * 24 * 60 * 60 * 1000);
    if (!isNaN(date.getTime())) {
      const isoDate = date.toISOString().split('T')[0];
      return isoDate || null;
    }
  }
  
  // Try DD-MM-YYYY, DD/MM/YYYY, or DD.MM.YYYY format first (common in Europe)
  const ddmmyyyyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (ddmmyyyyMatch) {
    const day = parseInt(ddmmyyyyMatch[1]!, 10);
    const month = parseInt(ddmmyyyyMatch[2]!, 10);
    const year = parseInt(ddmmyyyyMatch[3]!, 10);
    
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        const isoDate = date.toISOString().split('T')[0];
        return isoDate || null;
      }
    }
  }
  
  // Try YYYY-MM-DD (ISO format)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      const isoDate = date.toISOString().split('T')[0];
      return isoDate || null;
    }
  }
  
  // Try native Date parsing as fallback
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const isoDate = date.toISOString().split('T')[0];
    return isoDate || null;
  }
  
  return null;
}

function parseDateRange(dateStr: string): string[] {
  const trimmed = dateStr.trim();
  
  // If empty, return today's date
  if (!trimmed) {
    const today = new Date().toISOString().split('T')[0];
    return today ? [today] : [];
  }
  
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
    const parsed = parseDate(trimmed);
    if (parsed) {
      return [parsed];
    }
    throw new Error(`Invalid date: ${dateStr}`);
  }
  
  // Parse start and end dates
  const startParsed = parseDate(startStr);
  const endParsed = parseDate(endStr);
  
  if (!startParsed || !endParsed) {
    throw new Error(`Invalid date range: ${dateStr}`);
  }
  
  const startDate = new Date(startParsed);
  const endDate = new Date(endParsed);
  
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
    const isoDate = current.toISOString().split('T')[0];
    if (isoDate) {
      dates.push(isoDate);
    }
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

    console.log('[Historical Sales Upload API] Processing', rows.length, 'rows');

    // Validate and process rows
    const errors: string[] = [];
    const warnings: string[] = [];
    const processedRows: ProcessedRow[] = [];
    
    // Fetch all unique style_nos to get style_ids
    const uniqueStyleNos = Array.from(new Set(rows.map((r: UploadRow) => r.style_no)));
    const { data: styles, error: stylesError } = await supabase
      .from('styles')
      .select('id, style_no')
      .in('style_no', uniqueStyleNos);
    
    if (stylesError) {
      console.error('[Historical Sales Upload API] Styles query failed:', stylesError);
      return NextResponse.json({ error: stylesError.message }, { status: 500 });
    }
    
    console.log('[Historical Sales Upload API] Found', styles?.length || 0, 'styles for', uniqueStyleNos.length, 'unique style_nos');
    
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
      console.error('[Historical Sales Upload API] Colors query failed:', colorsError);
      return NextResponse.json({ error: colorsError.message }, { status: 500 });
    }
    
    console.log('[Historical Sales Upload API] Found', styleColors?.length || 0, 'colors');
    
    let fuzzyMatchCount = 0;
    
    // Build a map of valid style_id + color combinations (case-insensitive)
    const validStyleColorMap = new Map<string, boolean>();
    const styleColorsByStyleId = new Map<string, string[]>();
    const styleColorsOriginalCase = new Map<string, string>(); // key -> original case color
    (styleColors || []).forEach((sc: any) => {
      const colorLower = String(sc.color || '').trim().toLowerCase();
      const key = `${sc.style_id}|${colorLower}`;
      validStyleColorMap.set(key, true);
      styleColorsOriginalCase.set(key, sc.color);
      if (!styleColorsByStyleId.has(sc.style_id)) {
        styleColorsByStyleId.set(sc.style_id, []);
      }
      styleColorsByStyleId.get(sc.style_id)!.push(sc.color);
    });
    
    // Helper: fuzzy match color for a given style
    function findBestColorMatch(styleId: string, inputColor: string): string | null {
      const availableColors = styleColorsByStyleId.get(styleId) || [];
      const inputLower = inputColor.trim().toLowerCase();
      
      // 1. Try exact match (case-insensitive)
      for (const color of availableColors) {
        if (color.toLowerCase() === inputLower) {
          return color;
        }
      }
      
      // 2. Try finding a color that contains the input as a word
      const inputWords = inputLower.split(/\s+/).filter(Boolean);
      for (const color of availableColors) {
        const colorLower = color.toLowerCase();
        // Check if all input words are contained in the color
        if (inputWords.every(word => colorLower.includes(word))) {
          return color;
        }
      }
      
      // 3. Try finding a color where the input contains any of its words
      for (const color of availableColors) {
        const colorWords = color.toLowerCase().split(/\s+/).filter(Boolean);
        if (colorWords.some(word => inputLower.includes(word) && word.length > 2)) {
          return color;
        }
      }
      
      return null;
    }
    
    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as UploadRow;
      
      try {
        // Validate required fields
        if (!row.style_no || !row.color || !row.date || !row.size) {
          errors.push(`Row ${i + 1}: Missing required fields`);
          continue;
        }
        
        // style_id is optional - we can store data even if style doesn't exist in DB
        // The lookup happens later by style_no when querying
        const styleId = styleMap.get(row.style_no) || null;
        
        // Try to fuzzy-match color if we have the style in DB
        let finalColor = row.color;
        if (styleId) {
          const colorKey = `${styleId}|${String(row.color || '').trim().toLowerCase()}`;
          if (!validStyleColorMap.has(colorKey)) {
            // Try fuzzy match
            const fuzzyMatch = findBestColorMatch(styleId, row.color);
            if (fuzzyMatch) {
              finalColor = fuzzyMatch;
              fuzzyMatchCount++;
            }
          }
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
            color: finalColor, // Use fuzzy-matched color if available
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
    
    console.log('[Historical Sales Upload API] Complete:', {
      successCount,
      errorCount: errors.length,
      warningCount: warnings.length,
      fuzzyMatchCount,
      totalProcessed: processedRows.length
    });

    return NextResponse.json({ 
      successCount,
      errorCount: errors.length,
      warningCount: warnings.length,
      fuzzyMatchCount,
      totalProcessed: processedRows.length,
      totalInput: rows.length,
      errors: errors.slice(0, 50), // Limit error messages
      warnings: warnings.slice(0, 20) // Include some warnings
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

