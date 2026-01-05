'use client';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Dropzone } from '../../../components/ui/dropzone';

// Types
type Season = {
  id: string;
  name: string;
  year: number | null;
  is_current?: boolean | null;
};

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

// Aggregated row with size breakdown
type AggregatedRow = {
  style_no: string;
  color: string;
  supplier?: string;
  total_qty: number;
  total_amount: number;
  customer_count: number;
  sizes: Record<string, number>; // size -> qty
};

type ImportStats = {
  totalRows: number;
  insertedRows: number;
  errorCount: number;
  styleCount: number;
  customerCount: number;
  totalQty: number;
  totalAmount: number;
  dateRange: { start: string; end: string } | null;
};

type SupplierSuggestion = {
  supplier_name: string;
  supplier_id: string;
  recommendation_summary: string;
  total_units: number;
  total_value_estimate: number;
  lines: Array<{
    style_no: string;
    color: string;
    suggested_qty: number;
    reasoning: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  moq_status: 'met' | 'under' | 'n/a';
  notes?: string;
};

type AIOutput = {
  suppliers: SupplierSuggestion[];
  overall_summary: string;
  total_units: number;
  warnings: string[];
};

type SupplierCommitData = {
  supplier_name: string;
  supplier_id?: string;
  lines: Array<{
    style_no: string;
    color: string;
    suggested_qty: number;
    adjusted_qty?: number;
    reasoning?: string;
    priority?: 'high' | 'medium' | 'low';
  }>;
  verdict: 'approved' | 'adjusted' | 'skipped';
  notes?: string;
};

type CreatedPO = {
  supplier: string;
  poId?: number;
  poNo?: string;
  itemCount: number;
  totalQty: number;
  status: 'created' | 'skipped' | 'error';
  error?: string;
};

// CSV Parser - handles size-level rows and aggregates to customer/style/color
function parseCSV(text: string): CSVRow[] {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[CSV Parser] Starting parse...');
  
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  console.log(`[CSV Parser] Total lines (including header): ${lines.length}`);
  
  if (lines.length < 2) {
    console.log('[CSV Parser] ERROR: Less than 2 lines, returning empty');
    return [];
  }
  
  const headerLine = lines[0]!;
  console.log('[CSV Parser] Raw header line:', headerLine);
  
  // Try to detect delimiter
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const delimiter = tabCount > commaCount && tabCount > semicolonCount ? '\t' 
    : semicolonCount > commaCount ? ';' : ',';
  console.log(`[CSV Parser] Detected delimiter: "${delimiter === '\t' ? 'TAB' : delimiter}" (commas:${commaCount}, semicolons:${semicolonCount}, tabs:${tabCount})`);
  
  const rawHeaders = headerLine.split(delimiter).map(h => h.trim());
  console.log('[CSV Parser] Raw headers (before normalization):', rawHeaders);
  
  const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9_ ]/g, '_').replace(/\s+/g, '_'));
  console.log('[CSV Parser] Normalized headers:', headers);
  
  // Show expected vs found mapping
  const expectedMappings = {
    'date': ['date', 'dato', 'invoice_date'],
    'style_no': ['style_no', 'style', 'varenr', 'item_no'],
    'color': ['color', 'farve', 'colour'],
    'size': ['size', 'size_code', 'storrelse', 'str'],
    'customer_name': ['customer_name', 'customer', 'kunde', 'debitor'],
    'country': ['country', 'land'],
    'sales_rep': ['sales_rep', 'salesperson', 'saelger'],
    'qty': ['size_quantity_ordered', 'qty', 'quantity', 'antal', 'pcs'],
    'net_amount': ['sales_price_exchange_total', 'net_amount', 'amount', 'belob', 'value'],
  };
  
  console.log('[CSV Parser] Field mapping check:');
  for (const [field, variations] of Object.entries(expectedMappings)) {
    const found = variations.find(v => headers.includes(v));
    console.log(`  ${field}: ${found ? `✓ found as "${found}"` : `✗ NOT FOUND (looked for: ${variations.join(', ')})`}`);
  }
  
  // First pass: collect all raw rows
  const rawRows: any[] = [];
  let skippedNoStyle = 0;
  let skippedNoColor = 0;
  
  // Helper to clean Excel-style values like ="1010191" or "value"
  const cleanExcelValue = (v: string): string => {
    let cleaned = v.trim();
    // Handle Excel formula format: ="value" -> value
    if (cleaned.startsWith('="') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(2, -1);
    }
    // Handle quoted values: "value" -> value
    else if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || 
             (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }
    // Handle leading = without quotes: =value -> value
    else if (cleaned.startsWith('=')) {
      cleaned = cleaned.slice(1);
    }
    return cleaned;
  };
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const rawValues = line.split(delimiter);
    const values = rawValues.map(cleanExcelValue);
    
    const row: any = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    
    // Log first row in detail - show both raw and cleaned values
    if (i === 1) {
      console.log('[CSV Parser] First data row (raw → cleaned):');
      headers.forEach((h, idx) => {
        const raw = rawValues[idx]?.trim() || '(empty)';
        const clean = values[idx] || '(empty)';
        const changed = raw !== clean ? ` → "${clean}"` : '';
        console.log(`  "${h}": "${raw}"${changed}`);
      });
    }
    
    // Map column variations to standard names
    const mapped = {
      date: row.date || row.dato || row.invoice_date || '',
      customer_name: row.customer_name || row.customer || row.kunde || row.debitor || '',
      customer_id: row.customer_id || row.debitor_nr || '',
      country: row.country || row.land || '',
      sales_rep: row.sales_rep || row.salesperson || row.saelger || '',
      style_no: row.style_no || row.style || row.varenr || row.item_no || '',
      style_name: row.style_name || row.varenavn || row.description || '',
      color: row.color || row.farve || row.colour || '',
      size: row.size || row.size_code || row.storrelse || row.str || '',
      supplier: row.supplier || row.leverandor || '',
      qty: Number(row.size_quantity_ordered || row.qty || row.quantity || row.antal || row.pcs || 0) || 0,
      net_amount: Number(row.sales_price_exchange_total || row.net_amount || row.amount || row.belob || row.value || 0) || 0,
      currency: row.currency || row.valuta || 'DKK',
      order_ref: row.order_ref || row.invoice || row.faktura || '',
      channel: row.channel || row.kanal || '',
    };
    
    // Log first row mapped values
    if (i === 1) {
      console.log('[CSV Parser] First data row (mapped values):');
      console.log(`  date: "${mapped.date}"`);
      console.log(`  style_no: "${mapped.style_no}"`);
      console.log(`  color: "${mapped.color}"`);
      console.log(`  size: "${mapped.size}"`);
      console.log(`  customer_name: "${mapped.customer_name}"`);
      console.log(`  country: "${mapped.country}"`);
      console.log(`  sales_rep: "${mapped.sales_rep}"`);
      console.log(`  qty: ${mapped.qty}`);
      console.log(`  net_amount: ${mapped.net_amount}`);
    }
    
    if (!mapped.style_no) skippedNoStyle++;
    if (!mapped.color) skippedNoColor++;
    
    if (mapped.style_no && mapped.color) {
      rawRows.push(mapped);
    }
  }
  
  console.log(`[CSV Parser] Rows parsed: ${rawRows.length} valid, skipped ${skippedNoStyle} (no style_no), ${skippedNoColor} (no color)`);
  
  if (rawRows.length === 0) {
    console.log('[CSV Parser] ERROR: No valid rows! Check field mapping above.');
    console.log('═══════════════════════════════════════════════════════════');
    return [];
  }
  
  // Detect if amounts are in cents (if average > 10000, likely cents)
  const avgAmount = rawRows.reduce((sum, r) => sum + r.net_amount, 0) / (rawRows.length || 1);
  const amountDivisor = avgAmount > 10000 ? 100 : 1;
  console.log(`[CSV Parser] Average net_amount: ${avgAmount.toFixed(2)} → ${amountDivisor === 100 ? 'Treating as cents, dividing by 100' : 'Keeping as-is'}`);
  
  // Apply cents conversion if needed, keep raw size-level data
  const rows: CSVRow[] = rawRows.map(row => ({
    ...row,
    net_amount: amountDivisor > 1 ? row.net_amount / amountDivisor : row.net_amount,
  }));
  
  // Collect unique sizes found
  const uniqueSizes = new Set(rows.map(r => r.size).filter(Boolean));
  console.log(`[CSV Parser] Unique sizes found: [${Array.from(uniqueSizes).join(', ')}]`);
  
  // Collect unique customers
  const uniqueCustomers = new Set(rows.map(r => r.customer_name || r.customer_id).filter(Boolean));
  console.log(`[CSV Parser] Unique customers: ${uniqueCustomers.size}`);
  
  // Sample of final output
  if (rows.length > 0) {
    console.log('[CSV Parser] Sample row:', JSON.stringify(rows[0], null, 2));
  }
  
  console.log(`[CSV Parser] RESULT: ${rawRows.length} raw rows (keeping size-level data)`);
  console.log('═══════════════════════════════════════════════════════════');
  
  return rows;
}

