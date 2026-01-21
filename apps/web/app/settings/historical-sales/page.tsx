'use client';
import React, { useState, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { Dropzone } from '../../../components/ui/dropzone';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

// Types
type SalesRow = {
  style_no: string;
  color: string;
  date: string;
  size: string;
  quantity: number;
};

type WideRow = {
  styleName: string;
  color: string;
  dateRange: string;
  sizes: Record<string, number>;
};

type ParsedWideRow = WideRow & {
  matchedStyleNo: string | null;
  matchedColor: string | null;
  styleScore: number;
  colorScore: number;
  status: 'matched' | 'unmatched_style' | 'unmatched_color';
};

type StyleRow = {
  id: string;
  style_no: string;
  style_name: string | null;
};

type StyleColorRow = {
  id: string;
  style_id: string;
  color: string;
};

// Size columns we expect (can be flexible)
const SIZE_COLUMNS = ['34', '36', '38', '40', '42', '44', '46'];

// Fuzzy matching helpers
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean);
}

// Extract just the color name without numeric prefixes (e.g., "807 Black" -> "black")
function extractColorName(s: string): string {
  const norm = normalizeText(s);
  // Remove leading numbers and common prefixes
  return norm.replace(/^\d+\s*/, '').trim();
}

function fuzzyScore(query: string, target: string): number {
  const qNorm = normalizeText(query);
  const tNorm = normalizeText(target);
  if (qNorm === tNorm) return 1.0;
  if (tNorm.includes(qNorm) || qNorm.includes(tNorm)) return 0.9;

  const qTok = tokenize(query);
  const tTok = tokenize(target);
  if (qTok.length === 0 || tTok.length === 0) return 0;

  let overlap = 0;
  for (const qt of qTok) {
    if (tTok.some((tt) => tt === qt || tt.includes(qt) || qt.includes(tt))) {
      overlap++;
    }
  }
  return overlap / Math.max(qTok.length, tTok.length);
}

// Enhanced color matching: handles cases like "Black" -> "807 Black"
function colorFuzzyScore(query: string, target: string): number {
  const qNorm = normalizeText(query);
  const tNorm = normalizeText(target);
  
  // Exact match
  if (qNorm === tNorm) return 1.0;
  
  // Target contains query (e.g., "807 black" contains "black")
  if (tNorm.includes(qNorm)) return 0.95;
  
  // Query contains target
  if (qNorm.includes(tNorm)) return 0.9;
  
  // Extract color names without numeric prefixes and compare
  const qColor = extractColorName(query);
  const tColor = extractColorName(target);
  
  if (qColor && tColor) {
    if (qColor === tColor) return 0.92;
    if (tColor.includes(qColor) || qColor.includes(tColor)) return 0.85;
  }
  
  // Token-based matching
  const qTok = tokenize(query);
  const tTok = tokenize(target);
  if (qTok.length === 0 || tTok.length === 0) return 0;

  let overlap = 0;
  for (const qt of qTok) {
    // Skip numeric tokens for color matching
    if (/^\d+$/.test(qt)) continue;
    if (tTok.some((tt) => tt === qt || tt.includes(qt) || qt.includes(tt))) {
      overlap++;
    }
  }
  
  // Only count non-numeric query tokens
  const nonNumericQTok = qTok.filter(t => !/^\d+$/.test(t));
  if (nonNumericQTok.length === 0) return 0;
  
  return (overlap / nonNumericQTok.length) * 0.8;
}

