'use client';

import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Dropzone } from '../../../components/ui/dropzone';
import { Button } from '../../../components/ui/button';

// ---------- Types ----------
type SheetData = {
  sheetName: string;
  styleNameCandidate: string;
  colorCandidate: string;
  sizes: string[];
  totalsBySize: number[];
  grandTotal: number;
};

type MatchedSheet = SheetData & {
  matchedStyleId: string | null;
  matchedStyleNo: string | null;
  matchedStyleName: string | null;
  matchedColorId: string | null;
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

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  po_link: string | null;
};

type ComparisonRow = {
  styleNo: string;
  styleName: string | null;
  color: string;
  sizes: string[];
  excelTotals: number[];
  dbTotals: number[];
  diffs: number[];
  excelGrandTotal: number;
  dbGrandTotal: number;
  diffGrandTotal: number;
  status: 'match' | 'mismatch' | 'missing_in_db';
};

// ---------- Fuzzy helpers ----------
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

function fuzzyScore(query: string, target: string): number {
  const qNorm = normalizeText(query);
  const tNorm = normalizeText(target);
  if (!qNorm || !tNorm) return 0;
  
  // Exact match
  if (qNorm === tNorm) return 1;
  
  // Substring match
  if (tNorm.includes(qNorm) || qNorm.includes(tNorm)) {
    const longer = Math.max(qNorm.length, tNorm.length);
    const shorter = Math.min(qNorm.length, tNorm.length);
    return 0.7 + (shorter / longer) * 0.3;
  }
  
  // Token overlap
  const qTokens = tokenize(query);
  const tTokens = tokenize(target);
  if (qTokens.length === 0 || tTokens.length === 0) return 0;
  
  let matches = 0;
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (qt === tt) {
        matches++;
        break;
      }
      // Partial token match
      if (tt.includes(qt) || qt.includes(tt)) {
        matches += 0.5;
        break;
      }
    }
  }
  
  const maxTokens = Math.max(qTokens.length, tTokens.length);
  return matches / maxTokens;
}

function pickBest<T extends { id: string }>(
  candidates: T[],
  query: string,
  getField: (c: T) => string | null,
  minScore: number
): { item: T | null; score: number } {
  let best: T | null = null;
  let bestScore = 0;
  
  for (const c of candidates) {
    const field = getField(c);
    if (!field) continue;
    const score = fuzzyScore(query, field);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  
  if (bestScore < minScore) {
    return { item: null, score: bestScore };
  }
  
  return { item: best, score: bestScore };
}

// ---------- Excel parsing ----------
function parseExcelFile(file: File): Promise<SheetData[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        const sheets: SheetData[] = [];
        
        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) continue;
          
          // Parse sheet name: last word is color, rest is style name
          const tokens = sheetName.trim().split(/\s+/);
          const colorCandidate = tokens.length > 1 ? tokens.pop()! : '';
          const styleNameCandidate = tokens.join(' ');
          
          // Convert to array of arrays
          const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          if (rows.length < 2) continue;
          
          // First row: sizes start from column B (index 1)
          const headerRow = rows[0] || [];
          const sizes: string[] = [];
          for (let col = 1; col < headerRow.length; col++) {
            const val = headerRow[col];
            if (val === undefined || val === null || val === '') break;
            sizes.push(String(val).trim());
          }
          
          if (sizes.length === 0) continue;
          
          // Find totals row
          let totalsRowIndex = -1;
          for (let i = 1; i < rows.length; i++) {
            const firstCell = String(rows[i]?.[0] || '').trim().toLowerCase();
            if (firstCell === 'totaal' || firstCell === 'total' || firstCell === 'sum') {
              totalsRowIndex = i;
              break;
            }
          }
          
          let totalsBySize: number[];
          const totalsRow = totalsRowIndex >= 0 ? rows[totalsRowIndex] : undefined;
          if (totalsRow) {
            // Use totals row values
            totalsBySize = sizes.map((_, idx) => {
              const val = totalsRow[idx + 1];
              return typeof val === 'number' ? val : parseInt(String(val || '0').replace(/[^0-9-]/g, ''), 10) || 0;
            });
          } else {
            // Fallback: sum all numeric values per column
            totalsBySize = sizes.map((_, idx) => {
              let sum = 0;
              for (let i = 1; i < rows.length; i++) {
                const val = rows[i]?.[idx + 1];
                if (typeof val === 'number') {
                  sum += val;
                } else {
                  const parsed = parseInt(String(val || '0').replace(/[^0-9-]/g, ''), 10);
                  if (!isNaN(parsed)) sum += parsed;
                }
              }
              return sum;
            });
          }
          
          const grandTotal = totalsBySize.reduce((a, b) => a + b, 0);
          
          sheets.push({
            sheetName,
            styleNameCandidate,
            colorCandidate,
            sizes,
            totalsBySize,
            grandTotal,
          });
        }
        
        resolve(sheets);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ---------- BELL_RAIN check ----------