// Aggregate CSV rows by style/color with size breakdown
function aggregateByStyleColor(rows: CSVRow[]): AggregatedRow[] {
  const aggregated = new Map<string, AggregatedRow>();
  const customersByKey = new Map<string, Set<string>>();
  
  for (const row of rows) {
    const key = `${row.style_no}|${row.color}`;
    const customerKey = row.customer_name || row.customer_id || 'unknown';
    
    if (!customersByKey.has(key)) {
      customersByKey.set(key, new Set());
    }
    customersByKey.get(key)!.add(customerKey);
    
    if (aggregated.has(key)) {
      const existing = aggregated.get(key)!;
      existing.total_qty += Number(row.qty) || 0;
      existing.total_amount += Number(row.net_amount) || 0;
      
      // Add to size breakdown
      const size = row.size || 'UNKNOWN';
      existing.sizes[size] = (existing.sizes[size] || 0) + (Number(row.qty) || 0);
    } else {
      const size = row.size || 'UNKNOWN';
      aggregated.set(key, {
        style_no: row.style_no,
        color: row.color,
        supplier: row.supplier,
        total_qty: Number(row.qty) || 0,
        total_amount: Number(row.net_amount) || 0,
        customer_count: 0, // Will be set after
        sizes: { [size]: Number(row.qty) || 0 },
      });
    }
  }
  
  // Set customer counts
  for (const [key, agg] of aggregated) {
    agg.customer_count = customersByKey.get(key)?.size || 0;
  }
  
  return Array.from(aggregated.values());
}

// Get all unique sizes from aggregated rows in order
function getUniqueSizes(rows: AggregatedRow[]): string[] {
  const sizeSet = new Set<string>();
  for (const row of rows) {
    Object.keys(row.sizes).forEach(s => sizeSet.add(s));
  }
  
  // Sort sizes in a sensible order (numeric first, then alpha)
  const sizes = Array.from(sizeSet);
  sizes.sort((a, b) => {
    const aNum = parseInt(a);
    const bNum = parseInt(b);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    if (!isNaN(aNum)) return -1;
    if (!isNaN(bNum)) return 1;
    
    // Common size ordering
    const sizeOrder = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL'];
    const aIdx = sizeOrder.indexOf(a.toUpperCase());
    const bIdx = sizeOrder.indexOf(b.toUpperCase());
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    
    return a.localeCompare(b);
  });
  
  return sizes;
}