function bestMatch(query: string, candidates: string[]): { match: string | null; score: number } {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = fuzzyScore(query, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { match: best, score: bestScore };
}

function bestColorMatch(query: string, candidates: string[]): { match: string | null; score: number } {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = colorFuzzyScore(query, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { match: best, score: bestScore };
}

export default function HistoricalSalesPage() {
  const supabase = createClientComponentClient();
  
  // Wide format upload state
  const [wideRows, setWideRows] = useState<WideRow[]>([]);
  const [parsedRows, setParsedRows] = useState<ParsedWideRow[]>([]);
  const [detectedSizes, setDetectedSizes] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ success: boolean; message: string } | null>(null);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  
  // Reset state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  
  // Browse state
  const [styleInput, setStyleInput] = useState('');
  const [colorInput, setColorInput] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [salesData, setSalesData] = useState<SalesRow[]>([]);
  const [salesCount, setSalesCount] = useState<number | null>(null);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);

  // Fetch styles for matching
  const { data: styles } = useSWR('historical-sales:styles', async () => {
    const { data } = await supabase
      .from('styles')
      .select('id, style_no, style_name')
      .order('style_no');
    return (data ?? []) as StyleRow[];
  });

  // Fetch style colors for matching
  const { data: styleColors } = useSWR('historical-sales:style-colors', async () => {
    const { data } = await supabase
      .from('style_colors')
      .select('id, style_id, color')
      .order('color');
    return (data ?? []) as StyleColorRow[];
  });

  // Parsed style numbers for browse
  const parsedStyleNos = useMemo(
    () =>
      Array.from(
        new Set(
          styleInput
            .split(/[\s,;\n]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        )
      ),
    [styleInput]
  );

  // Create a map of style_no -> available colors for the color dropdown
  const colorsByStyleNo = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!styles || !styleColors) return map;
    
    styleColors.forEach(sc => {
      const style = styles.find(s => s.id === sc.style_id);
      if (style) {
        const existing = map.get(style.style_no) || [];
        if (!existing.includes(sc.color)) {
          existing.push(sc.color);
        }
        map.set(style.style_no, existing);
      }
    });
    
    // Sort colors alphabetically for each style
    map.forEach((colors, styleNo) => {
      map.set(styleNo, colors.sort());
    });
    
    return map;
  }, [styles, styleColors]);

  // Function to update a row's matched color
  function updateRowColor(rowIndex: number, newColor: string) {
    setParsedRows(prev => prev.map((row, idx) => {
      if (idx !== rowIndex) return row;
      
      const wasUnmatchedColor = row.status === 'unmatched_color';
      const nowMatched = newColor !== '';
      
      return {
        ...row,
        matchedColor: newColor || null,
        colorScore: newColor ? 1.0 : 0, // Manual selection = perfect match
        status: !row.matchedStyleNo ? 'unmatched_style' : 
                nowMatched ? 'matched' : 'unmatched_color'
      };
    }));
  }

  // Parse Excel file (wide format)
  const handleFileDrop = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const wsname = wb.SheetNames?.[0];
        if (!wsname) {
          setUploadResult({ success: false, message: 'No sheets found in file' });
          return;
        }
        
        const ws = wb.Sheets[wsname];
        if (!ws) {
          setUploadResult({ success: false, message: 'Could not read sheet' });
          return;
        }
        
        const json: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const headers = Object.keys(json[0] || {});
        
        // Detect column mappings
        let styleCol = headers.find(h => /style[\s_-]?name|style[\s_-]?no|style/i.test(h));
        let colorCol = headers.find(h => /^color$|^colour$/i.test(h));
        let dateCol = headers.find(h => /date[\s_-]?(to[\s_-]?from)?|period|range/i.test(h));
        
        // Detect size columns (numeric headers or known sizes)
        const sizeCols = headers.filter(h => {
          const trimmed = h.trim();
          // Check for numeric size
          if (/^\d{2}$/.test(trimmed)) return true;
          // Check for size names
          if (/^(xs|s|m|l|xl|xxl|xxxl|one[\s_-]?size)$/i.test(trimmed)) return true;
          return false;
        });
        
        if (!styleCol || !colorCol) {
          setUploadResult({ 
            success: false, 
            message: `Could not detect required columns. Found: ${headers.join(', ')}. Need: Style Name/No, Color, and size columns (34, 36, etc.)` 
          });
          return;
        }
        
        setDetectedSizes(sizeCols);
        
        // Parse rows into wide format
        const rows: WideRow[] = json.map(row => {
          const sizes: Record<string, number> = {};
          for (const sizeCol of sizeCols) {
            const val = row[sizeCol];
            const num = typeof val === 'number' ? val : parseInt(String(val), 10);
            if (!isNaN(num) && num > 0) {
              sizes[sizeCol.trim()] = num;
            }
          }
          
          return {
            styleName: String(row[styleCol!] ?? '').trim(),
            color: String(row[colorCol!] ?? '').trim(),
            dateRange: dateCol ? String(row[dateCol] ?? '').trim() : '',
            sizes
          };
        }).filter(r => r.styleName && r.color && Object.keys(r.sizes).length > 0);
        
        setWideRows(rows);
        setUploadResult(null);
        
        // Now match styles and colors
        if (styles && styleColors) {
          matchRows(rows, styles, styleColors);
        }
      } catch (err: any) {
        setUploadResult({ success: false, message: `Error parsing file: ${err.message}` });
      }
    };
    reader.readAsArrayBuffer(file);
  }, [styles, styleColors]);

  // Match rows to styles and colors
  function matchRows(rows: WideRow[], allStyles: StyleRow[], allColors: StyleColorRow[]) {
    const styleNoMap = new Map<string, string>();
    const styleNameMap = new Map<string, string>();
    allStyles.forEach(s => {
      styleNoMap.set(s.style_no.toLowerCase(), s.style_no);
      if (s.style_name) {
        styleNameMap.set(s.style_name.toLowerCase(), s.style_no);
      }
    });
    
    const colorsByStyle = new Map<string, string[]>();
    allColors.forEach(c => {
      const style = allStyles.find(s => s.id === c.style_id);
      if (style) {
        const existing = colorsByStyle.get(style.style_no) || [];
        existing.push(c.color);
        colorsByStyle.set(style.style_no, existing);
      }
    });
    
    const parsed: ParsedWideRow[] = rows.map(row => {
      // Try exact match on style_no first
      let matchedStyleNo = styleNoMap.get(row.styleName.toLowerCase()) || null;
      let styleScore = matchedStyleNo ? 1.0 : 0;
      
      // Try style_name match
      if (!matchedStyleNo) {
        matchedStyleNo = styleNameMap.get(row.styleName.toLowerCase()) || null;
        styleScore = matchedStyleNo ? 1.0 : 0;
      }
      
      // Try fuzzy match on style_name
      if (!matchedStyleNo && allStyles.length > 0) {
        const styleNames = allStyles.map(s => s.style_name || s.style_no);
        const { match, score } = bestMatch(row.styleName, styleNames);
        if (match && score >= 0.7) {
          const matched = allStyles.find(s => (s.style_name || s.style_no) === match);
          matchedStyleNo = matched?.style_no || null;
          styleScore = score;
        }
      }
      
      // Match color (with enhanced fuzzy matching for cases like "Black" -> "807 Black")
      let matchedColor: string | null = null;
      let colorScore = 0;
      
      if (matchedStyleNo) {
        const styleColorList = colorsByStyle.get(matchedStyleNo) || [];
        
        // Try exact match first
        const exactColor = styleColorList.find(c => c.toLowerCase() === row.color.toLowerCase());
        if (exactColor) {
          matchedColor = exactColor;
          colorScore = 1.0;
        } else if (styleColorList.length > 0) {
          // Try enhanced color fuzzy match (handles "Black" -> "807 Black")
          const { match, score } = bestColorMatch(row.color, styleColorList);
          if (match && score >= 0.5) { // Lower threshold since we have better matching
            matchedColor = match;
            colorScore = score;
          }
        }
      }
      
      const status: ParsedWideRow['status'] = 
        !matchedStyleNo ? 'unmatched_style' :
        !matchedColor ? 'unmatched_color' :
        'matched';
      
      return {
        ...row,
        matchedStyleNo,
        matchedColor,
        styleScore,
        colorScore,
        status
      };
    });
    
    setParsedRows(parsed);
  }

  // Re-match when styles/colors load
  React.useEffect(() => {
    if (wideRows.length > 0 && styles && styleColors) {
      matchRows(wideRows, styles, styleColors);
    }
  }, [wideRows, styles, styleColors]);

  // Upload matched rows
  async function uploadMatchedRows() {
    const matchedRows = parsedRows.filter(r => r.status === 'matched');
    if (matchedRows.length === 0) {
      setUploadResult({ success: false, message: 'No matched rows to upload' });
      return;
    }
    
    setUploading(true);
    setUploadProgress({ current: 0, total: matchedRows.length });
    setUploadResult(null);
    
    try {
      // Convert wide rows to tall format for API
      const tallRows: Array<{
        style_no: string;
        color: string;
        date: string;
        size: string;
        quantity: number;
      }> = [];
      
      for (const row of matchedRows) {
        for (const [size, qty] of Object.entries(row.sizes)) {
          tallRows.push({
            style_no: row.matchedStyleNo!,
            color: row.matchedColor!,
            date: row.dateRange || new Date().toISOString().split('T')[0]!,
            size,
            quantity: qty
          });
        }
      }
      
      // Upload in batches
      const batchSize = 500;
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];
      
      for (let i = 0; i < tallRows.length; i += batchSize) {
        const batch = tallRows.slice(i, i + batchSize);
        
        const response = await fetch('/api/historical-sales/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: batch })
        });
        
        const result = await response.json();
        
        if (response.ok) {
          successCount += result.successCount || batch.length;
          errorCount += result.errorCount || 0;
          if (result.errors) {
            errors.push(...result.errors.slice(0, 5));
          }
        } else {
          errorCount += batch.length;
          errors.push(result.error || 'Batch upload failed');
        }
        
        setUploadProgress({ current: Math.min(i + batchSize, tallRows.length), total: tallRows.length });
      }
      
      if (errorCount === 0) {
        setUploadResult({ 
          success: true, 
          message: `Successfully uploaded ${successCount} records from ${matchedRows.length} style/color combinations` 
        });
      } else {
        setUploadResult({ 
          success: false, 
          message: `Uploaded ${successCount} records, ${errorCount} errors.\n${errors.slice(0, 3).join('\n')}` 
        });
      }
    } catch (err: any) {
      setUploadResult({ success: false, message: `Upload failed: ${err.message}` });
    } finally {
      setUploading(false);
    }
  }

  // Browse historical sales
  async function fetchSalesData() {
    setSalesError(null);
    if (parsedStyleNos.length === 0) {
      setSalesError('Enter at least one style number.');
      return;
    }
    setSalesLoading(true);
    try {
      const payload: any = {
        style_nos: parsedStyleNos,
        start_date: dateFrom || undefined,
        end_date: dateTo || undefined
      };
      if (colorInput.trim()) {
        payload.colors = [colorInput.trim()];
      }
      const res = await fetch('/api/historical-sales/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok) {
        setSalesError(json.error || 'Failed to fetch sales data');
        setSalesData([]);
        setSalesCount(null);
        return;
      }
      setSalesData(json.data || []);
      setSalesCount(typeof json.count === 'number' ? json.count : null);
    } catch (err: any) {
      setSalesError(err.message || 'Failed to fetch sales data');
    } finally {
      setSalesLoading(false);
    }
  }

  // Stats for parsed rows
  const matchStats = useMemo(() => {
    const matched = parsedRows.filter(r => r.status === 'matched').length;
    const unmatchedStyle = parsedRows.filter(r => r.status === 'unmatched_style').length;
    const unmatchedColor = parsedRows.filter(r => r.status === 'unmatched_color').length;
    return { matched, unmatchedStyle, unmatchedColor, total: parsedRows.length };
  }, [parsedRows]);

  // Reset all historical sales data
  async function resetHistoricalSales() {
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      return;
    }
    
    setResetting(true);
    try {
      const response = await fetch('/api/historical-sales/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET_ALL_HISTORICAL_SALES' })
      });
      
      const result = await response.json();
      
      if (response.ok) {
        setUploadResult({ success: true, message: result.message || 'All historical sales data deleted' });
        setSalesData([]);
        setSalesCount(null);
      } else {
        setUploadResult({ success: false, message: result.error || 'Failed to reset data' });
      }
    } catch (err: any) {
      setUploadResult({ success: false, message: `Reset failed: ${err.message}` });
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">Settings</div>
          <h1 className="text-2xl font-semibold">Historical Sales Data</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload historical sales data in wide format (Style, Color, Size columns, Date range)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {showResetConfirm ? (
            <>
              <span className="text-sm text-red-600">Are you sure? This deletes ALL data!</span>
              <Button
                onClick={resetHistoricalSales}
                disabled={resetting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Yes, Delete All'}
              </Button>
              <Button
                onClick={() => setShowResetConfirm(false)}
                variant="outline"
                disabled={resetting}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              onClick={() => setShowResetConfirm(true)}
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50"
            >
              Reset All Data
            </Button>
          )}
        </div>
      </div>

      {/* Upload Section */}
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Upload Historical Sales (Wide Format)</CardTitle>
          <CardDescription>
            Upload an Excel file with columns: <strong>Style Name</strong>, <strong>Color</strong>, 
            size columns (<strong>34, 36, 38, 40, 42, 44, 46</strong>), and optional <strong>Date to-from</strong> (DD-MM-YYYY range).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Dropzone
            onFiles={handleFileDrop}
            accept=".xlsx,.xls,.csv"
          >
            <div className="text-center py-8">
              <p className="text-sm text-slate-600">
                Drop Excel file here or click to browse
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Supports .xlsx, .xls, .csv
              </p>
            </div>
          </Dropzone>

          {/* Detected sizes */}
          {detectedSizes.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">Detected sizes:</span>
              {detectedSizes.map(size => (
                <Badge key={size} className="bg-slate-100">{size}</Badge>
              ))}
            </div>
          )}

          {/* Matching stats */}
          {parsedRows.length > 0 && (
            <div className="border rounded-lg p-4 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm">Matching Results</h3>
                <span className="text-sm text-slate-500">{matchStats.total} rows parsed</span>
              </div>
              
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span className="text-sm">{matchStats.matched} matched</span>
                </div>
                {matchStats.unmatchedStyle > 0 && (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-red-500" />
                    <span className="text-sm">{matchStats.unmatchedStyle} style not found</span>
                  </div>
                )}
                {matchStats.unmatchedColor > 0 && (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm">{matchStats.unmatchedColor} color not found — <em className="text-slate-500">select from dropdown</em></span>
                  </div>
                )}
              </div>

              {/* Preview table */}
              <div className="max-h-64 overflow-auto border rounded bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="p-2 text-left border-b">Status</th>
                      <th className="p-2 text-left border-b">Style Input</th>
                      <th className="p-2 text-left border-b">Matched Style</th>
                      <th className="p-2 text-left border-b">Color Input</th>
                      <th className="p-2 text-left border-b">Matched Color <span className="font-normal text-slate-400">(editable)</span></th>
                      <th className="p-2 text-left border-b">Date Range</th>
                      <th className="p-2 text-right border-b">Total Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 20).map((row, idx) => (
                      <tr key={idx} className={row.status !== 'matched' ? 'bg-red-50' : ''}>
                        <td className="p-2 border-b">
                          {row.status === 'matched' ? (
                            <Badge className="bg-green-100 text-green-800 text-[10px]">OK</Badge>
                          ) : row.status === 'unmatched_style' ? (
                            <Badge className="bg-red-100 text-red-800 text-[10px]">No Style</Badge>
                          ) : (
                            <Badge className="bg-yellow-100 text-yellow-800 text-[10px]">No Color</Badge>
                          )}
                        </td>
                        <td className="p-2 border-b">{row.styleName}</td>
                        <td className="p-2 border-b font-mono text-[10px]">
                          {row.matchedStyleNo || '—'}
                          {row.styleScore < 1 && row.styleScore >= 0.7 && (
                            <span className="text-slate-400 ml-1">({Math.round(row.styleScore * 100)}%)</span>
                          )}
                        </td>
                        <td className="p-2 border-b">{row.color}</td>
                        <td className="p-2 border-b">
                          {row.matchedStyleNo ? (
                            <select
                              value={row.matchedColor || ''}
                              onChange={(e) => updateRowColor(idx, e.target.value)}
                              className={`w-full text-xs px-1.5 py-1 rounded border ${
                                row.matchedColor 
                                  ? 'border-green-300 bg-green-50' 
                                  : 'border-red-300 bg-red-50'
                              } focus:outline-none focus:ring-1 focus:ring-[#8FA894]`}
                            >
                              <option value="">— Select color —</option>
                              {(colorsByStyleNo.get(row.matchedStyleNo) || []).map(c => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                          {row.colorScore < 1 && row.colorScore >= 0.5 && row.matchedColor && (
                            <span className="text-[10px] text-slate-400 ml-1">auto</span>
                          )}
                        </td>
                        <td className="p-2 border-b text-slate-600">{row.dateRange || '(no date)'}</td>
                        <td className="p-2 border-b text-right font-mono">
                          {Object.values(row.sizes).reduce((a, b) => a + b, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 20 && (
                <p className="text-xs text-slate-500">Showing first 20 of {parsedRows.length} rows</p>
              )}

              {/* Upload button */}
              <div className="flex items-center gap-4">
                <Button
                  onClick={uploadMatchedRows}
                  disabled={uploading || matchStats.matched === 0}
                  className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Uploading... ({uploadProgress.current}/{uploadProgress.total})
                    </>
                  ) : (
                    `Upload ${matchStats.matched} Matched Rows`
                  )}
                </Button>
                {matchStats.matched < matchStats.total && (
                  <span className="text-xs text-slate-500">
                    {matchStats.unmatchedColor > 0 
                      ? 'Fix unmatched colors in the dropdown above, or they will be skipped'
                      : 'Unmatched style rows will be skipped'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Upload result */}
          {uploadResult && (
            <div className={`p-3 rounded-md text-sm whitespace-pre-wrap ${
              uploadResult.success ? 'bg-green-50 text-green-900 border border-green-200' : 'bg-red-50 text-red-900 border border-red-200'
            }`}>
              {uploadResult.message}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Browse Section */}
      <Card>
        <CardHeader>
          <CardTitle>Browse Historical Sales</CardTitle>
          <CardDescription>
            Select style(s), optional color, and a date range to view stored sales entries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Style number(s)</label>
              <textarea
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm h-24"
                placeholder="One or more style numbers, separated by comma, space, or newline"
                value={styleInput}
                onChange={(e) => setStyleInput(e.target.value)}
              />
              <div className="text-[11px] text-slate-500">
                Parsed styles: {parsedStyleNos.length}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">Color (optional)</label>
                <Input
                  placeholder="Exact color name"
                  value={colorInput}
                  onChange={(e) => setColorInput(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">From date</label>
                  <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">To date</label>
                  <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </div>
              </div>
              <div>
                <Button onClick={fetchSalesData} disabled={salesLoading || parsedStyleNos.length === 0}>
                  {salesLoading ? 'Loading…' : 'Fetch Sales'}
                </Button>
              </div>
            </div>
          </div>

          {salesError && (
            <div className="p-3 rounded-md text-sm bg-red-50 text-red-900 border border-red-200">
              {salesError}
            </div>
          )}

          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Style</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salesData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-slate-500">
                      {salesLoading ? 'Loading sales…' : 'No data yet'}
                    </TableCell>
                  </TableRow>
                ) : (
                  salesData.map((row, idx) => (
                    <TableRow key={`${row.style_no}-${row.color}-${row.date}-${row.size}-${idx}`}>
                      <TableCell>{row.style_no}</TableCell>
                      <TableCell>{row.color}</TableCell>
                      <TableCell>{row.date}</TableCell>
                      <TableCell>{row.size}</TableCell>
                      <TableCell className="text-right">{row.quantity}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="text-xs text-slate-600 flex items-center gap-2">
            <span>Rows shown: {salesData.length}</span>
            {salesCount !== null && <span className="text-slate-500">| Total matched: {salesCount}</span>}
            <span className="text-slate-500">Limit 500 per query</span>
          </div>
        </CardContent>
      </Card>

      {/* Format Guide */}
      <Card>
        <CardHeader>
          <CardTitle>File Format Guide (Wide Format)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <strong>Required Columns:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li><strong>Style Name</strong> or <strong>Style No</strong> - Will be fuzzy-matched to system styles</li>
              <li><strong>Color</strong> - Color name, fuzzy-matched to style's available colors</li>
              <li><strong>Size columns (34, 36, 38, 40, 42, 44, 46)</strong> - Quantities per size</li>
              <li><strong>Date to-from</strong> (optional) - Date or date range</li>
            </ul>
          </div>
          
          <div>
            <strong>Date Format Examples:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li>DD-MM-YYYY: <code className="bg-slate-100 px-1 rounded">15-01-2025</code></li>
              <li>Date range: <code className="bg-slate-100 px-1 rounded">01-01-2025 - 31-01-2025</code></li>
              <li>ISO format: <code className="bg-slate-100 px-1 rounded">2025-01-15</code></li>
            </ul>
          </div>

          <div>
            <strong>Example Data (Wide Format):</strong>
            <div className="mt-2 overflow-x-auto">
              <table className="text-xs border">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-2 border">Style Name</th>
                    <th className="p-2 border">Color</th>
                    <th className="p-2 border">34</th>
                    <th className="p-2 border">36</th>
                    <th className="p-2 border">38</th>
                    <th className="p-2 border">40</th>
                    <th className="p-2 border">42</th>
                    <th className="p-2 border">44</th>
                    <th className="p-2 border">46</th>
                    <th className="p-2 border">Date to-from</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border">SUMMER BLAZER</td>
                    <td className="p-2 border">NAVY BLUE</td>
                    <td className="p-2 border">5</td>
                    <td className="p-2 border">8</td>
                    <td className="p-2 border">12</td>
                    <td className="p-2 border">15</td>
                    <td className="p-2 border">10</td>
                    <td className="p-2 border">6</td>
                    <td className="p-2 border">3</td>
                    <td className="p-2 border">01-01-2025 - 31-01-2025</td>
                  </tr>
                  <tr>
                    <td className="p-2 border">WINTER COAT</td>
                    <td className="p-2 border">BLACK</td>
                    <td className="p-2 border">3</td>
                    <td className="p-2 border">5</td>
                    <td className="p-2 border">8</td>
                    <td className="p-2 border">10</td>
                    <td className="p-2 border">7</td>
                    <td className="p-2 border">4</td>
                    <td className="p-2 border">2</td>
                    <td className="p-2 border">15-01-2025</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
