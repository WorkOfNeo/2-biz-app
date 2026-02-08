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
function parseDate(dateStr: string | number): string | null {
  if (!dateStr && dateStr !== 0) return null;
  
  const str = String(dateStr).trim();
  
  // Excel serial number (days since 1900-01-01) - can have decimals for time
  // Check if it's a number (could be 5-6 digits, with or without decimals)
  if (/^\d+\.?\d*$/.test(str)) {
    const serial = parseFloat(str);
    // Excel serial numbers for dates are typically in range 1 (1900-01-01) to 60000+ (2164+)
    // Only treat as serial if it's a reasonable date number
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
  
  // Step 2: Send raw data to backend for processing
  const parseRowsWithMapping = useCallback(async () => {
    if (!rawFileData || !columnMapping) return;
    
    const { styleNo, styleName, size, quantity, date, orderType, orderChannel } = columnMapping;
    
    // Validate required columns
    if (!styleNo || !styleName || !size || !quantity || !date) {
      setUploadResult({
        success: false,
        message: 'Please map all required columns: Style No, Style Name, Size, Quantity, and Date'
      });
      return;
    }
    
    console.log('[Historical Sales] Sending raw data to backend:', { 
      totalRows: rawFileData.rows.length,
      columnMapping 
    });
    
    setParsing(true);
    setParsingProgress({ current: 0, total: rawFileData.rows.length, phase: 'Uploading in chunks...' });
    
    try {
      // Send data in chunks to avoid 413 Content Too Large errors
      const CHUNK_SIZE = 1000; // 1k rows per chunk (safer for large payloads)
      const totalRows = rawFileData.rows.length;
      const totalChunks = Math.ceil(totalRows / CHUNK_SIZE);
      
      let totalInserted = 0;
      let combinedStats = {
        total: 0,
        parsed: 0,
        matched: 0,
        unmatchedStyle: 0,
        unmatchedColor: 0,
        filteredInvalid: 0,
      };
      
      console.log(`[Historical Sales] Uploading ${totalRows} rows in ${totalChunks} chunks of ${CHUNK_SIZE} rows each`);
      
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalRows);
        const chunk = rawFileData.rows.slice(start, end);
        
        setParsingProgress({ 
          current: end, 
          total: totalRows, 
          phase: `Processing chunk ${chunkIndex + 1}/${totalChunks}...` 
        });
        
        console.log(`[Historical Sales] Uploading chunk ${chunkIndex + 1}/${totalChunks} (rows ${start}-${end})`);
        
        const response = await fetch('/api/historical-sales/upload-raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: chunk,
            columnMapping: {
              styleNo,
              styleName,
              size,
              quantity,
              date,
              orderType,
              orderChannel,
            },
          }),
        });
        
        const result = await response.json();
        
        if (!response.ok) {
          if (result.sampleValidation) {
            console.error('[Historical Sales] Sample validation failed:', result.sampleValidation);
            throw new Error(result.message || 'Sample validation failed');
          }
          throw new Error(result.error || `Chunk ${chunkIndex + 1} failed`);
        }
        
        console.log(`[Historical Sales] Chunk ${chunkIndex + 1}/${totalChunks} complete:`, result);
        
        // Accumulate stats
        totalInserted += result.inserted || 0;
        combinedStats.total += result.stats.total || 0;
        combinedStats.parsed += result.stats.parsed || 0;
        combinedStats.matched += result.stats.matched || 0;
        combinedStats.unmatchedStyle += result.stats.unmatchedStyle || 0;
        combinedStats.unmatchedColor += result.stats.unmatchedColor || 0;
        combinedStats.filteredInvalid += result.stats.filteredInvalid || 0;
      }
      
      console.log('[Historical Sales] All chunks complete:', { totalInserted, combinedStats });
      
      // Show success message
      const successMsg = [
        `✅ Successfully processed and uploaded!`,
        `  • Total rows in file: ${combinedStats.total.toLocaleString()}`,
        `  • Parsed valid rows: ${combinedStats.parsed.toLocaleString()}`,
        `  • Matched and inserted: ${totalInserted.toLocaleString()}`,
        combinedStats.unmatchedStyle > 0 ? `  • Unmatched styles: ${combinedStats.unmatchedStyle.toLocaleString()}` : '',
        combinedStats.unmatchedColor > 0 ? `  • Unmatched colors: ${combinedStats.unmatchedColor.toLocaleString()}` : '',
        combinedStats.filteredInvalid > 0 ? `  • Invalid/filtered: ${combinedStats.filteredInvalid.toLocaleString()}` : '',
      ].filter(Boolean).join('\n');
      
      setUploadResult({ success: true, message: successMsg });
      setParsedRows([]);
      
      // Reset after successful upload
      setTimeout(() => {
        setRawFileData(null);
        setColumnMapping(null);
        setParsedRows([]);
        setUploadResult(null);
      }, 5000);
      
      // Refresh sales data
      mutateSales();
    } catch (error) {
      console.error('[Historical Sales] Backend processing error:', error);
      setUploadResult({ 
        success: false, 
        message: `Processing failed: ${error instanceof Error ? error.message : String(error)}\n\nCheck Railway logs for details.` 
      });
    } finally {
      setParsing(false);
      setParsingProgress({ current: 0, total: 0, phase: '' });
    }
  }, [rawFileData, columnMapping, mutateSales]);
  
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
  
  // No longer needed - backend handles everything directly
  
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
                        Processing on backend...
                      </>
                    ) : (
                      'Upload & Process'
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

            {/* No longer showing parsed rows - backend handles everything directly */}

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
