'use client';
import React, { useState, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { Dropzone } from '../../../components/ui/dropzone';
import { AlertCircle, CheckCircle, Loader2, Download, TrendingUp, Calendar, BarChart3, Search, Plus, X, FileDown } from 'lucide-react';
import { DailyLineChart, StackedAreaByColor, SizeDistributionBar } from '../../../components/charts';
import { getColorForName } from '../../../lib/chartColors';

// Types
type SalesRow = {
  style_no: string;
  color: string;
  date: string;
  size: string;
  quantity: number;
  order_type?: string | null;
  order_channel?: string | null;
};

type NarrowRow = {
  styleNo: string;
  styleName: string;
  size: string;
  quantity: number;
  date: string;
  orderType?: string;
  orderChannel?: string;
};

type ParsedNarrowRow = NarrowRow & {
  matchedStyleNo: string | null;
  matchedColor: string | null;
  styleScore: number;
  colorScore: number;
  matchNote: string | null;
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

type ColumnMapping = {
  styleNo: string | null;
  styleName: string | null;
  size: string | null;
  quantity: string | null;
  date: string | null;
  orderType: string | null;
  orderChannel: string | null;
};

type RawFileData = {
  headers: string[];
  rows: Record<string, any>[];
};

// =====================================================
// HARD-CODED STYLE/COLOR RULES
// Format: { styleName (lowercase): { colorPattern: style_no } }
// colorPattern can match multiple colors separated by |
// =====================================================
const HARDCODED_RULES: Record<string, Record<string, string>> = {
  'rany': {
    'denim|dark denim': '1010191-D',
    'light denim': '1010191-LD',
  },
  'karcemona': {
    'denim|dark denim': '1011396-D',
  },
  'kaxy': {
    'black|navy': '1007952-MS',
    'denim|dark denim': '1007952-D',
  },
};

// Helper to check if a color matches a pattern (e.g., "denim|dark denim")
function matchesColorPattern(inputColor: string, pattern: string): boolean {
  const inputLower = inputColor.toLowerCase().trim();
  const patterns = pattern.split('|').map(p => p.trim().toLowerCase());
  return patterns.some(p => inputLower === p || inputLower.includes(p) || p.includes(inputLower));
}

// Check hardcoded rules and return style_no if matched
function checkHardcodedRules(styleName: string, color: string): string | null {
  const styleNameLower = styleName.toLowerCase().trim();
  
  // Check if any rule key is contained in the style name or vice versa
  for (const [ruleStyleName, colorRules] of Object.entries(HARDCODED_RULES)) {
    if (styleNameLower.includes(ruleStyleName) || ruleStyleName.includes(styleNameLower)) {
      for (const [colorPattern, styleNo] of Object.entries(colorRules)) {
        if (matchesColorPattern(color, colorPattern)) {
          return styleNo;
        }
      }
    }
  }
  return null;
}

// Fuzzy matching helpers
function fuzzyScore(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();
  
  if (aLower === bLower) return 1.0;
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.9;
  
  // Simple character overlap
  const aSet = new Set(aLower.split(''));
  const bSet = new Set(bLower.split(''));
  const intersection = new Set([...aSet].filter(x => bSet.has(x)));
  const union = new Set([...aSet, ...bSet]);
  return intersection.size / union.size;
}

// Parse date from various formats
function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  
  const str = String(dateStr).trim();
  
  // Excel serial number (days since 1900-01-01)
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date = new Date(utc_value * 1000);
    return date.toISOString().split('T')[0] || null;
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

// Auto-detect column mapping based on header names
function autoDetectColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    styleNo: null,
    styleName: null,
    size: null,
    quantity: null,
    date: null,
    orderType: null,
    orderChannel: null,
  };
  
  for (const header of headers) {
    const lower = header.toLowerCase().trim();
    
    // Style No
    if (!mapping.styleNo && /^style[\s_-]?no\.?$|^style[\s_-]?number$/i.test(header)) {
      mapping.styleNo = header;
    }
    
    // Style Name
    if (!mapping.styleName && /^style[\s_-]?name$/i.test(header)) {
      mapping.styleName = header;
    }
    
    // Size
    if (!mapping.size && /^size$/i.test(header)) {
      mapping.size = header;
    }
    
    // Quantity
    if (!mapping.quantity && /^qty$|^quantity$/i.test(header)) {
      mapping.quantity = header;
    }
    
    // Date
    if (!mapping.date && /^date$/i.test(header)) {
      mapping.date = header;
    }
    
    // Order Type
    if (!mapping.orderType && /^order[\s_-]?type$/i.test(header)) {
      mapping.orderType = header;
    }
    
    // Order Channel
    if (!mapping.orderChannel && /^order[\s_-]?channel$/i.test(header)) {
      mapping.orderChannel = header;
    }
  }
  
  return mapping;
}

