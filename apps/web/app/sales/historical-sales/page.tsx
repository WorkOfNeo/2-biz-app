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
import { AlertCircle, CheckCircle, Loader2, Download, TrendingUp, Calendar, BarChart3, Search, Plus, X } from 'lucide-react';
import { DailyLineChart, StackedAreaByColor, SizeDistributionBar } from '../../../components/charts';

// Types
type SalesRow = {
  style_no: string;
  color: string;
  date: string;
  size: string;
  quantity: number;
};

type WideRow = {
  styleNo: string;      // Direct style number from "Style No" column
  styleName: string;    // Style name from "Style Name" column (for fallback matching)
  color: string;
  dateRange: string;
  sizes: Record<string, number>;
};

type ParsedWideRow = WideRow & {
  matchedStyleNo: string | null;
  matchedColor: string | null;
  styleScore: number;
  colorScore: number;
  matchNote: string | null;  // Explains how the match was made (e.g., "via alternative style")
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

// Tab type for the UI
type TabId = 'upload' | 'browse' | 'analytics';

export default function HistoricalSalesPage() {
  const supabase = createClientComponentClient();
  
  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>('upload');
  
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

  // Batch update modal state
  const [batchUpdateModal, setBatchUpdateModal] = useState<{
    show: boolean;
    rowIndex: number;
    newStyleNo: string;
    similarRowIndexes: number[];
  } | null>(null);

  // Add color modal state
  const [addColorModal, setAddColorModal] = useState<{
    show: boolean;
    rowIndex: number;
    styleNo: string;
    styleId: string;
    originalColor: string;
  } | null>(null);
  const [newColorName, setNewColorName] = useState('');
  const [addingColor, setAddingColor] = useState(false);

  // Fetch styles for matching
  const { data: styles } = useSWR('historical-sales:styles', async () => {
    const { data } = await supabase
      .from('styles')
      .select('id, style_no, style_name')
      .order('style_no');
    return (data ?? []) as StyleRow[];
  });

  // Fetch style colors for matching
  const { data: styleColors, mutate: mutateStyleColors } = useSWR('historical-sales:style-colors', async () => {
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
      
      const nowMatched = newColor !== '';
      
      return {
        ...row,
        matchedColor: newColor || null,
        colorScore: newColor ? 1.0 : 0, // Manual selection = perfect match
        matchNote: newColor ? 'Manually selected' : null,
        status: !row.matchedStyleNo ? 'unmatched_style' : 
                nowMatched ? 'matched' : 'unmatched_color'
      };
    }));
  }

  // Function to update a row's matched style number
  function updateRowStyleNo(rowIndex: number, newStyleNo: string) {
    const currentRow = parsedRows[rowIndex];
    if (!currentRow) return;

    // Find similar rows (same original styleName/styleNo AND same color input)
    const similarIndexes = parsedRows
      .map((row, idx) => {
        if (idx === rowIndex) return -1;
        const sameStyle = (row.styleName === currentRow.styleName && row.styleName) ||
                         (row.styleNo === currentRow.styleNo && row.styleNo);
        const sameColor = row.color.toLowerCase() === currentRow.color.toLowerCase();
        return sameStyle && sameColor ? idx : -1;
      })
      .filter(idx => idx !== -1);

    if (similarIndexes.length > 0) {
      // Show modal to ask about batch update
      setBatchUpdateModal({
        show: true,
        rowIndex,
        newStyleNo,
        similarRowIndexes: similarIndexes
      });
    } else {
      // No similar rows, just update this one
      applyStyleChange(rowIndex, newStyleNo);
    }
  }

  // Apply style change to a single row
  function applyStyleChange(rowIndex: number, newStyleNo: string) {
    setParsedRows(prev => prev.map((row, idx) => {
      if (idx !== rowIndex) return row;
      
      // Get available colors for the new style
      const availableColors = colorsByStyleNo.get(newStyleNo) || [];
      
      // Try to match the original color to the new style's colors
      let matchedColor: string | null = null;
      let colorScore = 0;
      
      // Try exact match first
      const exactMatch = availableColors.find(c => c.toLowerCase() === row.color.toLowerCase());
      if (exactMatch) {
        matchedColor = exactMatch;
        colorScore = 1.0;
      } else if (availableColors.length > 0) {
        // Try fuzzy match
        const fuzzyResult = bestColorMatch(row.color, availableColors);
        if (fuzzyResult.match && fuzzyResult.score >= 0.5) {
          matchedColor = fuzzyResult.match;
          colorScore = fuzzyResult.score;
        }
      }
      
      return {
        ...row,
        matchedStyleNo: newStyleNo || null,
        matchedColor,
        styleScore: 1.0, // Manual selection
        colorScore,
        matchNote: 'Style manually selected',
        status: !newStyleNo ? 'unmatched_style' : 
                !matchedColor ? 'unmatched_color' : 'matched'
      };
    }));
  }

  // Confirm batch style update
  function confirmBatchStyleUpdate(updateAll: boolean) {
    if (!batchUpdateModal) return;
    
    const { rowIndex, newStyleNo, similarRowIndexes } = batchUpdateModal;
    
    // Always update the main row
    applyStyleChange(rowIndex, newStyleNo);
    
    // If user said yes, update all similar rows
    if (updateAll) {
      for (const idx of similarRowIndexes) {
        applyStyleChange(idx, newStyleNo);
      }
    }
    
    setBatchUpdateModal(null);
  }

  // Add a new color to a style
  async function addNewColorToStyle() {
    if (!addColorModal || !newColorName.trim()) return;
    
    const { styleId, styleNo, rowIndex } = addColorModal;
    const finalColorName = newColorName.trim();
    
    setAddingColor(true);
    
    try {
      // Use API route to add color (bypasses RLS)
      const response = await fetch('/api/historical-sales/add-color', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style_id: styleId,
          color: finalColorName
        })
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        setUploadResult({ success: false, message: `Failed to add color: ${result.error}` });
        return;
      }
      
      // Refresh style colors
      await mutateStyleColors();
      
      // Update the row with the new color
      setParsedRows(prev => prev.map((row, idx) => {
        if (idx !== rowIndex) return row;
        return {
          ...row,
          matchedColor: finalColorName,
          colorScore: 1.0,
          matchNote: `New color added`,
          status: 'matched'
        };
      }));
      
      setUploadResult({ success: true, message: `Added color "${finalColorName}" to style ${styleNo}` });
      setAddColorModal(null);
      setNewColorName('');
    } catch (err: any) {
      setUploadResult({ success: false, message: `Failed to add color: ${err.message}` });
    } finally {
      setAddingColor(false);
    }
  }

  // Open add color modal
  function openAddColorModal(rowIndex: number) {
    const row = parsedRows[rowIndex];
    if (!row || !row.matchedStyleNo) return;
    
    const style = styles?.find(s => s.style_no === row.matchedStyleNo);
    if (!style) return;
    
    setAddColorModal({
      show: true,
      rowIndex,
      styleNo: row.matchedStyleNo,
      styleId: style.id,
      originalColor: row.color
    });
    setNewColorName(row.color); // Pre-fill with the original color name
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
        
        // Detect column mappings - look for style columns
        // "Style No" = direct style number lookup
        // "Style Name" = style name for fallback/alternative matching
        // If only one "Style" column exists, we'll try it as both
        let styleNoCol = headers.find(h => /^style[\s_-]?no\.?$|^style[\s_-]?number$/i.test(h));
        let styleNameCol = headers.find(h => /^style[\s_-]?name$/i.test(h));
        
        // If neither specific column found, look for any "style" column
        if (!styleNoCol && !styleNameCol) {
          const styleCol = headers.find(h => /style/i.test(h));
          if (styleCol) {
            // We'll use this column as a "style identifier" - could be either no or name
            styleNameCol = styleCol; // Use as style name for flexible matching
          }
        }
        
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
        
        if ((!styleNoCol && !styleNameCol) || !colorCol) {
          setUploadResult({ 
            success: false, 
            message: `Could not detect required columns. Found: ${headers.join(', ')}. Need: Style No (or Style Name), Color, and size columns (34, 36, etc.)` 
          });
          return;
        }
        
        setDetectedSizes(sizeCols);
        
        console.log('[Historical Sales] Column detection:', { styleNoCol, styleNameCol, colorCol, dateCol, sizeCols, headers });
        
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
          
          // Get the raw style identifier - could be a number or a name
          const styleNoValue = styleNoCol ? String(row[styleNoCol] ?? '').trim() : '';
          const styleNameValue = styleNameCol ? String(row[styleNameCol] ?? '').trim() : '';
          
          return {
            styleNo: styleNoValue,
            styleName: styleNameValue,
            color: String(row[colorCol!] ?? '').trim(),
            dateRange: dateCol ? String(row[dateCol] ?? '').trim() : '',
            sizes
          };
        }).filter(r => (r.styleNo || r.styleName) && r.color && Object.keys(r.sizes).length > 0);
        
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
    // Build lookup maps
    const styleNoMap = new Map<string, StyleRow>();  // style_no (lowercase) -> StyleRow
    const stylesByName = new Map<string, StyleRow[]>(); // style_name (lowercase) -> StyleRow[]
    
    allStyles.forEach(s => {
      styleNoMap.set(s.style_no.toLowerCase(), s);
      if (s.style_name) {
        const nameLower = s.style_name.toLowerCase();
        const existing = stylesByName.get(nameLower) || [];
        existing.push(s);
        stylesByName.set(nameLower, existing);
      }
    });
    
    // Build color lookup: style_id -> colors[]
    const colorsByStyleId = new Map<string, string[]>();
    allColors.forEach(c => {
      const existing = colorsByStyleId.get(c.style_id) || [];
      existing.push(c.color);
      colorsByStyleId.set(c.style_id, existing);
    });
    
    // Helper to get colors for a style
    const getColorsForStyle = (style: StyleRow): string[] => {
      return colorsByStyleId.get(style.id) || [];
    };
    
    // Helper to try matching a color against a style's available colors
    const tryMatchColor = (inputColor: string, availableColors: string[]): { match: string | null; score: number } => {
      if (availableColors.length === 0) return { match: null, score: 0 };
      
      // Try exact match first
      const exactColor = availableColors.find(c => c.toLowerCase() === inputColor.toLowerCase());
      if (exactColor) return { match: exactColor, score: 1.0 };
      
      // Try fuzzy match
      return bestColorMatch(inputColor, availableColors);
    };
    
    // Helper to try matching a style identifier (could be style_no or style_name)
    const tryFindStyle = (identifier: string): StyleRow | null => {
      if (!identifier) return null;
      const lower = identifier.toLowerCase();
      
      // Try as style_no first (exact)
      const byNo = styleNoMap.get(lower);
      if (byNo) return byNo;
      
      // Try as style_name (exact)
      const byName = stylesByName.get(lower);
      if (byName && byName.length > 0) return byName[0]!;
      
      return null;
    };
    
    const parsed: ParsedWideRow[] = rows.map(row => {
      let matchedStyleNo: string | null = null;
      let matchedColor: string | null = null;
      let styleScore = 0;
      let colorScore = 0;
      let matchNote: string | null = null;
      
      // STEP 0: Check HARD-CODED RULES first (highest priority)
      const styleIdentifier = row.styleName || row.styleNo;
      const hardcodedStyleNo = checkHardcodedRules(styleIdentifier, row.color);
      
      if (hardcodedStyleNo) {
        // Found a hard-coded rule! Try to find this style and its color
        const hardcodedStyle = styleNoMap.get(hardcodedStyleNo.toLowerCase());
        if (hardcodedStyle) {
          matchedStyleNo = hardcodedStyle.style_no;
          styleScore = 1.0;
          matchNote = `Rule: -> ${hardcodedStyleNo}`;
          
          // Try to match color for this style
          const colors = getColorsForStyle(hardcodedStyle);
          const colorResult = tryMatchColor(row.color, colors);
          if (colorResult.match && colorResult.score >= 0.5) {
            matchedColor = colorResult.match;
            colorScore = colorResult.score;
          }
        } else {
          // Hard-coded style_no not found in database - DON'T use it, let normal matching try
          matchNote = `Rule ${hardcodedStyleNo} NOT IN DB!`;
          console.warn(`[Historical Sales] Hard-coded rule style_no "${hardcodedStyleNo}" not found in database!`);
          // Don't set matchedStyleNo - let it fall through to normal matching
        }
      }
      
      // If hard-coded rule didn't fully match, continue with normal matching
      if (!matchedStyleNo || !matchedColor) {
        // Combine styleNo and styleName for matching - try both as identifiers
        const identifiersToTry = [row.styleNo, row.styleName].filter(Boolean);
        
        // STEP 1: Try direct matching with any identifier
        if (!matchedStyleNo) {
          for (const identifier of identifiersToTry) {
            const directMatch = tryFindStyle(identifier);
            if (directMatch) {
              matchedStyleNo = directMatch.style_no;
              styleScore = 1.0;
              
              // Try to match color for this style
              const colors = getColorsForStyle(directMatch);
              const colorResult = tryMatchColor(row.color, colors);
              if (colorResult.match && colorResult.score >= 0.5) {
                matchedColor = colorResult.match;
                colorScore = colorResult.score;
                break; // Found a complete match!
              }
            }
          }
        }
      }
      
      // STEP 2: If we matched a style but not the color, search ALL styles with the same name for the color
      if (matchedStyleNo && !matchedColor) {
        const styleName = row.styleName || row.styleNo;
        if (styleName) {
          const nameLower = styleName.toLowerCase();
          
          // Get all styles that might match this name
          const alternativeStyles = stylesByName.get(nameLower) || [];
          
          // Also check styles where style_no matches the input (different products with same number)
          const byNoStyles = allStyles.filter(s => 
            s.style_no.toLowerCase() === nameLower || 
            (s.style_name && s.style_name.toLowerCase() === nameLower)
          );
          
          const allAlternatives = [...new Map([...alternativeStyles, ...byNoStyles].map(s => [s.id, s])).values()];
          
          // Check each alternative style for the color
          for (const altStyle of allAlternatives) {
            if (altStyle.style_no === matchedStyleNo) continue; // Skip the one we already tried
            
            const colors = getColorsForStyle(altStyle);
            const colorResult = tryMatchColor(row.color, colors);
            
            if (colorResult.match && colorResult.score >= 0.5) {
              // Found the color on an alternative style!
              matchedStyleNo = altStyle.style_no;
              matchedColor = colorResult.match;
              colorScore = colorResult.score;
              matchNote = `Color found on ${altStyle.style_no}`;
              break;
            }
          }
        }
      }
      
      // STEP 3: If still no style match, try fuzzy matching
      if (!matchedStyleNo) {
        const searchTerm = row.styleName || row.styleNo;
        if (searchTerm && allStyles.length > 0) {
          // Try fuzzy match on style_name
          const styleNames = allStyles.filter(s => s.style_name).map(s => s.style_name!);
          const { match: fuzzyName, score } = bestMatch(searchTerm, styleNames);
          
          if (fuzzyName && score >= 0.6) {
            const matchedStyle = allStyles.find(s => s.style_name === fuzzyName);
            if (matchedStyle) {
              matchedStyleNo = matchedStyle.style_no;
              styleScore = score;
              
              // Try color match
              const colors = getColorsForStyle(matchedStyle);
              const colorResult = tryMatchColor(row.color, colors);
              if (colorResult.match && colorResult.score >= 0.5) {
                matchedColor = colorResult.match;
                colorScore = colorResult.score;
              }
              matchNote = `Fuzzy: "${fuzzyName}" (${Math.round(score * 100)}%)`;
            }
          }
          
          // Also try fuzzy match on style_no
          if (!matchedStyleNo) {
            const styleNos = allStyles.map(s => s.style_no);
            const { match: fuzzyNo, score: noScore } = bestMatch(searchTerm, styleNos);
            
            if (fuzzyNo && noScore >= 0.7) {
              const matchedStyle = allStyles.find(s => s.style_no === fuzzyNo);
              if (matchedStyle) {
                matchedStyleNo = matchedStyle.style_no;
                styleScore = noScore;
                
                // Try color match
                const colors = getColorsForStyle(matchedStyle);
                const colorResult = tryMatchColor(row.color, colors);
                if (colorResult.match && colorResult.score >= 0.5) {
                  matchedColor = colorResult.match;
                  colorScore = colorResult.score;
                }
                matchNote = `Fuzzy style no (${Math.round(noScore * 100)}%)`;
              }
            }
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
        matchNote,
        status
      };
    });
    
    console.log('[Historical Sales] Matching complete:', {
      total: parsed.length,
      matched: parsed.filter(r => r.status === 'matched').length,
      unmatchedStyle: parsed.filter(r => r.status === 'unmatched_style').length,
      unmatchedColor: parsed.filter(r => r.status === 'unmatched_color').length,
      sampleRows: parsed.slice(0, 3).map(r => ({
        styleNo: r.styleNo,
        styleName: r.styleName,
        color: r.color,
        matchedStyleNo: r.matchedStyleNo,
        matchedColor: r.matchedColor,
        status: r.status,
        note: r.matchNote
      }))
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
        
        console.log('[Historical Sales Upload] Batch response:', response.status, result);
        
        if (response.ok) {
          successCount += result.successCount || batch.length;
          errorCount += result.errorCount || 0;
          if (result.errors) {
            errors.push(...result.errors.slice(0, 10));
          }
        } else {
          errorCount += batch.length;
          // Include more details in the error
          const errorDetails = result.errors?.slice(0, 5).join('; ') || result.error || 'Batch upload failed';
          errors.push(`Batch failed (${response.status}): ${errorDetails}`);
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
          success: successCount > 0, 
          message: `Uploaded ${successCount} records, ${errorCount} errors.\n\nErrors:\n${errors.slice(0, 10).join('\n')}` 
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

  // Export to CSV
  function exportToCSV() {
    if (salesData.length === 0) return;
    
    const headers = ['Style', 'Color', 'Date', 'Size', 'Quantity'];
    const csvRows = [
      headers.join(','),
      ...salesData.map(row => [
        `"${row.style_no}"`,
        `"${row.color}"`,
        row.date,
        `"${row.size}"`,
        row.quantity
      ].join(','))
    ];
    
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `historical-sales-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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

  // Tab button component
  const TabButton = ({ id, label }: { id: TabId; label: string }) => (
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
            Upload and analyze historical sales data. Monthly totals are automatically expanded into daily rows.
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
            <CardTitle>Upload Historical Sales (Wide Format)</CardTitle>
            <CardDescription>
              Upload an Excel file with columns: <strong>Style Name</strong>, <strong>Color</strong>, 
              size columns (<strong>34, 36, 38, 40, 42, 44, 46</strong>), and optional <strong>Date to-from</strong>.
              <br />
              <span className="text-amber-600 font-medium">
                Monthly totals (e.g., 01-01-2025 - 31-01-2025) are automatically split into daily rows.
              </span>
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

                {/* Preview table - scrollable, shows all rows */}
                <div className="max-h-[500px] overflow-auto border rounded bg-white">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="p-2 text-left border-b">Status</th>
                        <th className="p-2 text-left border-b">Style No</th>
                        <th className="p-2 text-left border-b">Style Name</th>
                        <th className="p-2 text-left border-b">Matched Style</th>
                        <th className="p-2 text-left border-b">Color Input</th>
                        <th className="p-2 text-left border-b">Matched Color <span className="font-normal text-slate-400">(editable)</span></th>
                        <th className="p-2 text-left border-b">Date Range</th>
                        <th className="p-2 text-right border-b">Qty</th>
                        <th className="p-2 text-left border-b">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedRows.map((row, idx) => (
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
                            {row.styleScore < 1 && row.styleScore >= 0.7 && (
                              <span className="text-[10px] text-slate-400 ml-1">({Math.round(row.styleScore * 100)}%)</span>
                            )}
                          </td>
                          <td className="p-2 border-b">{row.color}</td>
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
                            {row.colorScore < 1 && row.colorScore >= 0.5 && row.matchedColor && (
                              <span className="text-[10px] text-slate-400 ml-1">auto</span>
                            )}
                          </td>
                          <td className="p-2 border-b text-slate-600 text-[10px]">{row.dateRange || '—'}</td>
                          <td className="p-2 border-b text-right font-mono">
                            {Object.values(row.sizes).reduce((a, b) => a + b, 0)}
                          </td>
                          <td className="p-2 border-b text-[10px] text-slate-500 max-w-[150px]">
                            {row.matchNote || (row.colorScore < 1 && row.colorScore >= 0.5 ? 'Fuzzy color match' : '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-500">Showing all {parsedRows.length} rows</p>

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
      )}

      {/* Batch Style Update Modal */}
      {batchUpdateModal?.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Update Similar Rows?</h3>
              <button 
                onClick={() => setBatchUpdateModal(null)}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Found <strong>{batchUpdateModal.similarRowIndexes.length}</strong> more rows with the same 
              style/color combination. Do you want to update them all to use <strong>{batchUpdateModal.newStyleNo}</strong>?
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => confirmBatchStyleUpdate(false)}
              >
                No, just this one
              </Button>
              <Button
                onClick={() => confirmBatchStyleUpdate(true)}
                className="bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                Yes, update all {batchUpdateModal.similarRowIndexes.length + 1}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Color Modal */}
      {addColorModal?.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Add New Color</h3>
              <button 
                onClick={() => { setAddColorModal(null); setNewColorName(''); }}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Add a new color to style <strong>{addColorModal.styleNo}</strong>.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-700">Original color from file</label>
                <div className="text-sm text-slate-500 bg-slate-50 px-3 py-2 rounded border">
                  {addColorModal.originalColor}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-700">New color name</label>
                <Input
                  value={newColorName}
                  onChange={(e) => setNewColorName(e.target.value)}
                  placeholder="e.g., Black, Navy Blue"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-4">
              <Button
                variant="outline"
                onClick={() => { setAddColorModal(null); setNewColorName(''); }}
              >
                Cancel
              </Button>
              <Button
                onClick={addNewColorToStyle}
                disabled={!newColorName.trim() || addingColor}
                className="bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                {addingColor ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Color
                  </>
                )}
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
                <div className="flex gap-2">
                  <Button onClick={fetchSalesData} disabled={salesLoading || parsedStyleNos.length === 0}>
                    {salesLoading ? 'Loading...' : 'Fetch Sales'}
                  </Button>
                  {salesData.length > 0 && (
                    <Button variant="outline" onClick={exportToCSV}>
                      <Download className="h-4 w-4 mr-2" />
                      Export CSV
                    </Button>
                  )}
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
                        {salesLoading ? 'Loading sales...' : 'No data yet'}
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
      )}

      {/* Analytics Tab */}
      {activeTab === 'analytics' && (
        <AnalyticsTab styles={styles || []} />
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
            <strong className="text-[#4A6B52]">Why daily storage matters:</strong>
            <p className="text-slate-600 mt-1">
              Data is stored per day so we can calculate accurate weekly sales rates and size distributions. 
              When you upload a month of data, it gets split evenly across days. This enables:
            </p>
            <ul className="list-disc list-inside mt-2 text-slate-600">
              <li>Accurate weekly rate calculations for NOOS call-off suggestions</li>
              <li>Historical size pressure analysis for purchase orders</li>
              <li>Trend analysis in the Analytics tab</li>
            </ul>
          </div>

          <div>
            <strong>File Format (.xlsx, .xls, .csv):</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li><strong>Style Name</strong> or <strong>Style No</strong> - Fuzzy-matched to system styles</li>
              <li><strong>Color</strong> - Fuzzy-matched to the style's available colors</li>
              <li><strong>Size columns</strong> - Use numeric headers (34, 36, 38, 40, 42, 44, 46) or letter sizes (S, M, L, XL)</li>
              <li><strong>Date to-from</strong> (optional) - Single date or date range</li>
            </ul>
          </div>
          
          <div>
            <strong>Date Handling:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li>Single date: <code className="bg-slate-100 px-1 rounded">15-01-2025</code> creates 1 row per size</li>
              <li>Date range: <code className="bg-slate-100 px-1 rounded">01-01-2025 - 31-01-2025</code> creates 31 rows per size (quantity split evenly)</li>
              <li>Supported formats: DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY, Excel serial numbers</li>
            </ul>
          </div>

          <div>
            <strong>Example (Wide Format):</strong>
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
            <p className="text-xs text-slate-500 mt-2">
              The first row above will create 31 days x 7 sizes = 217 database rows (with quantity per size divided by 31).
            </p>
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

// ==================== Analytics Tab Component ====================
type TimeseriesPoint = {
  date: string;
  total: number;
  byColor?: Record<string, number>;
};

type MatrixData = {
  sizes: string[];
  colors: string[];
  cells: Record<string, Record<string, number>>;
  totals: {
    byColor: Record<string, number>;
    bySize: Record<string, number>;
    grand: number;
  };
};

type TopStyle = {
  style_no: string;
  style_name: string | null;
  total: number;
  colorCount: number;
  topColor: string;
};

function AnalyticsTab({ styles }: { styles: StyleRow[] }) {
  // Style selector
  const [selectedStyleNo, setSelectedStyleNo] = useState<string>('');
  const [styleSearch, setStyleSearch] = useState('');
  
  // Date range
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().split('T')[0];
  });
  const [analyticsDateTo, setAnalyticsDateTo] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  
  // Data states
  const [timeseriesData, setTimeseriesData] = useState<TimeseriesPoint[]>([]);
  const [matrixData, setMatrixData] = useState<MatrixData | null>(null);
  const [topStyles, setTopStyles] = useState<TopStyle[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [kpis, setKpis] = useState<{ totalUnits: number; avgPerDay: number; colors: string[]; daysInPeriod: number } | null>(null);
  
  // Top styles loading
  const [topStylesLoading, setTopStylesLoading] = useState(false);

  // Filtered styles for dropdown
  const filteredStyles = useMemo(() => {
    if (!styleSearch.trim()) return styles.slice(0, 50);
    const search = styleSearch.toLowerCase();
    return styles.filter(s => 
      s.style_no.toLowerCase().includes(search) ||
      (s.style_name && s.style_name.toLowerCase().includes(search))
    ).slice(0, 50);
  }, [styles, styleSearch]);

  // Load top styles on mount
  React.useEffect(() => {
    loadTopStyles();
  }, [analyticsDateFrom, analyticsDateTo]);

  async function loadTopStyles() {
    setTopStylesLoading(true);
    try {
      const res = await fetch('/api/historical-sales/top-styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: analyticsDateFrom,
          endDate: analyticsDateTo,
          limit: 10
        })
      });
      const json = await res.json();
      if (res.ok && json.styles) {
        setTopStyles(json.styles);
      }
    } catch (err) {
      console.error('Failed to load top styles:', err);
    } finally {
      setTopStylesLoading(false);
    }
  }

  // Load analytics data for selected style
  async function loadAnalytics() {
    if (!selectedStyleNo) return;
    
    setAnalyticsLoading(true);
    try {
      // Fetch timeseries
      const tsRes = await fetch('/api/historical-sales/timeseries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style_no: selectedStyleNo,
          startDate: analyticsDateFrom,
          endDate: analyticsDateTo
        })
      });
      const tsJson = await tsRes.json();
      
      if (tsRes.ok) {
        setTimeseriesData(tsJson.points || []);
        setKpis({
          totalUnits: tsJson.totalUnits || 0,
          avgPerDay: tsJson.avgPerDay || 0,
          colors: tsJson.colors || [],
          daysInPeriod: tsJson.daysInPeriod || 0
        });
      }

      // Fetch matrix
      const matrixRes = await fetch('/api/historical-sales/matrix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style_no: selectedStyleNo,
          startDate: analyticsDateFrom,
          endDate: analyticsDateTo
        })
      });
      const matrixJson = await matrixRes.json();
      
      if (matrixRes.ok) {
        setMatrixData(matrixJson);
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  // Find best day
  const bestDay = useMemo(() => {
    if (timeseriesData.length === 0) return null;
    const first = timeseriesData[0];
    if (!first) return null;
    return timeseriesData.reduce((max, p) => p.total > max.total ? p : max, first);
  }, [timeseriesData]);

  const selectedStyle = styles.find(s => s.style_no === selectedStyleNo);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Sales Analytics</CardTitle>
          <CardDescription>
            Select a style and date range to visualize sales trends
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Style selector */}
            <div className="md:col-span-2 space-y-1">
              <label className="text-xs font-medium text-slate-700">Style</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search by style no or name..."
                  value={styleSearch}
                  onChange={(e) => setStyleSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {styleSearch && (
                <div className="absolute z-10 mt-1 w-full max-w-md bg-white border rounded-lg shadow-lg max-h-48 overflow-auto">
                  {filteredStyles.map(s => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setSelectedStyleNo(s.style_no);
                        setStyleSearch('');
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
                    >
                      <span className="font-mono">{s.style_no}</span>
                      {s.style_name && <span className="text-slate-500 ml-2">{s.style_name}</span>}
                    </button>
                  ))}
                </div>
              )}
              {selectedStyleNo && (
                <div className="text-sm text-[#8FA894] font-medium">
                  Selected: {selectedStyleNo} {selectedStyle?.style_name && `- ${selectedStyle.style_name}`}
                </div>
              )}
            </div>
            
            {/* Date range */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">From</label>
              <Input 
                type="date" 
                value={analyticsDateFrom}
                onChange={(e) => setAnalyticsDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">To</label>
              <Input 
                type="date" 
                value={analyticsDateTo}
                onChange={(e) => setAnalyticsDateTo(e.target.value)}
              />
            </div>
          </div>
          
          <div className="mt-4">
            <Button 
              onClick={loadAnalytics}
              disabled={!selectedStyleNo || analyticsLoading}
              className="bg-[#8FA894] hover:bg-[#8FA894]/90"
            >
              {analyticsLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                'Load Analytics'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Top Styles Quick Pick */}
      {!selectedStyleNo && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Top Selling Styles ({analyticsDateFrom} to {analyticsDateTo})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topStylesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : topStyles.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No sales data in this period</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {topStyles.map((style, idx) => (
                  <button
                    key={style.style_no}
                    onClick={() => {
                      setSelectedStyleNo(style.style_no);
                      setTimeout(loadAnalytics, 100);
                    }}
                    className="p-3 border rounded-lg hover:border-[#8FA894] hover:bg-[#8FA894]/5 text-left transition-colors"
                  >
                    <div className="text-xs text-slate-400">#{idx + 1}</div>
                    <div className="font-mono text-sm font-medium truncate">{style.style_no}</div>
                    {style.style_name && (
                      <div className="text-xs text-slate-500 truncate">{style.style_name}</div>
                    )}
                    <div className="text-lg font-bold text-[#8FA894] mt-1">
                      {style.total.toLocaleString('da-DK')}
                    </div>
                    <div className="text-xs text-slate-400">{style.colorCount} colors</div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* KPI Tiles */}
      {kpis && selectedStyleNo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Total Units</p>
                  <p className="text-2xl font-bold">{kpis.totalUnits.toLocaleString('da-DK')}</p>
                </div>
                <BarChart3 className="h-8 w-8 text-slate-300" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Avg/Day</p>
                  <p className="text-2xl font-bold">{kpis.avgPerDay.toLocaleString('da-DK')}</p>
                </div>
                <Calendar className="h-8 w-8 text-slate-300" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Best Day</p>
                  <p className="text-2xl font-bold">
                    {bestDay ? bestDay.total.toLocaleString('da-DK') : '—'}
                  </p>
                  {bestDay && (
                    <p className="text-xs text-slate-400">{bestDay.date}</p>
                  )}
                </div>
                <TrendingUp className="h-8 w-8 text-green-300" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Colors</p>
                  <p className="text-2xl font-bold">{kpis.colors.length}</p>
                </div>
                <div className="flex -space-x-1">
                  {kpis.colors.slice(0, 4).map((_, i) => (
                    <div 
                      key={i}
                      className="w-6 h-6 rounded-full border-2 border-white"
                      style={{ backgroundColor: ['#8FA894', '#6B8E7B', '#C5D5CA', '#4A6B52'][i] }}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Charts */}
      {timeseriesData.length > 0 && selectedStyleNo && (
        <>
          {/* Daily Trend */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Daily Sales Trend</CardTitle>
              <CardDescription>Units sold per day for {selectedStyleNo}</CardDescription>
            </CardHeader>
            <CardContent>
              <DailyLineChart data={timeseriesData} height={300} />
            </CardContent>
          </Card>

          {/* Color Mix */}
          {kpis && kpis.colors.length > 1 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Sales by Color Over Time</CardTitle>
                <CardDescription>Stacked view showing contribution of each color</CardDescription>
              </CardHeader>
              <CardContent>
                <StackedAreaByColor 
                  data={timeseriesData} 
                  colors={kpis.colors}
                  maxColors={8}
                  height={300} 
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Size Matrix */}
      {matrixData && selectedStyleNo && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Size/Color Matrix</CardTitle>
            <CardDescription>Total units sold by color and size</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="p-2 text-left border font-medium">Color</th>
                    {matrixData.sizes.map(size => (
                      <th key={size} className="p-2 text-center border font-medium">{size}</th>
                    ))}
                    <th className="p-2 text-right border font-medium bg-slate-100">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixData.colors.map(color => (
                    <tr key={color} className="hover:bg-slate-50">
                      <td className="p-2 border font-medium">{color}</td>
                      {matrixData.sizes.map(size => {
                        const value = matrixData.cells[color]?.[size] || 0;
                        const maxValue = Math.max(...Object.values(matrixData.totals.bySize));
                        const intensity = maxValue > 0 ? value / maxValue : 0;
                        return (
                          <td 
                            key={size} 
                            className="p-2 text-center border tabular-nums"
                            style={{
                              backgroundColor: value > 0 ? `rgba(143, 168, 148, ${0.1 + intensity * 0.5})` : undefined
                            }}
                          >
                            {value > 0 ? value.toLocaleString('da-DK') : '—'}
                          </td>
                        );
                      })}
                      <td className="p-2 text-right border font-medium bg-slate-50 tabular-nums">
                        {(matrixData.totals.byColor[color] || 0).toLocaleString('da-DK')}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-100 font-medium">
                    <td className="p-2 border">Total</td>
                    {matrixData.sizes.map(size => (
                      <td key={size} className="p-2 text-center border tabular-nums">
                        {(matrixData.totals.bySize[size] || 0).toLocaleString('da-DK')}
                      </td>
                    ))}
                    <td className="p-2 text-right border font-bold tabular-nums text-[#8FA894]">
                      {matrixData.totals.grand.toLocaleString('da-DK')}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Size Distribution Bar */}
      {matrixData && selectedStyleNo && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Size Distribution</CardTitle>
            <CardDescription>Total units by size (all colors combined)</CardDescription>
          </CardHeader>
          <CardContent>
            <SizeDistributionBar 
              sizes={matrixData.sizes}
              totals={matrixData.totals.bySize}
              height={250}
            />
          </CardContent>
        </Card>
      )}

      {/* No data message */}
      {selectedStyleNo && !analyticsLoading && timeseriesData.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-slate-500">
            <p>No sales data found for {selectedStyleNo} in the selected date range.</p>
            <p className="text-sm mt-2">Try adjusting the date range or selecting a different style.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