function isBellRainRow(row: StockRow): boolean {
  const label = (row.row_label || '').toLowerCase();
  const link = (row.po_link || '').toLowerCase();
  const pattern = /bell[-_ ]?rain|bellrain/i;
  // Also check for BR prefix (e.g., BR7317)
  const brPattern = /^br\d+/i;
  
  return pattern.test(label) || pattern.test(link) || brPattern.test(row.row_label || '');
}

// ---------- Main Component ----------
export default function NoosPage() {
  const supabase = createClientComponentClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [matchedSheets, setMatchedSheets] = useState<MatchedSheet[]>([]);
  const [comparisonResults, setComparisonResults] = useState<ComparisonRow[]>([]);
  const [step, setStep] = useState<'upload' | 'parsed' | 'compared'>('upload');

  // Fetch styles for fuzzy matching
  const { data: stylesData } = useSWR<StyleRow[]>('noos:styles', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name');
    if (error) throw new Error(error.message);
    return (data ?? []) as StyleRow[];
  });

  // Fetch style_colors for matched styles
  const { data: styleColorsData } = useSWR<StyleColorRow[]>(
    matchedSheets.length > 0 ? ['noos:style_colors', matchedSheets.map(s => s.matchedStyleId).filter(Boolean).join(',')] : null,
    async () => {
      const styleIds = matchedSheets.map(s => s.matchedStyleId).filter(Boolean) as string[];
      if (styleIds.length === 0) return [];
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, style_id, color')
        .in('style_id', styleIds);
      if (error) throw new Error(error.message);
      return (data ?? []) as StyleColorRow[];
    }
  );

  // Summary stats
  const summary = useMemo(() => {
    if (sheets.length === 0) return null;
    
    const uniqueStyles = new Set(sheets.map(s => normalizeText(s.styleNameCandidate)));
    const uniqueColors = new Set(sheets.map(s => normalizeText(s.colorCandidate)));
    
    return {
      sheetCount: sheets.length,
      styleCount: uniqueStyles.size,
      colorCount: uniqueColors.size,
    };
  }, [sheets]);

  // Parse uploaded file
  async function handleFileParse(f: File) {
    setFile(f);
    setBusy(true);
    setError(null);
    setSheets([]);
    setMatchedSheets([]);
    setComparisonResults([]);
    setStep('upload');
    
    try {
      const parsed = await parseExcelFile(f);
      if (parsed.length === 0) {
        throw new Error('No valid sheets found in the Excel file.');
      }
      setSheets(parsed);
      setStep('parsed');
    } catch (err: any) {
      console.error('[noos] parse error', err);
      setError(err?.message || 'Failed to parse Excel file');
    } finally {
      setBusy(false);
    }
  }

  // Match sheets against styles and colors
  async function handleFuzzyMatch() {
    if (!stylesData || sheets.length === 0) return;
    
    setBusy(true);
    setError(null);
    
    try {
      const MIN_STYLE_SCORE = 0.6;
      const MIN_COLOR_SCORE = 0.5;
      
      const matched: MatchedSheet[] = [];
      
      for (const sheet of sheets) {
        // Match style
        const styleMatch = pickBest(
          stylesData,
          sheet.styleNameCandidate,
          (s) => s.style_name,
          MIN_STYLE_SCORE
        );
        
        if (!styleMatch.item) {
          matched.push({
            ...sheet,
            matchedStyleId: null,
            matchedStyleNo: null,
            matchedStyleName: null,
            matchedColorId: null,
            matchedColor: null,
            styleScore: styleMatch.score,
            colorScore: 0,
            status: 'unmatched_style',
          });
          continue;
        }
        
        // Match color for this style
        const styleColors = (styleColorsData ?? []).filter(sc => sc.style_id === styleMatch.item!.id);
        
        // If colors not loaded yet, fetch them inline
        let colorsToMatch = styleColors;
        if (colorsToMatch.length === 0) {
          const { data: colors } = await supabase
            .from('style_colors')
            .select('id, style_id, color')
            .eq('style_id', styleMatch.item.id);
          colorsToMatch = (colors ?? []) as StyleColorRow[];
        }
        
        const colorMatch = pickBest(
          colorsToMatch,
          sheet.colorCandidate,
          (c) => c.color,
          MIN_COLOR_SCORE
        );
        
        if (!colorMatch.item) {
          matched.push({
            ...sheet,
            matchedStyleId: styleMatch.item.id,
            matchedStyleNo: styleMatch.item.style_no,
            matchedStyleName: styleMatch.item.style_name,
            matchedColorId: null,
            matchedColor: null,
            styleScore: styleMatch.score,
            colorScore: colorMatch.score,
            status: 'unmatched_color',
          });
          continue;
        }
        
        matched.push({
          ...sheet,
          matchedStyleId: styleMatch.item.id,
          matchedStyleNo: styleMatch.item.style_no,
          matchedStyleName: styleMatch.item.style_name,
          matchedColorId: colorMatch.item.id,
          matchedColor: colorMatch.item.color,
          styleScore: styleMatch.score,
          colorScore: colorMatch.score,
          status: 'matched',
        });
      }
      
      setMatchedSheets(matched);
    } catch (err: any) {
      console.error('[noos] fuzzy match error', err);
      setError(err?.message || 'Failed to match styles');
    } finally {
      setBusy(false);
    }
  }

  // Cross-check against BELL_RAIN POs
  async function handlePOCrossCheck() {
    const fullyMatched = matchedSheets.filter(s => s.status === 'matched');
    if (fullyMatched.length === 0) {
      setError('No fully matched sheets to compare.');
      return;
    }
    
    setBusy(true);
    setError(null);
    
    try {
      // Get unique style_nos
      const styleNos = [...new Set(fullyMatched.map(s => s.matchedStyleNo).filter(Boolean))] as string[];
      
      // Fetch purchase rows from style_stock
      const { data: stockRows, error: stockError } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, po_link')
        .in('style_no', styleNos)
        .eq('section', 'Purchase (Running + Shipped)');
      
      if (stockError) throw new Error(stockError.message);
      
      // Filter to BELL_RAIN rows only
      const bellRainRows = ((stockRows ?? []) as StockRow[]).filter(isBellRainRow);
      
      // Aggregate by style_no + color
      const dbAggregated = new Map<string, { sizes: string[]; totals: number[] }>();
      
      for (const row of bellRainRows) {
        const key = `${row.style_no}|||${row.color.toLowerCase()}`;
        const existing = dbAggregated.get(key);
        
        const rowSizes = Array.isArray(row.sizes) ? row.sizes : [];
        const rowValues = Array.isArray(row.values) ? row.values.map(v => Number(v) || 0) : [];
        
        if (!existing) {
          dbAggregated.set(key, { sizes: rowSizes, totals: [...rowValues] });
        } else {
          // Sum values aligned by size
          for (let i = 0; i < rowValues.length && i < existing.totals.length; i++) {
            const currentVal = existing.totals[i] ?? 0;
            const addVal = rowValues[i] ?? 0;
            existing.totals[i] = currentVal + addVal;
          }
        }
      }
      
      // Build comparison results
      const results: ComparisonRow[] = [];
      
      for (const sheet of fullyMatched) {
        const key = `${sheet.matchedStyleNo}|||${(sheet.matchedColor || '').toLowerCase()}`;
        const dbData = dbAggregated.get(key);
        
        if (!dbData) {
          results.push({
            styleNo: sheet.matchedStyleNo!,
            styleName: sheet.matchedStyleName,
            color: sheet.matchedColor!,
            sizes: sheet.sizes,
            excelTotals: sheet.totalsBySize,
            dbTotals: sheet.sizes.map(() => 0),
            diffs: sheet.totalsBySize.map(v => -v),
            excelGrandTotal: sheet.grandTotal,
            dbGrandTotal: 0,
            diffGrandTotal: -sheet.grandTotal,
            status: 'missing_in_db',
          });
          continue;
        }
        
        // Align sizes between Excel and DB
        const excelTotals: number[] = [];
        const dbTotals: number[] = [];
        const diffs: number[] = [];
        
        for (let i = 0; i < sheet.sizes.length; i++) {
          const excelSize = sheet.sizes[i];
          const excelVal = sheet.totalsBySize[i] || 0;
          
          // Find matching size in DB
          const dbSizeIndex = dbData.sizes.findIndex(s => normalizeText(String(s)) === normalizeText(excelSize));
          const dbVal = dbSizeIndex >= 0 ? (dbData.totals[dbSizeIndex] || 0) : 0;
          
          excelTotals.push(excelVal);
          dbTotals.push(dbVal);
          diffs.push(dbVal - excelVal);
        }
        
        const excelGrandTotal = excelTotals.reduce((a, b) => a + b, 0);
        const dbGrandTotal = dbTotals.reduce((a, b) => a + b, 0);
        const diffGrandTotal = dbGrandTotal - excelGrandTotal;
        
        const allMatch = diffs.every(d => d === 0);
        
        results.push({
          styleNo: sheet.matchedStyleNo!,
          styleName: sheet.matchedStyleName,
          color: sheet.matchedColor!,
          sizes: sheet.sizes,
          excelTotals,
          dbTotals,
          diffs,
          excelGrandTotal,
          dbGrandTotal,
          diffGrandTotal,
          status: allMatch ? 'match' : 'mismatch',
        });
      }
      
      // Sort: mismatches first, then missing, then matches
      results.sort((a, b) => {
        const order = { mismatch: 0, missing_in_db: 1, match: 2 };
        return order[a.status] - order[b.status];
      });
      
      setComparisonResults(results);
      setStep('compared');
    } catch (err: any) {
      console.error('[noos] PO cross-check error', err);
      setError(err?.message || 'Failed to check POs');
    } finally {
      setBusy(false);
    }
  }

  // Effect to run fuzzy match when styles data loads
  useMemo(() => {
    if (sheets.length > 0 && stylesData && stylesData.length > 0 && matchedSheets.length === 0) {
      handleFuzzyMatch();
    }
  }, [sheets, stylesData]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">NOOS Stock Checker</h1>
        <div className="text-sm text-slate-600">
          Upload a NOOS Excel file to check stock levels against BELL RAIN purchase orders.
        </div>
      </div>

      {/* Upload Card */}
      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="text-sm font-medium">Upload Excel File</div>
        <Dropzone
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          multiple={false}
          onFiles={(files) => {
            const f = files?.[0];
            if (f) handleFileParse(f);
          }}
        >
          <div className="space-y-1">
            <div className="text-sm font-medium text-slate-800">Drag & drop an Excel file here</div>
            <div className="text-xs text-slate-500">…or click to browse</div>
            {file && <div className="text-xs text-slate-600 mt-2">Selected: {file.name}</div>}
          </div>
        </Dropzone>
        {busy && <div className="text-sm text-blue-600">Processing...</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>

      {/* Summary after parsing */}
      {summary && step !== 'upload' && (
        <div className="rounded-lg border bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-sm">
              <span className="font-medium text-lg">{summary.sheetCount}</span>{' '}
              <span className="text-slate-500">sheets detected</span>
            </div>
            <div className="text-sm">
              <span className="font-medium text-lg">{summary.styleCount}</span>{' '}
              <span className="text-slate-500">styles</span>
              {' in '}
              <span className="font-medium text-lg">{summary.colorCount}</span>{' '}
              <span className="text-slate-500">colors</span>
            </div>
          </div>

          {/* Extracted totals table */}
          <div className="overflow-auto rounded border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-left font-medium text-slate-600">Style Name</th>
                  <th className="p-2 text-left font-medium text-slate-600">Color</th>
                  {sheets[0]?.sizes.map((size, idx) => (
                    <th key={idx} className="p-2 text-right font-medium text-slate-600">{size}</th>
                  ))}
                  <th className="p-2 text-right font-medium text-slate-600">Total</th>
                  <th className="p-2 text-left font-medium text-slate-600">Match Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(matchedSheets.length > 0 ? matchedSheets : sheets.map(s => ({ ...s, status: 'pending' as const }))).map((sheet, idx) => {
                  const ms = sheet as MatchedSheet;
                  return (
                    <tr key={idx} className={ms.status === 'unmatched_style' || ms.status === 'unmatched_color' ? 'bg-amber-50' : ''}>
                      <td className="p-2">
                        <div className="font-medium">{sheet.styleNameCandidate}</div>
                        {ms.matchedStyleName && ms.matchedStyleName !== sheet.styleNameCandidate && (
                          <div className="text-xs text-green-600">→ {ms.matchedStyleNo}: {ms.matchedStyleName}</div>
                        )}
                      </td>
                      <td className="p-2">
                        <div>{sheet.colorCandidate}</div>
                        {ms.matchedColor && ms.matchedColor !== sheet.colorCandidate && (
                          <div className="text-xs text-green-600">→ {ms.matchedColor}</div>
                        )}
                      </td>
                      {sheet.totalsBySize.map((val, i) => (
                        <td key={i} className="p-2 text-right tabular-nums">{val.toLocaleString('da-DK')}</td>
                      ))}
                      <td className="p-2 text-right tabular-nums font-medium">{sheet.grandTotal.toLocaleString('da-DK')}</td>
                      <td className="p-2">
                        {'status' in ms && ms.status !== 'pending' && (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            ms.status === 'matched' ? 'bg-green-100 text-green-800' :
                            ms.status === 'unmatched_style' ? 'bg-red-100 text-red-800' :
                            'bg-amber-100 text-amber-800'
                          }`}>
                            {ms.status === 'matched' ? 'Matched' :
                             ms.status === 'unmatched_style' ? 'Style not found' :
                             'Color not found'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* PO Check button */}
          {matchedSheets.length > 0 && matchedSheets.some(s => s.status === 'matched') && step === 'parsed' && (
            <div className="flex justify-end">
              <Button
                onClick={handlePOCrossCheck}
                disabled={busy}
              >
                {busy ? 'Checking...' : 'Check against BELL RAIN POs'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* PO Comparison Results */}
      {step === 'compared' && comparisonResults.length > 0 && (
        <div className="rounded-lg border bg-white p-4 space-y-4">
          <div className="text-sm font-medium">PO Comparison Results (BELL RAIN)</div>
          
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div>
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-green-100 text-green-800 font-medium">
                {comparisonResults.filter(r => r.status === 'match').length}
              </span>
              {' '}matches
            </div>
            <div>
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-red-100 text-red-800 font-medium">
                {comparisonResults.filter(r => r.status === 'mismatch').length}
              </span>
              {' '}mismatches
            </div>
            <div>
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-800 font-medium">
                {comparisonResults.filter(r => r.status === 'missing_in_db').length}
              </span>
              {' '}missing in DB
            </div>
          </div>

          <div className="overflow-auto rounded border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-left font-medium text-slate-600">Style</th>
                  <th className="p-2 text-left font-medium text-slate-600">Color</th>
                  {comparisonResults[0]?.sizes.map((size, idx) => (
                    <th key={idx} className="p-2 text-center font-medium text-slate-600" colSpan={1}>{size}</th>
                  ))}
                  <th className="p-2 text-right font-medium text-slate-600">Total</th>
                  <th className="p-2 text-left font-medium text-slate-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {comparisonResults.map((row, idx) => (
                  <tr key={idx} className={row.status === 'mismatch' ? 'bg-red-50' : row.status === 'missing_in_db' ? 'bg-gray-50' : ''}>
                    <td className="p-2">
                      <div className="font-medium">{row.styleNo}</div>
                      {row.styleName && <div className="text-xs text-slate-500">{row.styleName}</div>}
                    </td>
                    <td className="p-2">{row.color}</td>
                    {row.sizes.map((_, i) => (
                      <td key={i} className="p-2 text-center">
                        <div className="text-xs text-slate-500">E: {row.excelTotals[i]}</div>
                        <div className="text-xs text-slate-500">D: {row.dbTotals[i]}</div>
                        <div className={`text-xs font-medium ${row.diffs[i] === 0 ? 'text-green-600' : row.diffs[i] > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                          {row.diffs[i] > 0 ? '+' : ''}{row.diffs[i]}
                        </div>
                      </td>
                    ))}
                    <td className="p-2 text-right">
                      <div className="text-xs text-slate-500">E: {row.excelGrandTotal}</div>
                      <div className="text-xs text-slate-500">D: {row.dbGrandTotal}</div>
                      <div className={`text-xs font-medium ${row.diffGrandTotal === 0 ? 'text-green-600' : row.diffGrandTotal > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {row.diffGrandTotal > 0 ? '+' : ''}{row.diffGrandTotal}
                      </div>
                    </td>
                    <td className="p-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        row.status === 'match' ? 'bg-green-100 text-green-800' :
                        row.status === 'mismatch' ? 'bg-red-100 text-red-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {row.status === 'match' ? 'Match' :
                         row.status === 'mismatch' ? 'Mismatch' :
                         'Not in DB'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setFile(null);
                setSheets([]);
                setMatchedSheets([]);
                setComparisonResults([]);
                setStep('upload');
                setError(null);
              }}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                alert('Update POs functionality coming soon!');
              }}
            >
              Update PO&apos;s
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
