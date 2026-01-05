'use client';
import React, { useState, useCallback, useMemo } from 'react';
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
  start_date?: string;
  end_date?: string;
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
  supplier?: string;
  qty: number | string;
  net_amount?: number | string;
  currency?: string;
  order_ref?: string;
  channel?: string;
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
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  
  const headerLine = lines[0]!;
  const headers = headerLine.split(/[,;\t]/).map(h => h.trim().toLowerCase().replace(/[^a-z0-9_ ]/g, '_').replace(/\s+/g, '_'));
  
  // First pass: collect all raw rows
  const rawRows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const values = line.split(/[,;\t]/).map(v => v.trim().replace(/^["'=]|["']$/g, '')); // Also strip leading = from Excel
    
    const row: any = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    
    // Map column variations to standard names
    // Your columns: Date, Style No, Color, Size Quantity Ordered, Customer Name, Country, Salesperson, Sales Price Exchange Total
    const mapped = {
      date: row.date || row.dato || row.invoice_date || '',
      customer_name: row.customer_name || row.customer || row.kunde || row.debitor || '',
      customer_id: row.customer_id || row.debitor_nr || '',
      country: row.country || row.land || '',
      sales_rep: row.sales_rep || row.salesperson || row.saelger || '',
      style_no: row.style_no || row.style || row.varenr || row.item_no || '',
      style_name: row.style_name || row.varenavn || row.description || '',
      color: row.color || row.farve || row.colour || '',
      supplier: row.supplier || row.leverandor || '',
      // Handle "Size Quantity Ordered" column
      qty: Number(row.size_quantity_ordered || row.qty || row.quantity || row.antal || row.pcs || 0) || 0,
      // Handle "Sales Price Exchange Total" - may be in cents
      net_amount: Number(row.sales_price_exchange_total || row.net_amount || row.amount || row.belob || row.value || 0) || 0,
      currency: row.currency || row.valuta || 'DKK',
      order_ref: row.order_ref || row.invoice || row.faktura || '',
      channel: row.channel || row.kanal || '',
    };
    
    if (mapped.style_no && mapped.color) {
      rawRows.push(mapped);
    }
  }
  
  // Detect if amounts are in cents (if average > 10000, likely cents)
  const avgAmount = rawRows.reduce((sum, r) => sum + r.net_amount, 0) / (rawRows.length || 1);
  const amountDivisor = avgAmount > 10000 ? 100 : 1; // Convert cents to currency
  
  // Aggregate by date + customer + style + color (since CSV is at size level)
  const aggregated = new Map<string, CSVRow>();
  
  for (const row of rawRows) {
    // Key by date + customer + style + color
    const key = `${row.date}|${row.customer_name || row.customer_id}|${row.style_no}|${row.color}`;
    
    if (aggregated.has(key)) {
      const existing = aggregated.get(key)!;
      existing.qty = (Number(existing.qty) || 0) + (Number(row.qty) || 0);
      existing.net_amount = (Number(existing.net_amount) || 0) + (Number(row.net_amount) || 0);
    } else {
      aggregated.set(key, {
        ...row,
        qty: Number(row.qty) || 0,
        net_amount: (Number(row.net_amount) || 0) / amountDivisor,
      });
    }
  }
  
  // Apply amount divisor to all aggregated rows if we detected cents
  const rows = Array.from(aggregated.values());
  if (amountDivisor > 1) {
    for (const row of rows) {
      row.net_amount = Number(row.net_amount) / amountDivisor;
    }
  }
  
  console.log(`[CSV Parser] ${rawRows.length} raw rows → ${rows.length} aggregated rows (amounts ${amountDivisor === 100 ? 'converted from cents' : 'kept as-is'})`);
  
  return rows;
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
                    <td className="p-3 font-mono text-xs">{line.style_no}</td>
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
  
  const [currentSupplierIdx, setCurrentSupplierIdx] = useState(0);
  const [committedSuppliers, setCommittedSuppliers] = useState<SupplierCommitData[]>([]);
  
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitResults, setCommitResults] = useState<CreatedPO[]>([]);
  const [commitError, setCommitError] = useState<string>('');

  // Fetch seasons
  const { data: seasonsData } = useSWR('seasons', async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date')
      .order('start_date', { ascending: false });
    if (error) throw error;
    return data as Season[];
  });
  const seasons = seasonsData || [];

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
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setIsImporting(false);
    }
  }, [csvData, selectedSeasonId, csvFileName]);

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
      
      setAiOutput(data.suggestions);
      setPurchaseRunId(data.purchaseRunId);
      setAiStats({ tokensUsed: data.stats.tokensUsed, durationMs: data.stats.durationMs });
      setStep(3);
      setCurrentSupplierIdx(0);
    } catch (err: any) {
      setAiError(err.message);
    } finally {
      setIsRunningAI(false);
    }
  }, [importId, selectedSeasonId, comparisonSeasonId]);

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
                <label className="block text-sm font-medium text-slate-700 mb-2">Current Season (optional)</label>
                <select
                  value={selectedSeasonId}
                  onChange={e => setSelectedSeasonId(e.target.value)}
                  className="w-full border rounded-md h-10 px-3 text-sm"
                >
                  <option value="">No season selected</option>
                  {seasons.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
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
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  For YoY index calculation
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

            {comparisonSeasonId && (
              <div className="bg-[#D4E4E8]/30 border border-[#D4E4E8] rounded-md p-4">
                <div className="flex items-start gap-3">
                  <div className="text-xl">📊</div>
                  <div>
                    <div className="font-medium text-sm">YoY Comparison Enabled</div>
                    <p className="text-xs text-slate-600 mt-1">
                      AI will compare current season against last season's customer totals (qty + price).
                      Nulled and permanently closed customers will be factored in.
                    </p>
                  </div>
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
              <Button
                onClick={handleRunAI}
                disabled={isRunningAI}
                className="bg-[#B8A8D8] hover:bg-[#B8A8D8]/90"
              >
                {isRunningAI ? 'Analyzing...' : 'Run AI Analysis'}
              </Button>
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