// Progress Steps Component
function ProgressSteps({ currentStep, steps }: { currentStep: number; steps: string[] }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, idx) => {
        const stepNum = idx + 1;
        const isActive = stepNum === currentStep;
        const isComplete = stepNum < currentStep;
        
              return (
          <React.Fragment key={idx}>
            {idx > 0 && (
              <div className={`h-0.5 w-8 ${isComplete ? 'bg-[#8FA894]' : 'bg-slate-200'}`} />
            )}
                      <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                isComplete ? 'bg-[#8FA894] text-white' :
                isActive ? 'bg-[#B8A8D8] text-white' :
                'bg-slate-100 text-slate-500'
              }`}>
                {isComplete ? '✓' : stepNum}
                      </div>
              <span className={`text-sm ${isActive ? 'font-medium text-slate-900' : 'text-slate-500'}`}>
                {label}
              </span>
                      </div>
          </React.Fragment>
              );
            })}
    </div>
  );
}

// Supplier Review Card
function SupplierReviewCard({
  supplier,
  onApprove,
  onSkip,
  isLast,
}: {
  supplier: SupplierSuggestion;
  onApprove: (data: SupplierCommitData) => void;
  onSkip: () => void;
  isLast: boolean;
}) {
  const [adjustments, setAdjustments] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  
  const handleQtyChange = (styleNo: string, color: string, value: string) => {
    const key = `${styleNo}|${color}`;
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0) {
      setAdjustments(prev => ({ ...prev, [key]: num }));
    } else if (value === '') {
      const next = { ...adjustments };
      delete next[key];
      setAdjustments(next);
    }
  };
  
  const handleApprove = () => {
    const hasAdjustments = Object.keys(adjustments).length > 0;
    onApprove({
      supplier_name: supplier.supplier_name,
      supplier_id: supplier.supplier_id,
      lines: supplier.lines.map(line => {
        const key = `${line.style_no}|${line.color}`;
        return {
          ...line,
          adjusted_qty: adjustments[key],
        };
      }),
      verdict: hasAdjustments ? 'adjusted' : 'approved',
      notes: notes || undefined,
    });
  };
  
  const totalOriginal = supplier.lines.reduce((sum, l) => sum + l.suggested_qty, 0);
  const totalAdjusted = supplier.lines.reduce((sum, l) => {
    const key = `${l.style_no}|${l.color}`;
    return sum + (adjustments[key] ?? l.suggested_qty);
  }, 0);

  return (
    <Card className="border-[#C5D5CA]/50">
      <CardHeader className="bg-[#F5F3F0]">
        <div className="flex items-center justify-between w-full">
                  <div>
            <CardTitle className="text-lg">{supplier.supplier_name}</CardTitle>
            <CardDescription>{supplier.recommendation_summary}</CardDescription>
                  </div>
          <div className="text-right">
            <div className="text-2xl font-semibold text-[#8FA894]">{totalAdjusted}</div>
            <div className="text-xs text-slate-500">units {totalAdjusted !== totalOriginal && `(was ${totalOriginal})`}</div>
                </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                <th className="text-left p-3 font-medium">Style</th>
                <th className="text-left p-3 font-medium">Color</th>
                <th className="text-right p-3 font-medium">Suggested</th>
                <th className="text-right p-3 font-medium w-24">Qty</th>
                <th className="text-center p-3 font-medium w-20">Priority</th>
              </tr>
            </thead>
            <tbody>
              {supplier.lines.map((line, idx) => {
                const key = `${line.style_no}|${line.color}`;
                const currentQty = adjustments[key] ?? line.suggested_qty;
                
                      return (
                  <tr key={idx} className="border-t hover:bg-slate-50">
                    <td className="p-3" title={line.style_no}>
                      <span className="text-sm">{(line as any).style_name || line.style_no}</span>
                      {(line as any).style_name && (
                        <span className="block text-xs text-slate-400 font-mono">{line.style_no}</span>
                      )}
                    </td>
                    <td className="p-3">{line.color}</td>
                    <td className="p-3 text-right text-slate-500">{line.suggested_qty}</td>
                    <td className="p-3">
                      <Input
                        type="number"
                        min={0}
                        value={currentQty}
                        onChange={e => handleQtyChange(line.style_no, line.color, e.target.value)}
                        className="w-20 text-right h-8 ml-auto"
                      />
                    </td>
                    <td className="p-3 text-center">
                      <Badge className={
                        line.priority === 'high' ? 'bg-red-100 text-red-700' :
                        line.priority === 'medium' ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-600'
                      }>
                        {line.priority}
                      </Badge>
                    </td>
                  </tr>
                      );
                    })}
            </tbody>
          </table>
        </div>
        
        {supplier.moq_status === 'under' && (
          <div className="p-3 bg-amber-50 border-t border-amber-200 text-amber-800 text-sm">
            ⚠️ Below minimum order quantity (MOQ)
                  </div>
                )}
        
        <div className="p-4 border-t bg-slate-50 space-y-3">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Notes (optional)</label>
            <Input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes about this order..."
              className="h-8"
            />
              </div>
          
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={onSkip} size="sm">
              Skip supplier
            </Button>
            <Button onClick={handleApprove} className="bg-[#8FA894] hover:bg-[#8FA894]/90">
              {isLast ? 'Complete & Create POs' : 'Approve & Next'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
  );
}

// Main Component
export default function PurchaseMakeOrderPage() {
  // State
  const [step, setStep] = useState(1);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>('');
  const [comparisonSeasonId, setComparisonSeasonId] = useState<string>(''); // Last year's season for YoY
  const [csvData, setCsvData] = useState<CSVRow[]>([]);
  const [csvFileName, setCsvFileName] = useState<string>('');
  const [importId, setImportId] = useState<string>('');
  const [importStats, setImportStats] = useState<ImportStats | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string>('');
  
  const [isRunningAI, setIsRunningAI] = useState(false);
  const [aiError, setAiError] = useState<string>('');
  const [aiOutput, setAiOutput] = useState<AIOutput | null>(null);
  const [yoyAnalysis, setYoyAnalysis] = useState<any>(null);
  const [purchaseRunId, setPurchaseRunId] = useState<string>('');
  const [aiStats, setAiStats] = useState<{ tokensUsed: number; durationMs: number } | null>(null);
  const [unlinkedSuppliers, setUnlinkedSuppliers] = useState<Array<{ name: string; styleCount: number; totalQty: number }>>([]);
  const [suppliersCoverage, setSuppliersCoverage] = useState<{ totalFromSales: number; linkedCount: number; unlinkedCount: number } | null>(null);
  const [creatingSupplier, setCreatingSupplier] = useState<string | null>(null);
  
  // Comparison data
  const [comparisonData, setComparisonData] = useState<any>(null);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);
  const [comparisonError, setComparisonError] = useState<string>('');
  
  // Data preview (validation before AI)
  const [previewData, setPreviewData] = useState<any>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string>('');
  
  // Supplier creation from preview
  const [isCreatingSuppliers, setIsCreatingSuppliers] = useState(false);
  const [createdSuppliers, setCreatedSuppliers] = useState<string[]>([]);
  
  // Analysis background (for transparency)
  const [analysisBackground, setAnalysisBackground] = useState<{
    promptKey: string;
    promptVersion: number;
    runLabel: string;
    runNumber: number;
    model: string;
    temperature: number;
    computedFeatures: any;
  } | null>(null);
  
  const [currentSupplierIdx, setCurrentSupplierIdx] = useState(0);
  const [committedSuppliers, setCommittedSuppliers] = useState<SupplierCommitData[]>([]);
  
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitResults, setCommitResults] = useState<CreatedPO[]>([]);
  const [commitError, setCommitError] = useState<string>('');

  // Fetch seasons (same pattern as statistics pages)
  const { data: seasonsData } = useSWR('seasons:purchase', async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, year, is_current')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Season[];
  });
  const seasons = seasonsData || [];
  
  // Auto-select current season on load
  useEffect(() => {
    if (seasons.length > 0 && !selectedSeasonId) {
      const current = seasons.find(s => s.is_current);
      if (current) {
        setSelectedSeasonId(current.id);
      }
    }
  }, [seasons, selectedSeasonId]);

  // Handlers
  const handleFileUpload = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    
    setCsvFileName(file.name);
    const text = await file.text();
    const rows = parseCSV(text);
    setCsvData(rows);
    setImportError('');
  }, []);

  const handleImport = useCallback(async () => {
    if (csvData.length === 0) return;
    
    setIsImporting(true);
    setImportError('');
    
    try {
      const res = await fetch('/api/purchase/sales/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: csvData,
          seasonId: selectedSeasonId || null,
          name: `Import ${new Date().toISOString().split('T')[0]}`,
          fileName: csvFileName,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Import failed');
      }
      
      setImportId(data.importId);
      setImportStats(data.stats);
      setStep(2);
      
      // Auto-load preview to validate data
      loadPreview(data.importId);
      
      // Auto-load comparison if we have a comparison season
      if (comparisonSeasonId) {
        loadComparison(data.importId);
      }
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setIsImporting(false);
    }
  }, [csvData, selectedSeasonId, csvFileName, comparisonSeasonId]);

  // Load comparison data
  const loadComparison = useCallback(async (impId?: string) => {
    const targetImportId = impId || importId;
    if (!targetImportId) return;
    
    setIsLoadingComparison(true);
    setComparisonError('');
    
    try {
      const res = await fetch('/api/purchase/ai-suggestions/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId: targetImportId,
          seasonId: selectedSeasonId || null,
          comparisonSeasonId: comparisonSeasonId || null,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to load comparison');
      }
      
      setComparisonData(data.comparison);
    } catch (err: any) {
      setComparisonError(err.message);
    } finally {
      setIsLoadingComparison(false);
    }
  }, [importId, selectedSeasonId, comparisonSeasonId]);

  // Load data preview (validation before AI)
  const loadPreview = useCallback(async (impId?: string) => {
    const targetImportId = impId || importId;
    if (!targetImportId) return;
    
    setIsLoadingPreview(true);
    setPreviewError('');
    
    try {
      const res = await fetch('/api/purchase/ai-suggestions/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId: targetImportId,
          seasonId: selectedSeasonId || null,
          comparisonSeasonId: comparisonSeasonId || null,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to load preview');
      }
      
      setPreviewData(data.preview);
    } catch (err: any) {
      setPreviewError(err.message);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [importId, selectedSeasonId, comparisonSeasonId]);

  // Create a single supplier
  const handleCreateSingleSupplier = useCallback(async (supplierName: string) => {
    setIsCreatingSuppliers(true);
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: supplierName,
          active: true,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create supplier');
      }
      
      setCreatedSuppliers(prev => [...prev, supplierName]);
      
      // Refresh preview to update the new suppliers list
      loadPreview();
    } catch (err: any) {
      setPreviewError(`Failed to create supplier: ${err.message}`);
    } finally {
      setIsCreatingSuppliers(false);
    }
  }, [loadPreview]);

  // Create all new suppliers at once
  const handleCreateAllNewSuppliers = useCallback(async () => {
    if (!previewData?.newSuppliers?.suppliers) return;
    
    setIsCreatingSuppliers(true);
    const suppliersToCreate = previewData.newSuppliers.suppliers
      .filter((s: any) => !createdSuppliers.includes(s.name))
      .map((s: any) => s.name);
    
    try {
      let created = 0;
      for (const supplierName of suppliersToCreate) {
        const res = await fetch('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: supplierName,
            active: true,
          }),
        });
        
        if (res.ok) {
          setCreatedSuppliers(prev => [...prev, supplierName]);
          created++;
        }
      }
      
      console.log(`Created ${created} of ${suppliersToCreate.length} suppliers`);
      
      // Refresh preview to update the new suppliers list
      loadPreview();
    } catch (err: any) {
      setPreviewError(`Failed to create suppliers: ${err.message}`);
    } finally {
      setIsCreatingSuppliers(false);
    }
  }, [previewData, createdSuppliers, loadPreview]);

  const handleRunAI = useCallback(async () => {
    if (!importId) return;
    
    setIsRunningAI(true);
    setAiError('');
    
    try {
      const res = await fetch('/api/purchase/ai-suggestions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId,
          seasonId: selectedSeasonId || null,
          comparisonSeasonId: comparisonSeasonId || null,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'AI analysis failed');
      }
      
      // Store YoY analysis if available
      if (data.yoyAnalysis) {
        setYoyAnalysis(data.yoyAnalysis);
      }
      
      // Store unlinked suppliers info
      if (data.unlinkedSuppliers) {
        setUnlinkedSuppliers(data.unlinkedSuppliers);
      } else {
        setUnlinkedSuppliers([]);
      }
      if (data.suppliersCoverage) {
        setSuppliersCoverage(data.suppliersCoverage);
      }
      
      setAiOutput(data.suggestions);
      setPurchaseRunId(data.purchaseRunId);
      setAiStats({ tokensUsed: data.stats.tokensUsed, durationMs: data.stats.durationMs });
      
      // Store analysis background for transparency
      if (data.analysisBackground) {
        setAnalysisBackground(data.analysisBackground);
      }
      
      setStep(3);
      setCurrentSupplierIdx(0);
    } catch (err: any) {
      setAiError(err.message);
    } finally {
      setIsRunningAI(false);
    }
  }, [importId, selectedSeasonId, comparisonSeasonId]);

  // Create a new supplier from unlinked list
  const handleCreateSupplier = useCallback(async (supplierName: string) => {
    setCreatingSupplier(supplierName);
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: supplierName,
          active: true,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create supplier');
      }
      
      // Remove from unlinked list
      setUnlinkedSuppliers(prev => prev.filter(s => s.name !== supplierName));
      
      // Update coverage
      setSuppliersCoverage(prev => prev ? {
        ...prev,
        linkedCount: prev.linkedCount + 1,
        unlinkedCount: prev.unlinkedCount - 1,
      } : null);
      
    } catch (err: any) {
      alert(`Error creating supplier: ${err.message}`);
    } finally {
      setCreatingSupplier(null);
    }
  }, []);

  const handleSupplierApprove = useCallback((data: SupplierCommitData) => {
    setCommittedSuppliers(prev => [...prev, data]);
    
    if (currentSupplierIdx < (aiOutput?.suppliers.length || 0) - 1) {
      setCurrentSupplierIdx(prev => prev + 1);
    } else {
      // All suppliers reviewed, commit
      handleCommit([...committedSuppliers, data]);
    }
  }, [currentSupplierIdx, aiOutput, committedSuppliers]);

  const handleSupplierSkip = useCallback(() => {
    const supplier = aiOutput?.suppliers[currentSupplierIdx];
    if (!supplier) return;
    
    const skipData: SupplierCommitData = {
      supplier_name: supplier.supplier_name,
      supplier_id: supplier.supplier_id,
      lines: [],
      verdict: 'skipped',
    };
    
    setCommittedSuppliers(prev => [...prev, skipData]);
    
    if (currentSupplierIdx < (aiOutput?.suppliers.length || 0) - 1) {
      setCurrentSupplierIdx(prev => prev + 1);
    } else {
      handleCommit([...committedSuppliers, skipData]);
    }
  }, [currentSupplierIdx, aiOutput, committedSuppliers]);

  const handleCommit = useCallback(async (suppliers: SupplierCommitData[]) => {
    setIsCommitting(true);
    setCommitError('');
    
    try {
      const res = await fetch('/api/purchase/ai-suggestions/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchaseRunId,
          suppliers,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Commit failed');
      }
      
      setCommitResults(data.results);
      setStep(4);
    } catch (err: any) {
      setCommitError(err.message);
    } finally {
      setIsCommitting(false);
    }
  }, [purchaseRunId]);

  const handlePushToSpy = useCallback(async (poId: number) => {
    if (!selectedSeasonId) {
      alert('Please select a season first');
      return;
    }
    
    try {
      const res = await fetch('/api/push-app-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po_id: poId,
          season_id: selectedSeasonId,
        }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Push to SPY failed');
      }
      
      alert('Job queued successfully! Check the Jobs page for progress.');
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }, [selectedSeasonId]);

  const handleReset = useCallback(() => {
    setStep(1);
    setCsvData([]);
    setCsvFileName('');
    setImportId('');
    setImportStats(null);
    setAiOutput(null);
    setYoyAnalysis(null);
    setPurchaseRunId('');
    setCurrentSupplierIdx(0);
    setCommittedSuppliers([]);
    setCommitResults([]);
    setImportError('');
    setAiError('');
    setCommitError('');
  }, []);

  // Current supplier for review
  const currentSupplier = aiOutput?.suppliers[currentSupplierIdx];

    return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">AI Purchase Suggestions</h1>
        <p className="text-slate-500 text-sm mt-1">
          Upload sales data, let AI analyze and suggest orders by supplier
        </p>
            </div>

      <ProgressSteps
        currentStep={step}
        steps={['Upload Data', 'Analyze', 'Review Suppliers', 'Complete']}
      />

      {/* Step 1: Upload */}
      {step === 1 && (
      <Card>
        <CardHeader>
            <CardTitle>Upload Sales Data</CardTitle>
          <CardDescription>
              Upload a CSV file with in-season sales data (style, color, customer, quantities)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Current Season</label>
                <select
                  value={selectedSeasonId}
                  onChange={e => setSelectedSeasonId(e.target.value)}
                  className="w-full border rounded-md h-10 px-3 text-sm"
                >
                  <option value="">Select season...</option>
                  {seasons.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.year ? ` ${s.year}` : ''}{s.is_current ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Compare to (last year)</label>
                <select
                  value={comparisonSeasonId}
                  onChange={e => setComparisonSeasonId(e.target.value)}
                  className="w-full border rounded-md h-10 px-3 text-sm"
                >
                  <option value="">No comparison</option>
                  {seasons.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.year ? ` ${s.year}` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  For YoY index calculation (price + qty comparison)
                </p>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">CSV File</label>
              <Dropzone
                accept=".csv"
                onFiles={handleFileUpload}
                className="min-h-[120px] flex items-center justify-center"
              >
                {csvFileName ? (
                  <div className="text-center">
                    <div className="text-sm font-medium text-slate-900">{csvFileName}</div>
                    <div className="text-xs text-slate-500 mt-1">{csvData.length} rows parsed</div>
          </div>
                ) : (
                  <div className="text-center">
                    <div className="text-sm text-slate-600">Drop CSV file here or click to browse</div>
                    <div className="text-xs text-slate-400 mt-1">
                      Required: date, style_no, color, qty
            </div>
            </div>
                          )}
              </Dropzone>
            </div>

            {csvData.length > 0 && (
              <div className="bg-slate-50 rounded-md p-4">
                <div className="text-sm font-medium mb-2">Preview (first 5 rows)</div>
            <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-1">Date</th>
                        <th className="text-left p-1">Style</th>
                        <th className="text-left p-1">Color</th>
                        <th className="text-left p-1">Customer</th>
                        <th className="text-right p-1">Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                      {csvData.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b border-slate-100">
                          <td className="p-1">{row.date}</td>
                          <td className="p-1 font-mono">{row.style_no}</td>
                          <td className="p-1">{row.color}</td>
                          <td className="p-1">{row.customer_name || row.customer_id || '-'}</td>
                          <td className="p-1 text-right">{row.qty}</td>
                                </tr>
                      ))}
                              </tbody>
                            </table>
          </div>
          </div>
            )}

            {importError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
                {importError}
              </div>
            )}

            <div className="flex justify-end">
                      <Button
                onClick={handleImport}
                disabled={csvData.length === 0 || isImporting}
                className="bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                {isImporting ? 'Importing...' : 'Import & Continue'}
                      </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Run AI Analysis */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Run AI Analysis</CardTitle>
            <CardDescription>
              Analyze sales data and generate purchase suggestions by supplier
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {importStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[#F5F3F0] rounded-md p-4 text-center">
                  <div className="text-2xl font-semibold text-[#8FA894]">{importStats.insertedRows}</div>
                  <div className="text-xs text-slate-500">Rows Imported</div>
        </div>
                <div className="bg-[#F5F3F0] rounded-md p-4 text-center">
                  <div className="text-2xl font-semibold text-[#B8A8D8]">{importStats.styleCount}</div>
                  <div className="text-xs text-slate-500">Unique Styles</div>
          </div>
                <div className="bg-[#F5F3F0] rounded-md p-4 text-center">
                  <div className="text-2xl font-semibold text-[#D4E4E8]">{importStats.customerCount}</div>
                  <div className="text-xs text-slate-500">Customers</div>
          </div>
                <div className="bg-[#F5F3F0] rounded-md p-4 text-center">
                  <div className="text-2xl font-semibold text-slate-700">{importStats.totalQty.toLocaleString()}</div>
                  <div className="text-xs text-slate-500">Total Units</div>
                  </div>
                    </div>
                              )}

            {importStats?.dateRange && (
              <div className="text-sm text-slate-600">
                Date range: <span className="font-medium">{importStats.dateRange.start}</span> to{' '}
                <span className="font-medium">{importStats.dateRange.end}</span>
              </div>
            )}

            {/* Data Validation Preview */}
            {isLoadingPreview && (
              <div className="bg-slate-50 border rounded-md p-4 text-center text-slate-500">
                Loading data preview...
              </div>
            )}
            {previewError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
                {previewError}
              </div>
            )}
            {previewData && (
              <div className="space-y-4">
                {/* Validation Errors */}
                {previewData.validation.errors.length > 0 && (
                  <div className="bg-red-50 border border-red-300 rounded-md p-4">
                    <div className="font-medium text-red-800 mb-2">⛔ Data Issues (must fix before AI analysis)</div>
                    <ul className="text-sm text-red-700 space-y-1">
                      {previewData.validation.errors.map((e: string, i: number) => (
                        <li key={i}>• {e}</li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Validation Warnings */}
                {previewData.validation.warnings.length > 0 && (
                  <div className="bg-amber-50 border border-amber-300 rounded-md p-4">
                    <div className="font-medium text-amber-800 mb-2">⚠️ Warnings</div>
                    <ul className="text-sm text-amber-700 space-y-1">
                      {previewData.validation.warnings.map((w: string, i: number) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* New Suppliers Detected */}
                {previewData.newSuppliers?.count > 0 && (
                  <div className="bg-purple-50 border border-purple-300 rounded-md p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="font-medium text-purple-800">
                          🆕 New Suppliers Detected ({previewData.newSuppliers.count})
                        </div>
                        <p className="text-sm text-purple-600 mt-1">
                          These suppliers are in your styles but not in the suppliers table. Create them for MOQ and lead time tracking.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={handleCreateAllNewSuppliers}
                        disabled={isCreatingSuppliers}
                        className="bg-purple-600 hover:bg-purple-700 text-white"
                      >
                        {isCreatingSuppliers ? 'Creating...' : `Create All (${previewData.newSuppliers.count})`}
                      </Button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-purple-500 border-b border-purple-200">
                            <th className="pb-2">Supplier Name</th>
                            <th className="pb-2 text-right">Styles</th>
                            <th className="pb-2 text-right">Sales Qty</th>
                            <th className="pb-2 text-right">Sales Amount</th>
                            <th className="pb-2 text-center">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.newSuppliers.suppliers.map((s: any, i: number) => (
                            <tr key={i} className="border-b border-purple-100">
                              <td className="py-2 font-medium text-purple-900">{s.name}</td>
                              <td className="py-2 text-right">{s.styleCount}</td>
                              <td className="py-2 text-right">{s.salesQty.toLocaleString()}</td>
                              <td className="py-2 text-right">{s.salesAmount.toLocaleString()}</td>
                              <td className="py-2 text-center">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleCreateSingleSupplier(s.name)}
                                  disabled={isCreatingSuppliers || createdSuppliers.includes(s.name)}
                                  className="text-xs border-purple-300 text-purple-700 hover:bg-purple-100"
                                >
                                  {createdSuppliers.includes(s.name) ? '✓ Created' : 'Create'}
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Supplier Breakdown from DB */}
                <div className="bg-slate-50 border rounded-md p-4">
                  <div className="font-medium text-sm mb-3">📊 Supplier Coverage (from Database)</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500 border-b">
                          <th className="pb-2">Supplier</th>
                          <th className="pb-2 text-right">Styles</th>
                          <th className="pb-2 text-right">Qty</th>
                          <th className="pb-2 text-right">Customers</th>
                          <th className="pb-2 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.supplierBreakdown.map((s: any, i: number) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className={`py-2 font-medium ${!s.hasSupplier ? 'text-red-600' : ''}`}>
                              {s.name}
                            </td>
                            <td className="py-2 text-right">{s.styleCount}</td>
                            <td className="py-2 text-right">{s.qty.toLocaleString()}</td>
                            <td className="py-2 text-right">{s.customerCount}</td>
                            <td className="py-2 text-center">
                              {s.hasSupplier ? (
                                <span className="text-green-600">✓</span>
                              ) : (
                                <span className="text-red-600">✗</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 text-xs text-slate-500">
                    Styles in DB: {previewData.stylesCoverage.foundInDb} of {previewData.stylesCoverage.total}
                    {previewData.stylesCoverage.notFoundInDb > 0 && (
                      <span className="text-amber-600"> ({previewData.stylesCoverage.notFoundInDb} not found)</span>
                    )}
                  </div>
                </div>

                {/* Comparison Season Status */}
                {previewData.comparisonSeason && (
                  <div className={`border rounded-md p-4 ${
                    previewData.comparisonSeason.dataSource === 'none' 
                      ? 'bg-red-50 border-red-300' 
                      : 'bg-green-50 border-green-300'
                  }`}>
                    <div className="font-medium text-sm mb-2">
                      📈 Comparison Season: {previewData.comparisonSeason.seasonName}
                    </div>
                    {previewData.comparisonSeason.dataSource === 'none' ? (
                      <div className="text-sm text-red-700">
                        ❌ No data found! Check if season_statistics or sales_stats has data for this season.
                      </div>
                    ) : (
                      <div className="text-sm text-green-700">
                        ✓ Data source: <span className="font-medium">{previewData.comparisonSeason.dataSource}</span>
                        <span className="ml-3">
                          {previewData.comparisonSeason[previewData.comparisonSeason.dataSource === 'season_statistics' ? 'seasonStatistics' : 'salesStats'].totalQty.toLocaleString()} qty
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* CSV Data Summary by Supplier */}
            {csvData.length > 0 && (
              <div className="bg-slate-50 border rounded-md p-4">
                <div className="font-medium text-sm mb-3">📦 Data by Supplier</div>
            <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b">
                        <th className="pb-2">Supplier</th>
                        <th className="pb-2 text-right">Styles</th>
                        <th className="pb-2 text-right">Qty</th>
                        <th className="pb-2 text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                      {(() => {
                        // Aggregate by supplier from csvData
                        const bySupplier: Record<string, { styles: Set<string>; qty: number; amount: number }> = {};
                        for (const row of csvData) {
                          const sup = row.supplier || '(Unknown)';
                          if (!bySupplier[sup]) {
                            bySupplier[sup] = { styles: new Set(), qty: 0, amount: 0 };
                          }
                          bySupplier[sup].styles.add(`${row.style_no}|${row.color}`);
                          bySupplier[sup].qty += Number(row.qty) || 0;
                          bySupplier[sup].amount += Number(row.net_amount) || 0;
                        }
                        const sorted = Object.entries(bySupplier).sort((a, b) => b[1].qty - a[1].qty);
                        return sorted.map(([supplier, data]) => (
                          <tr key={supplier} className="border-b border-slate-100">
                            <td className="py-2 font-medium">{supplier}</td>
                            <td className="py-2 text-right">{data.styles.size}</td>
                            <td className="py-2 text-right">{data.qty.toLocaleString()}</td>
                            <td className="py-2 text-right">{Math.round(data.amount).toLocaleString()}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                                </div>
                                </div>
            )}

            {comparisonSeasonId && (
              <div className="bg-[#D4E4E8]/30 border border-[#D4E4E8] rounded-md p-4">
                <div className="flex items-start gap-3">
                  <div className="text-xl">📊</div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">YoY Comparison</div>
                      {!comparisonData && !isLoadingComparison && (
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => loadComparison()}
                          className="text-xs"
                        >
                          Load Details
                        </Button>
                      )}
                                </div>
                    {isLoadingComparison && <p className="text-xs text-slate-500 mt-1">Loading comparison data...</p>}
                    {comparisonError && <p className="text-xs text-red-500 mt-1">{comparisonError}</p>}
                                </div>
                                </div>
                
                {/* Comparison Overview */}
                {comparisonData && (
                  <div className="mt-4 space-y-4">
                    {/* Overall stats */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                      <div className="bg-white rounded-md p-3">
                        <div className="text-lg font-semibold text-[#8FA894]">
                          {comparisonData.overall.currentSeason.qty.toLocaleString()}
                                </div>
                        <div className="text-xs text-slate-500">Current Qty</div>
                                </div>
                      <div className="bg-white rounded-md p-3">
                        <div className="text-lg font-semibold text-slate-600">
                          {comparisonData.overall.lastSeasonTotal.qty.toLocaleString()}
                                </div>
                        <div className="text-xs text-slate-500">Last Year Total</div>
                                </div>
                      <div className="bg-white rounded-md p-3">
                        <div className={`text-lg font-semibold ${comparisonData.overall.gapToTarget.qty > 0 ? 'text-red-500' : 'text-green-500'}`}>
                          {comparisonData.overall.gapToTarget.qtyPercent}
                                        </div>
                        <div className="text-xs text-slate-500">vs Target</div>
                                </div>
                      <div className="bg-white rounded-md p-3">
                        <div className="text-lg font-semibold text-[#B8A8D8]">
                          {comparisonData.overall.weeksCovered}
                                        </div>
                        <div className="text-xs text-slate-500">Weeks Data</div>
                      </div>
                    </div>
                    
                    {/* By Country */}
                    {comparisonData.byCountry.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-slate-600 mb-2">By Country</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {comparisonData.byCountry.slice(0, 4).map((c: any) => (
                            <div key={c.country} className="bg-white rounded-md p-2 text-xs">
                              <div className="font-medium">{c.country}</div>
                              <div className="text-slate-500">{c.qty.toLocaleString()} pcs</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Top 10 Styles */}
                    {comparisonData.top10Styles.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-slate-600 mb-2">Top 10 Styles</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-slate-500 border-b">
                                <th className="pb-1">Style</th>
                                <th className="pb-1">Color</th>
                                <th className="pb-1 text-right">Qty</th>
                                <th className="pb-1 text-right">Customers</th>
                                </tr>
                            </thead>
                            <tbody>
                              {comparisonData.top10Styles.map((s: any, i: number) => (
                                <tr key={i} className="border-b border-slate-100">
                                  <td className="py-1 font-medium" title={s.style_no}>
                                    {s.style_name || s.style_no}
                                  </td>
                                  <td className="py-1">{s.color}</td>
                                  <td className="py-1 text-right">{s.qty.toLocaleString()}</td>
                                  <td className="py-1 text-right">{s.customerCount}</td>
                                </tr>
                              ))}
                              </tbody>
                            </table>
            </div>
          </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Customer Analysis - from comparison API */}
            {comparisonData && (comparisonData as any).customerAnalysis && (
              <div className="bg-[#C5D5CA]/30 border border-[#C5D5CA] rounded-md p-4">
                <div className="font-medium text-sm mb-3">👥 Customer Performance vs Last Year</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center mb-4">
                  <div className="bg-white rounded-md p-3">
                    <div className="text-lg font-semibold text-[#8FA894]">
                      {(comparisonData as any).customerAnalysis.visited}
                    </div>
                    <div className="text-xs text-slate-500">Visited</div>
                  </div>
                  <div className="bg-white rounded-md p-3">
                    <div className="text-lg font-semibold text-slate-600">
                      {(comparisonData as any).customerAnalysis.shouldVisit}
                    </div>
                    <div className="text-xs text-slate-500">Should Visit</div>
                  </div>
                  <div className="bg-white rounded-md p-3">
                    <div className={`text-lg font-semibold ${(comparisonData as any).customerAnalysis.visitRate >= 80 ? 'text-green-600' : (comparisonData as any).customerAnalysis.visitRate >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                      {(comparisonData as any).customerAnalysis.visitRate}%
                    </div>
                    <div className="text-xs text-slate-500">Visit Rate</div>
                  </div>
                  <div className="bg-white rounded-md p-3">
                    <div className="text-lg font-semibold text-amber-600">
                      {(comparisonData as any).customerAnalysis.notVisited}
                    </div>
                    <div className="text-xs text-slate-500">Not Visited Yet</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs text-slate-600">
                  <div>
                    <span className="font-medium">Remaining Potential:</span>{' '}
                    {(comparisonData as any).customerAnalysis.notVisitedPotential.qty.toLocaleString()} pcs
                  </div>
                  <div>
                    <span className="font-medium text-red-600">Lost (Nulled):</span>{' '}
                    {(comparisonData as any).customerAnalysis.lostFromNulled.qty.toLocaleString()} pcs
                  </div>
                  <div>
                    <span className="font-medium text-red-600">Lost (Closed):</span>{' '}
                    {(comparisonData as any).customerAnalysis.lostFromClosed.qty.toLocaleString()} pcs
                  </div>
                </div>
              </div>
            )}

            {/* Sales Rep Analysis - from comparison API */}
            {comparisonData && (comparisonData as any).salesRepAnalysis?.length > 0 && (
              <div className="bg-[#B8A8D8]/20 border border-[#B8A8D8] rounded-md p-4">
                <div className="font-medium text-sm mb-3">👔 Sales Rep Performance</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b">
                        <th className="pb-2">Sales Rep</th>
                        <th className="pb-2 text-right">This Year</th>
                        <th className="pb-2 text-right">Last Year</th>
                        <th className="pb-2 text-right">Index</th>
                        <th className="pb-2 text-center">Visited</th>
                        <th className="pb-2">Top 3 Styles</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(comparisonData as any).salesRepAnalysis.map((rep: any, i: number) => (
                        <tr key={i} className="border-b border-slate-100">
                          <td className="py-2 font-medium">{rep.salesRep}</td>
                          <td className="py-2 text-right">{rep.thisYearQty.toLocaleString()}</td>
                          <td className="py-2 text-right text-slate-500">{rep.lastYearQty.toLocaleString()}</td>
                          <td className="py-2 text-right">
                            {rep.indexQty !== null ? (
                              <span className={rep.indexQty >= 100 ? 'text-green-600' : rep.indexQty >= 75 ? 'text-amber-600' : 'text-red-600'}>
                                {rep.indexQty}%
                              </span>
                            ) : '-'}
                          </td>
                          <td className="py-2 text-center">
                            <span className={rep.visitRate >= 80 ? 'text-green-600' : rep.visitRate >= 50 ? 'text-amber-600' : 'text-red-600'}>
                              {rep.customersVisited}/{rep.customersShouldVisit}
                            </span>
                            <span className="text-slate-400 ml-1">({rep.visitRate}%)</span>
                          </td>
                          <td className="py-2">
                            {rep.topStyles.slice(0, 3).map((s: any, j: number) => (
                              <span key={j} className="inline-block bg-slate-100 rounded px-1 mr-1 mb-1" title={`${s.style_no} ${s.color}: ${s.qty} pcs`}>
                                {s.style_name || s.style_no}
                              </span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="bg-[#F5F3F0] rounded-md p-4">
              <div className="flex items-start gap-3">
                <div className="text-xl">🤖</div>
                <div>
                  <div className="font-medium text-sm">What happens next?</div>
                  <ul className="text-xs text-slate-600 mt-1 space-y-1">
                    <li>• Sales data is aggregated by supplier, style, and color</li>
                    <li>• Customer data is pseudonymized before sending to AI</li>
                    {comparisonSeasonId && <li>• YoY index calculated from customer totals (nulled/closed factored in)</li>}
                    <li>• AI analyzes patterns and suggests order quantities</li>
                    <li>• You review and adjust suggestions per supplier</li>
                  </ul>
                </div>
            </div>
          </div>

            {aiError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
                {aiError}
              </div>
            )}
            
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={() => loadPreview()}
                  disabled={isLoadingPreview}
                  size="sm"
                >
                  {isLoadingPreview ? 'Checking...' : '🔄 Refresh Preview'}
                </Button>
                <Button
                  onClick={handleRunAI}
                  disabled={isRunningAI || (previewData?.validation?.errors?.length > 0)}
                  className="bg-[#B8A8D8] hover:bg-[#B8A8D8]/90"
                >
                  {isRunningAI ? 'Analyzing...' : 'Run AI Analysis'}
                </Button>
              </div>
            </div>
        </CardContent>
      </Card>
      )}

      {/* Step 3: Review Suppliers */}
      {step === 3 && aiOutput && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">
                Reviewing supplier {currentSupplierIdx + 1} of {aiOutput.suppliers.length}
                  </div>
              {aiStats && (
                <div className="text-xs text-slate-400 mt-1">
                  Analysis took {(aiStats.durationMs / 1000).toFixed(1)}s • {aiStats.tokensUsed.toLocaleString()} tokens
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-[#8FA894]">{aiOutput.total_units.toLocaleString()}</div>
              <div className="text-xs text-slate-500">total suggested units</div>
            </div>
          </div>

          {aiOutput.overall_summary && (
            <div className="bg-[#F5F3F0] rounded-md p-4 text-sm">
              {aiOutput.overall_summary}
                  </div>
          )}

          {yoyAnalysis && (
            <div className="bg-[#D4E4E8]/20 border border-[#D4E4E8] rounded-md p-4">
              <div className="text-sm font-medium mb-3">Year-over-Year Analysis</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                <div>
                  <div className="text-xl font-semibold text-[#8FA894]">{yoyAnalysis.aggregatedIndex}</div>
                  <div className="text-xs text-slate-500">Index vs Last Year</div>
                </div>
                    <div>
                  <div className="text-xl font-semibold text-slate-700">{yoyAnalysis.currentSeason?.visitRate}</div>
                  <div className="text-xs text-slate-500">Customer Visit Rate</div>
      </div>
                <div>
                  <div className="text-xl font-semibold text-[#B8A8D8]">{yoyAnalysis.remainingPotential?.projectedQty?.toLocaleString()}</div>
                  <div className="text-xs text-slate-500">Remaining Potential (qty)</div>
      </div>
                <div>
                  <div className="text-xl font-semibold text-amber-600">{yoyAnalysis.nulledThisYear?.count || 0}</div>
                  <div className="text-xs text-slate-500">Nulled Customers</div>
            </div>
        </div>
              {(yoyAnalysis.nulledThisYear?.lostQty > 0 || yoyAnalysis.permanentlyClosed?.lostQty > 0) && (
                <div className="mt-3 pt-3 border-t border-[#D4E4E8] text-xs text-slate-600">
                  <span className="font-medium">Lost potential: </span>
                  {yoyAnalysis.nulledThisYear?.lostQty > 0 && (
                    <span>{yoyAnalysis.nulledThisYear.lostQty.toLocaleString()} units from nulled customers</span>
                  )}
                  {yoyAnalysis.nulledThisYear?.lostQty > 0 && yoyAnalysis.permanentlyClosed?.lostQty > 0 && <span>, </span>}
                  {yoyAnalysis.permanentlyClosed?.lostQty > 0 && (
                    <span>{yoyAnalysis.permanentlyClosed.lostQty.toLocaleString()} units from closed customers</span>
              )}
            </div>
              )}
          </div>
          )}

          {aiOutput.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
              {aiOutput.warnings.map((w, i) => (
                <div key={i} className="text-sm text-amber-800">⚠️ {w}</div>
                ))}
            </div>
          )}

          {/* Unlinked Suppliers Warning */}
          {unlinkedSuppliers.length > 0 && (
            <Card className="border-orange-300 bg-orange-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-orange-800 flex items-center gap-2">
                  ⚠️ Unlinked Suppliers ({unlinkedSuppliers.length})
                </CardTitle>
                <CardDescription className="text-orange-700 text-sm">
                  These suppliers from your sales data don't have master data (MOQ, lead time). 
                  The AI can still make suggestions, but without supplier constraints.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {unlinkedSuppliers.map((s) => (
                    <div key={s.name} className="flex items-center justify-between bg-white rounded-md p-3 border border-orange-200">
                      <div>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-slate-500">
                          {s.styleCount} styles • {s.totalQty.toLocaleString()} pcs
                        </div>
                      </div>
            <Button
                        size="sm"
              variant="outline"
                        disabled={creatingSupplier === s.name}
                        onClick={() => handleCreateSupplier(s.name)}
                        className="border-orange-300 text-orange-700 hover:bg-orange-100"
                      >
                        {creatingSupplier === s.name ? 'Creating...' : '+ Create Supplier'}
            </Button>
          </div>
                  ))}
          </div>
                {suppliersCoverage && (
                  <div className="mt-3 pt-3 border-t border-orange-200 text-xs text-orange-700">
                    Supplier coverage: {suppliersCoverage.linkedCount} of {suppliersCoverage.totalFromSales} suppliers have master data
                  </div>
                )}
        </CardContent>
      </Card>
          )}

          {/* Analysis Background (Transparency Panel) */}
          {analysisBackground && (
            <details className="bg-slate-50 border rounded-md">
              <summary className="p-3 cursor-pointer text-sm font-medium text-slate-700 hover:bg-slate-100">
                📋 Analysis Background (click to expand)
              </summary>
              <div className="p-4 pt-0 space-y-3 text-xs">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="text-slate-500">Run Label</div>
                    <div className="font-medium">{analysisBackground.runLabel}</div>
        </div>
                    <div>
                    <div className="text-slate-500">Run Number</div>
                    <div className="font-medium">#{analysisBackground.runNumber}</div>
      </div>
                  <div>
                    <div className="text-slate-500">Prompt</div>
                    <div className="font-medium">{analysisBackground.promptKey} v{analysisBackground.promptVersion}</div>
      </div>
                  <div>
                    <div className="text-slate-500">Model</div>
                    <div className="font-medium">{analysisBackground.model} (temp: {analysisBackground.temperature})</div>
            </div>
        </div>
                
                {analysisBackground.computedFeatures && (
                  <div>
                    <div className="text-slate-500 mb-2">Computed Features Snapshot</div>
                    <div className="bg-white border rounded p-2 max-h-48 overflow-auto">
                      <pre className="text-[10px] text-slate-600">
                        {JSON.stringify(analysisBackground.computedFeatures, null, 2)}
                      </pre>
              </div>
                  </div>
                )}
              </div>
            </details>
          )}

          {currentSupplier && (
            <SupplierReviewCard
              supplier={currentSupplier}
              onApprove={handleSupplierApprove}
              onSkip={handleSupplierSkip}
              isLast={currentSupplierIdx === aiOutput.suppliers.length - 1}
            />
          )}

          {isCommitting && (
            <div className="text-center py-8">
              <div className="animate-spin h-8 w-8 border-4 border-[#8FA894] border-t-transparent rounded-full mx-auto mb-4" />
              <div className="text-sm text-slate-600">Creating draft purchase orders...</div>
        </div>
          )}

          {commitError && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
              {commitError}
      </div>
          )}
        </div>
      )}

      {/* Step 4: Summary */}
      {step === 4 && (
      <Card>
          <CardHeader className="bg-[#C5D5CA]/30">
            <CardTitle className="flex items-center gap-2">
              <span className="text-2xl">✓</span>
              Purchase Orders Created
            </CardTitle>
          <CardDescription>
              Review and push orders to SPY when ready
          </CardDescription>
        </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left p-3 font-medium">Supplier</th>
                  <th className="text-left p-3 font-medium">PO Number</th>
                  <th className="text-right p-3 font-medium">Items</th>
                  <th className="text-right p-3 font-medium">Qty</th>
                  <th className="text-center p-3 font-medium">Status</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {commitResults.map((result, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-3">{result.supplier}</td>
                    <td className="p-3 font-mono text-xs">{result.poNo || '-'}</td>
                    <td className="p-3 text-right">{result.itemCount}</td>
                    <td className="p-3 text-right">{result.totalQty.toLocaleString()}</td>
                    <td className="p-3 text-center">
                      <Badge className={
                        result.status === 'created' ? 'bg-green-100 text-green-700' :
                        result.status === 'skipped' ? 'bg-slate-100 text-slate-600' :
                        'bg-red-100 text-red-700'
                      }>
                        {result.status}
                      </Badge>
                    </td>
                    <td className="p-3 text-right">
                      {result.status === 'created' && result.poId && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePushToSpy(result.poId!)}
                        >
                          Push to SPY
                </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="p-4 border-t bg-slate-50 flex justify-between">
              <Button variant="outline" onClick={handleReset}>
                    Start New Order
                  </Button>
              <Button
                variant="outline"
                onClick={() => window.location.href = '/purchase/app-pos'}
              >
                View All App POs
                  </Button>
      </div>
        </CardContent>
      </Card>
      )}
    </div>
  );
}