export default function HistoricalSalesPage() {
  const supabase = createClientComponentClient();
  
  // State
  const [activeTab, setActiveTab] = useState<'upload' | 'browse' | 'analytics'>('upload');
  const [rawFileData, setRawFileData] = useState<RawFileData | null>(null);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedNarrowRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [uploadResult, setUploadResult] = useState<{ success: boolean; message: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsingProgress, setParsingProgress] = useState({ current: 0, total: 0, phase: '' });
  
  // Modal states
  const [addColorModal, setAddColorModal] = useState<{
    show: boolean;
    rowIndex: number;
    styleNo: string | null;
    styleId: string | null;
    originalColor: string;
  } | null>(null);
  const [newColorName, setNewColorName] = useState('');
  const [savingColor, setSavingColor] = useState(false);
  
  // Fetch styles and colors
  const { data: styles, error: stylesError } = useSWR<StyleRow[]>(
    'styles',
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('id, style_no, style_name')
        .order('style_no');
      if (error) throw error;
      return data || [];
    }
  );
  
  const { data: styleColors, error: styleColorsError } = useSWR<StyleColorRow[]>(
    'style_colors',
    async () => {
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, style_id, color')
        .order('color');
      if (error) throw error;
      return data || [];
    }
  );
  
  // Fetch sales data for browse tab
  const { data: salesData = [], mutate: mutateSales } = useSWR<SalesRow[]>(
    activeTab === 'browse' ? 'historical_sales' : null,
    async () => {
      const { data, error } = await supabase
        .from('historical_sales')
        .select('style_no, color, date, size, quantity, order_type, order_channel')
        .order('date', { ascending: false })
        .order('style_no')
        .limit(500);
      if (error) throw error;
      return data || [];
    }
  );
  
  // Get sales count
  const { data: salesCount } = useSWR<number>(
    activeTab === 'browse' ? 'historical_sales_count' : null,
    async () => {
      const { count, error } = await supabase
        .from('historical_sales')
        .select('*', { count: 'exact', head: true });
      if (error) throw error;
      return count || 0;
    }
  );
  
  // Create maps for matching
  const colorsByStyleNo = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!styles || !styleColors) return map;
    
    for (const style of styles) {
      const colors = styleColors
        .filter(sc => sc.style_id === style.id)
        .map(sc => sc.color);
      map.set(style.style_no, colors);
    }
    return map;
  }, [styles, styleColors]);
  
  // Match stats
  const matchStats = useMemo(() => {
    const total = parsedRows.length;
    const matched = parsedRows.filter(r => r.status === 'matched').length;
    const unmatchedStyle = parsedRows.filter(r => r.status === 'unmatched_style').length;
    const unmatchedColor = parsedRows.filter(r => r.status === 'unmatched_color').length;
    return { total, matched, unmatchedStyle, unmatchedColor };
  }, [parsedRows]);
  
  // Parse file - step 1: read file and detect columns
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
        
        if (headers.length === 0) {
          setUploadResult({ success: false, message: 'No columns found in file' });
          return;
        }
        
        // Auto-detect columns
        const detected = autoDetectColumns(headers);
        
        setRawFileData({ headers, rows: json });
        setColumnMapping(detected);
        setUploadResult(null);
        setParsedRows([]);
      } catch (error) {
        console.error('[Historical Sales] File read error:', error);
        setUploadResult({ success: false, message: `Error reading file: ${error}` });
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);
  
  // Step 2: Parse rows after column mapping is confirmed
  const parseRowsWithMapping = useCallback(async () => {
    if (!rawFileData || !columnMapping || !styles) return;
    
    const { styleNo, styleName, size, quantity, date, orderType, orderChannel } = columnMapping;
    
    // Validate required columns
    if (!styleNo || !styleName || !size || !quantity || !date) {
      setUploadResult({
        success: false,
        message: 'Please map all required columns: Style No, Style Name, Size, Quantity, and Date'
      });
      return;
    }
    
    console.log('[Historical Sales] Starting parse with column mapping:', { styleNo, styleName, size, quantity, date, orderType, orderChannel });
    console.log('[Historical Sales] Total rows in file:', rawFileData.rows.length);
    console.log('[Historical Sales] First 3 rows sample:', rawFileData.rows.slice(0, 3));
    
    setParsing(true);
    setParsingProgress({ current: 0, total: rawFileData.rows.length, phase: 'Parsing rows...' });
    
    try {
      // Phase 1: Parse raw data into structured rows
      const rows: NarrowRow[] = [];
      const rawBatchSize = 1000;
      const filterStats = {
        total: 0,
        noStyleNo: 0,
        noStyleName: 0,
        noSize: 0,
        zeroQty: 0,
        noDate: 0,
      };
      
      for (let i = 0; i < rawFileData.rows.length; i += rawBatchSize) {
        const batch = rawFileData.rows.slice(i, i + rawBatchSize);
        
        const batchRows = batch.map((row, batchIdx) => {
          const parsedDate = parseDate(row[date]);
          const qty = typeof row[quantity] === 'number' ? row[quantity] : parseInt(String(row[quantity] || '0'), 10);
          
          const parsed = {
            styleNo: String(row[styleNo] || '').trim(),
            styleName: String(row[styleName] || '').trim(),
            size: String(row[size] || '').trim(),
            quantity: isNaN(qty) ? 0 : qty,
            date: parsedDate || '',
            orderType: orderType ? String(row[orderType] || '').trim() : undefined,
            orderChannel: orderChannel ? String(row[orderChannel] || '').trim() : undefined,
          };
          
          // Log first 5 rows for debugging
          if (i + batchIdx < 5) {
            console.log(`[Historical Sales] Row ${i + batchIdx} parsed:`, {
              raw: row,
              parsed,
              willBeFiltered: !parsed.styleNo || !parsed.styleName || !parsed.size || parsed.quantity <= 0 || !parsed.date,
              filterReasons: {
                styleNo: !parsed.styleNo ? `MISSING (value: "${row[styleNo]}")` : 'OK',
                styleName: !parsed.styleName ? `MISSING (value: "${row[styleName]}")` : 'OK',
                size: !parsed.size ? `MISSING (value: "${row[size]}")` : 'OK',
                quantity: parsed.quantity <= 0 ? `INVALID (raw: "${row[quantity]}", parsed: ${parsed.quantity})` : 'OK',
                date: !parsed.date ? `FAILED (raw: "${row[date]}", parsed: "${parsedDate}")` : 'OK',
              }
            });
          }
          
          return parsed;
        });
        
        // Track filter reasons
        batchRows.forEach(r => {
          filterStats.total++;
          if (!r.styleNo) filterStats.noStyleNo++;
          if (!r.styleName) filterStats.noStyleName++;
          if (!r.size) filterStats.noSize++;
          if (r.quantity <= 0) filterStats.zeroQty++;
          if (!r.date) filterStats.noDate++;
        });
        
        const filteredBatchRows = batchRows.filter(r => r.styleNo && r.styleName && r.size && r.quantity > 0 && r.date);
        
        rows.push(...filteredBatchRows);
        setParsingProgress({ 
          current: Math.min(i + rawBatchSize, rawFileData.rows.length), 
          total: rawFileData.rows.length, 
          phase: 'Parsing rows...' 
        });
        
        // Allow UI to update
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      console.log('[Historical Sales] Filter statistics:', filterStats);
      console.log('[Historical Sales] Valid rows after filtering:', rows.length);
      
      if (rows.length === 0) {
        const issues = [];
        if (filterStats.noStyleNo > 0) issues.push(`${filterStats.noStyleNo} rows missing Style No`);
        if (filterStats.noStyleName > 0) issues.push(`${filterStats.noStyleName} rows missing Style Name`);
        if (filterStats.noSize > 0) issues.push(`${filterStats.noSize} rows missing Size`);
        if (filterStats.zeroQty > 0) issues.push(`${filterStats.zeroQty} rows with zero/invalid Quantity`);
        if (filterStats.noDate > 0) issues.push(`${filterStats.noDate} rows with invalid Date`);
        
        throw new Error(`No valid rows found!\n\nProblems:\n${issues.join('\n')}\n\nCheck browser console (F12) for detailed row-by-row analysis.`);
      }
      
      // Phase 2: Match against styles and colors
      setParsingProgress({ current: 0, total: rows.length, phase: 'Matching styles and colors...' });
      const parsed: ParsedNarrowRow[] = [];
      const matchBatchSize = 500;
      
      for (let i = 0; i < rows.length; i += matchBatchSize) {
        const batch = rows.slice(i, i + matchBatchSize);
        
        const batchParsed = batch.map(row => {
          let matchedStyleNo: string | null = null;
          let matchedColor: string | null = null;
          let styleScore = 0;
          let colorScore = 0;
          let matchNote: string | null = null;
          
          // Try exact match on style_no first
          const exactStyleMatch = styles.find(s => s.style_no.toLowerCase() === row.styleNo.toLowerCase());
          if (exactStyleMatch) {
            matchedStyleNo = exactStyleMatch.style_no;
            styleScore = 1.0;
            matchNote = 'Exact style no match';
          } else {
            // Try fuzzy match on style_name
            let bestMatch: StyleRow | null = null;
            let bestScore = 0;
            
            for (const style of styles) {
              if (!style.style_name) continue;
              const score = fuzzyScore(row.styleName, style.style_name);
              if (score > bestScore && score >= 0.7) {
                bestScore = score;
                bestMatch = style;
              }
            }
            
            if (bestMatch) {
              matchedStyleNo = bestMatch.style_no;
              styleScore = bestScore;
              matchNote = `Fuzzy match (${Math.round(bestScore * 100)}%)`;
            }
          }
          
          // Match color
          if (matchedStyleNo) {
            const colors = colorsByStyleNo.get(matchedStyleNo) || [];
            
            // Try to extract color from styleName or check hardcoded rules
            const hardcodedStyleNo = checkHardcodedRules(row.styleName, row.size);
            if (hardcodedStyleNo && hardcodedStyleNo === matchedStyleNo) {
              if (colors.length > 0 && colors[0]) {
                matchedColor = colors[0];
                colorScore = 1.0;
              }
            } else if (colors.length > 0 && colors[0]) {
              matchedColor = colors[0];
              colorScore = 0.8;
              matchNote = (matchNote || '') + ' (auto-selected first color)';
            }
          }
          
          const status: 'matched' | 'unmatched_style' | 'unmatched_color' =
            !matchedStyleNo ? 'unmatched_style' :
            !matchedColor ? 'unmatched_color' :
            'matched';
          
          return {
            ...row,
            matchedStyleNo,
            matchedColor,
            styleScore,
            colorScore,
            matchNote,
            status,
          };
        });
        
        parsed.push(...batchParsed);
        setParsingProgress({ 
          current: Math.min(i + matchBatchSize, rows.length), 
          total: rows.length, 
          phase: 'Matching styles and colors...' 
        });
        
        // Allow UI to update
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      const matchedCount = parsed.filter(r => r.status === 'matched').length;
      const unmatchedStyleCount = parsed.filter(r => r.status === 'unmatched_style').length;
      const unmatchedColorCount = parsed.filter(r => r.status === 'unmatched_color').length;
      
      console.log('[Historical Sales] Matching complete:', {
        totalRows: parsed.length,
        matched: matchedCount,
        unmatchedStyle: unmatchedStyleCount,
        unmatchedColor: unmatchedColorCount,
        sampleParsedRows: parsed.slice(0, 3),
      });
      
      setParsedRows(parsed);
      setUploadResult({ success: true, message: `Parsed ${parsed.length} rows successfully (${matchedCount} matched, ${unmatchedStyleCount} unmatched style, ${unmatchedColorCount} unmatched color)` });
    } catch (error) {
      console.error('[Historical Sales] Parsing error:', error);
      setUploadResult({ success: false, message: `Parsing failed: ${error}` });
    } finally {
      setParsing(false);
      setParsingProgress({ current: 0, total: 0, phase: '' });
    }
  }, [rawFileData, columnMapping, styles, colorsByStyleNo]);
  
  // Update column mapping
  const updateColumnMapping = useCallback((field: keyof ColumnMapping, value: string | null) => {
    setColumnMapping(prev => prev ? { ...prev, [field]: value } : null);
  }, []);
  
  // Update matched style/color for a row
  const updateRowStyleNo = useCallback((index: number, styleNo: string) => {
    setParsedRows(prev => {
      const updated = [...prev];
      const row = updated[index];
      if (!row) return prev;
      
      row.matchedStyleNo = styleNo || null;
      
      // Reset color when style changes
      row.matchedColor = null;
      row.colorScore = 0;
      
      // Auto-select first color if available
      if (styleNo) {
        const colors = colorsByStyleNo.get(styleNo) || [];
        if (colors.length > 0 && colors[0]) {
          row.matchedColor = colors[0];
          row.colorScore = 0.8;
        }
      }
      
      // Update status
      row.status = !row.matchedStyleNo ? 'unmatched_style' :
                   !row.matchedColor ? 'unmatched_color' :
                   'matched';
      
      return updated;
    });
  }, [colorsByStyleNo]);
  
  const updateRowColor = useCallback((index: number, color: string) => {
    setParsedRows(prev => {
      const updated = [...prev];
      const row = updated[index];
      if (!row) return prev;
      
      row.matchedColor = color || null;
      row.colorScore = color ? 1.0 : 0;
      
      // Update status
      row.status = !row.matchedStyleNo ? 'unmatched_style' :
                   !row.matchedColor ? 'unmatched_color' :
                   'matched';
      
      return updated;
    });
  }, []);
  
  // Add new color to a style
  const openAddColorModal = (rowIndex: number) => {
    const row = parsedRows[rowIndex];
    if (!row || !row.matchedStyleNo) return;
    
    const style = styles?.find(s => s.style_no === row.matchedStyleNo);
    if (!style) return;
    
    setAddColorModal({
      show: true,
      rowIndex,
      styleNo: row.matchedStyleNo,
      styleId: style.id,
      originalColor: row.styleName // Use styleName as color hint
    });
    setNewColorName('');
  };
  
  const saveNewColor = async () => {
    if (!addColorModal || !newColorName.trim()) return;
    
    setSavingColor(true);
    try {
      const { error } = await supabase
        .from('style_colors')
        .insert({
          style_id: addColorModal.styleId,
          color: newColorName.trim()
        });
      
      if (error) throw error;
      
      // Update the row with the new color
      updateRowColor(addColorModal.rowIndex, newColorName.trim());
      
      // Close modal
      setAddColorModal(null);
      setNewColorName('');
      
      // Refresh colors
      // Note: In a real app, you'd want to mutate the SWR cache here
    } catch (error) {
      console.error('[Historical Sales] Error adding color:', error);
      alert('Failed to add color');
    } finally {
      setSavingColor(false);
    }
  };
  
  // Upload matched rows to database
  const uploadMatchedRows = async () => {
    const matchedRows = parsedRows.filter(r => r.status === 'matched');
    if (matchedRows.length === 0) return;
    
    setUploading(true);
    setUploadProgress({ current: 0, total: matchedRows.length });
    
    try {
      const batchSize = 500; // Increased from 50 for better performance
      let uploaded = 0;
      
      for (let i = 0; i < matchedRows.length; i += batchSize) {
        const batch = matchedRows.slice(i, i + batchSize);
        const records = batch.map(row => ({
          style_no: row.matchedStyleNo!,
          color: row.matchedColor!,
          date: row.date,
          size: row.size,
          quantity: row.quantity,
          order_type: row.orderType || null,
          order_channel: row.orderChannel || null,
        }));
        
        const { error } = await supabase
          .from('historical_sales')
          .upsert(records, {
            onConflict: 'style_no,color,date,size',
            ignoreDuplicates: false
          });
        
        if (error) throw error;
        
        uploaded += batch.length;
        setUploadProgress({ current: uploaded, total: matchedRows.length });
        
        // Allow UI to update between batches
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      setUploadResult({
        success: true,
        message: `Successfully uploaded ${matchedRows.length} rows to database`
      });
      
      // Reset after successful upload
      setTimeout(() => {
        setRawFileData(null);
        setColumnMapping(null);
        setParsedRows([]);
      }, 2000);
      
      // Refresh sales data
      mutateSales();
    } catch (error) {
      console.error('[Historical Sales] Upload error:', error);
      setUploadResult({
        success: false,
        message: `Upload failed: ${error}`
      });
    } finally {
      setUploading(false);
    }
  };
  
  // Reset all historical sales data
  const resetHistoricalSales = async () => {
    setResetting(true);
    try {
      const { error } = await supabase
        .from('historical_sales')
        .delete()
        .neq('style_no', '');
      
      if (error) throw error;
      
      setShowResetConfirm(false);
      mutateSales();
      alert('All historical sales data has been deleted');
    } catch (error) {
      console.error('[Historical Sales] Reset error:', error);
      alert('Failed to reset data');
    } finally {
      setResetting(false);
    }
  };
  
  // Filter sales data by search query
  const filteredSalesData = useMemo(() => {
    if (!searchQuery.trim()) return salesData;
    const query = searchQuery.toLowerCase();
    return salesData.filter(row =>
      row.style_no.toLowerCase().includes(query) ||
      row.color.toLowerCase().includes(query) ||
      row.size.toLowerCase().includes(query) ||
      row.date.includes(query) ||
      (row.order_type && row.order_type.toLowerCase().includes(query)) ||
      (row.order_channel && row.order_channel.toLowerCase().includes(query))
    );
  }, [salesData, searchQuery]);
  
  // Tab button component
  const TabButton = ({ id, label }: { id: 'upload' | 'browse' | 'analytics'; label: string }) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
        activeTab === id
          ? 'border-[#8FA894] text-[#8FA894] bg-white'
          : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
      }`}
    >
      {label}
    </button>
  );
  
  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">Sales</div>
          <h1 className="text-2xl font-semibold">Historical Sales Data</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload and analyze historical sales data. One row per size.
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

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-slate-200">
        <TabButton id="upload" label="Upload" />
        <TabButton id="browse" label="Browse" />
        <TabButton id="analytics" label="Analytics" />
      </div>

      {/* Upload Tab */}
      {activeTab === 'upload' && (
        <Card className="border-[#C5D5CA]">
          <CardHeader>
            <CardTitle>Upload Historical Sales (Narrow Format)</CardTitle>
            <CardDescription>
              Upload an Excel file with one row per size. Required columns: <strong>Style No</strong>, <strong>Style Name</strong>, 
              <strong>Size</strong>, <strong>Qty</strong>, <strong>Date</strong>.
              Optional: <strong>Order Type</strong>, <strong>Order Channel</strong>.
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

            {/* Column Mapping UI */}
            {rawFileData && columnMapping && (
              <div className="space-y-4 p-4 bg-slate-50 rounded-lg border">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">Map Columns</h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Found {rawFileData.headers.length} columns, {rawFileData.rows.length} rows. 
                      Open browser console (F12) to see detailed parsing logs.
                    </p>
                  </div>
                  <Button
                    onClick={parseRowsWithMapping}
                    size="sm"
                    disabled={parsing}
                    className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                  >
                    {parsing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Parsing... ({parsingProgress.current}/{parsingProgress.total})
                      </>
                    ) : (
                      'Parse Rows'
                    )}
                  </Button>
                </div>
                
                {/* Parsing Progress Bar */}
                {parsing && parsingProgress.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm text-slate-600">
                      <span>{parsingProgress.phase}</span>
                      <span>{Math.round((parsingProgress.current / parsingProgress.total) * 100)}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                      <div 
                        className="h-full bg-[#8FA894] transition-all duration-300"
                        style={{ width: `${(parsingProgress.current / parsingProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                
                {/* Parse Result - show errors immediately */}
                {uploadResult && !parsedRows.length && (
                  <div className={`p-4 rounded-md text-sm whitespace-pre-wrap font-mono ${
                    uploadResult.success ? 'bg-green-50 text-green-900 border-2 border-green-300' : 'bg-red-50 text-red-900 border-2 border-red-300'
                  }`}>
                    <div className="flex items-start gap-2">
                      {uploadResult.success ? (
                        <CheckCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">{uploadResult.message}</div>
                    </div>
                  </div>
                )}
                
                <div className="grid grid-cols-2 gap-4">
                  {/* Style No */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Style No <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={columnMapping.styleNo || ''}
                      onChange={(e) => updateColumnMapping('styleNo', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Style Name */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Style Name <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={columnMapping.styleName || ''}
                      onChange={(e) => updateColumnMapping('styleName', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Size */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Size <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={columnMapping.size || ''}
                      onChange={(e) => updateColumnMapping('size', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Quantity */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Quantity <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={columnMapping.quantity || ''}
                      onChange={(e) => updateColumnMapping('quantity', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Date */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Date <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={columnMapping.date || ''}
                      onChange={(e) => updateColumnMapping('date', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Order Type (Optional) */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Order Type <span className="text-slate-400">(optional)</span>
                    </label>
                    <select
                      value={columnMapping.orderType || ''}
                      onChange={(e) => updateColumnMapping('orderType', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Order Channel (Optional) */}
                  <div>
                    <label className="text-sm font-medium text-slate-700">
                      Order Channel <span className="text-slate-400">(optional)</span>
                    </label>
                    <select
                      value={columnMapping.orderChannel || ''}
                      onChange={(e) => updateColumnMapping('orderChannel', e.target.value || null)}
                      className="w-full mt-1 text-sm px-3 py-2 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#8FA894]"
                    >
                      <option value="">— Select column —</option>
                      {rawFileData.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Parsed rows table */}
            {parsedRows.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-3 bg-blue-50 rounded-md border border-blue-200">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-green-100 text-green-800">
                      {matchStats.matched} Matched
                    </Badge>
                    {matchStats.unmatchedStyle > 0 && (
                      <Badge className="bg-red-100 text-red-800">
                        {matchStats.unmatchedStyle} No Style
                      </Badge>
                    )}
                    {matchStats.unmatchedColor > 0 && (
                      <Badge className="bg-yellow-100 text-yellow-800">
                        {matchStats.unmatchedColor} No Color
                      </Badge>
                    )}
                  </div>
                  <span className="text-sm text-slate-600">
                    Review and fix any unmatched rows below before uploading
                  </span>
                </div>

                <div className="max-h-96 overflow-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="p-2 text-left border-b font-medium">Status</th>
                        <th className="p-2 text-left border-b font-medium">Style No (File)</th>
                        <th className="p-2 text-left border-b font-medium">Style Name (File)</th>
                        <th className="p-2 text-left border-b font-medium">Matched Style</th>
                        <th className="p-2 text-left border-b font-medium">Matched Color</th>
                        <th className="p-2 text-left border-b font-medium">Size</th>
                        <th className="p-2 text-right border-b font-medium">Qty</th>
                        <th className="p-2 text-left border-b font-medium">Date</th>
                        <th className="p-2 text-left border-b font-medium">Order Type</th>
                        <th className="p-2 text-left border-b font-medium">Order Channel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedRows.map((row, idx) => (
                        <tr key={idx} className={row.status !== 'matched' ? 'bg-red-50' : ''}>
                          <td className="p-2 border-b">
                            {row.status === 'matched' ? (
                              <Badge className="bg-green-100 text-green-800 text-[10px]">Matched</Badge>
                            ) : row.status === 'unmatched_style' ? (
                              <Badge className="bg-red-100 text-red-800 text-[10px]">No Style</Badge>
                            ) : (
                              <Badge className="bg-yellow-100 text-yellow-800 text-[10px]">No Color</Badge>
                            )}
                          </td>
                          <td className="p-2 border-b font-mono text-[10px]">{row.styleNo || '—'}</td>
                          <td className="p-2 border-b text-[10px] max-w-[120px] truncate" title={row.styleName}>{row.styleName || '—'}</td>
                          <td className="p-2 border-b">
                            <select
                              value={row.matchedStyleNo || ''}
                              onChange={(e) => updateRowStyleNo(idx, e.target.value)}
                              className={`w-full text-xs px-1.5 py-1 rounded border font-mono ${
                                row.matchedStyleNo 
                                  ? 'border-green-300 bg-green-50' 
                                  : 'border-red-300 bg-red-50'
                              } focus:outline-none focus:ring-1 focus:ring-[#8FA894]`}
                            >
                              <option value="">— Select style —</option>
                              {(styles || []).map(s => (
                                <option key={s.id} value={s.style_no}>
                                  {s.style_no}{s.style_name ? ` - ${s.style_name}` : ''}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2 border-b">
                            {row.matchedStyleNo ? (
                              <div className="flex items-center gap-1">
                                <select
                                  value={row.matchedColor || ''}
                                  onChange={(e) => updateRowColor(idx, e.target.value)}
                                  className={`flex-1 text-xs px-1.5 py-1 rounded border ${
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
                                <button
                                  onClick={() => openAddColorModal(idx)}
                                  className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-[#8FA894]"
                                  title="Add new color to this style"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="p-2 border-b font-mono text-xs">{row.size}</td>
                          <td className="p-2 border-b text-right font-mono">{row.quantity}</td>
                          <td className="p-2 border-b text-slate-600 text-[10px]">{row.date || '—'}</td>
                          <td className="p-2 border-b text-[10px]">{row.orderType || '—'}</td>
                          <td className="p-2 border-b text-[10px]">{row.orderChannel || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-500">Showing all {parsedRows.length} rows</p>

                {/* Upload button and progress */}
                <div className="space-y-3">
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
                  
                  {/* Upload Progress Bar */}
                  {uploading && uploadProgress.total > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm text-slate-600">
                        <span>Uploading to database...</span>
                        <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                        <div 
                          className="h-full bg-[#8FA894] transition-all duration-300"
                          style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                        />
                      </div>
                    </div>
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
      )}

      {/* Add Color Modal */}
      {addColorModal?.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Add New Color</h3>
              <button 
                onClick={() => setAddColorModal(null)}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Add a new color to style <strong>{addColorModal.styleNo}</strong>
            </p>
            <Input
              value={newColorName}
              onChange={(e) => setNewColorName(e.target.value)}
              placeholder="Enter color name"
              className="mb-4"
            />
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => setAddColorModal(null)}
              >
                Cancel
              </Button>
              <Button
                onClick={saveNewColor}
                disabled={savingColor || !newColorName.trim()}
                className="bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                {savingColor ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add Color'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Browse Tab */}
      {activeTab === 'browse' && (
        <Card>
          <CardHeader>
            <CardTitle>Browse Historical Sales</CardTitle>
            <CardDescription>
              View and search uploaded historical sales data
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-slate-400" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by style, color, size, date, order type, or channel..."
                className="flex-1"
              />
            </div>

            <div className="max-h-[600px] overflow-auto border rounded-lg">
              <Table>
                <TableHeader className="bg-slate-50 sticky top-0">
                  <TableRow>
                    <TableHead>Style No</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Order Type</TableHead>
                    <TableHead>Order Channel</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSalesData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-slate-500">
                        No data found
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredSalesData.map((row, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs">{row.style_no}</TableCell>
                        <TableCell>{row.color}</TableCell>
                        <TableCell className="font-mono">{row.size}</TableCell>
                        <TableCell className="text-right font-mono">{row.quantity}</TableCell>
                        <TableCell className="text-slate-600 text-xs">{row.date}</TableCell>
                        <TableCell className="text-xs">{row.order_type || '—'}</TableCell>
                        <TableCell className="text-xs">{row.order_channel || '—'}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="text-xs text-slate-600 flex items-center gap-2">
              <span>Rows shown: {filteredSalesData.length}</span>
              {salesCount !== null && <span className="text-slate-500">| Total: {salesCount}</span>}
              <span className="text-slate-500">Limit 500 per query</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Analytics Tab */}
      {activeTab === 'analytics' && (
        <Card>
          <CardHeader>
            <CardTitle>Analytics</CardTitle>
            <CardDescription>
              View trends and insights from historical sales data
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600">Analytics coming soon...</p>
          </CardContent>
        </Card>
      )}

      {/* Format Guide - Always visible at bottom */}
      <Card>
        <CardHeader>
          <CardTitle>Upload Guide</CardTitle>
          <CardDescription>
            Historical sales data is used to calculate size ratios and weekly rates for NOOS purchase orders.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="p-3 bg-[#8FA894]/10 rounded-lg border border-[#8FA894]/30">
            <strong className="text-[#4A6B52]">New Format: One Row Per Size</strong>
            <p className="text-slate-600 mt-1">
              The historical sales import now uses a narrow format where each size has its own row.
              This provides more flexibility and allows tracking of order type and channel.
            </p>
          </div>

          <div>
            <strong>File Format (.xlsx, .xls, .csv):</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li><strong>Style No</strong> - Direct style number (required)</li>
              <li><strong>Style Name</strong> - Style name for matching (required)</li>
              <li><strong>Size</strong> - Size value (34, 36, 38, S, M, L, etc.) (required)</li>
              <li><strong>Qty</strong> - Quantity sold (required)</li>
              <li><strong>Date</strong> - Single date (not date range) (required)</li>
              <li><strong>Order Type</strong> - Type of order (optional)</li>
              <li><strong>Order Channel</strong> - Sales channel (optional)</li>
            </ul>
          </div>
          
          <div>
            <strong>Date Format:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li>Supported formats: DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY, Excel serial numbers</li>
              <li>Example: <code className="bg-slate-100 px-1 rounded">15-01-2025</code></li>
            </ul>
          </div>

          <div>
            <strong>Example (Narrow Format):</strong>
            <div className="mt-2 overflow-x-auto">
              <table className="text-xs border">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-2 border">Style No</th>
                    <th className="p-2 border">Style Name</th>
                    <th className="p-2 border">Size</th>
                    <th className="p-2 border">Qty</th>
                    <th className="p-2 border">Date</th>
                    <th className="p-2 border">Order Type</th>
                    <th className="p-2 border">Order Channel</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border">1234567-N</td>
                    <td className="p-2 border">SUMMER BLAZER</td>
                    <td className="p-2 border">34</td>
                    <td className="p-2 border">5</td>
                    <td className="p-2 border">15-01-2025</td>
                    <td className="p-2 border">Retail</td>
                    <td className="p-2 border">Online</td>
                  </tr>
                  <tr>
                    <td className="p-2 border">1234567-N</td>
                    <td className="p-2 border">SUMMER BLAZER</td>
                    <td className="p-2 border">36</td>
                    <td className="p-2 border">8</td>
                    <td className="p-2 border">15-01-2025</td>
                    <td className="p-2 border">Retail</td>
                    <td className="p-2 border">Online</td>
                  </tr>
                  <tr>
                    <td className="p-2 border">1234567-N</td>
                    <td className="p-2 border">SUMMER BLAZER</td>
                    <td className="p-2 border">38</td>
                    <td className="p-2 border">12</td>
                    <td className="p-2 border">15-01-2025</td>
                    <td className="p-2 border">Wholesale</td>
                    <td className="p-2 border">Store</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <strong>After Upload:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li>Data appears in the <strong>Browse</strong> tab for verification</li>
              <li>Charts and analytics are available in the <strong>Analytics</strong> tab</li>
              <li>NOOS Call-Off and Quick PO tools will use this data for size distribution suggestions</li>
              <li>Re-uploading the same style/color/date/size combination updates existing records</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
