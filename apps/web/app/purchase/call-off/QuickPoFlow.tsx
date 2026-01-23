'use client';

import React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Info, Loader2, AlertTriangle, Check, Clock, Zap, Package, Palette, ThumbsUp, ThumbsDown } from 'lucide-react';

// ==================== Types ====================

interface ParsedCommand {
  line_number: number;
  original_text: string;
  style_no: string | null;
  style_name: string | null;
  color: string | null;
  command_type: 'order' | 'color_breakdown' | 'wait' | 'stock_fix' | 'unknown';
  quantity: number | null;
  wait_weeks: number | null;
  parsed_successfully: boolean;
  parse_error: string | null;
}

interface SizeFactors {
  baseWeight: number;
  historicalWeight: number;
  netNeedWeight: number;
  combinedWeight: number;
  quantity: number;
}

interface OrderPlan {
  style_no: string;
  style_name: string;
  color: string;
  total_qty: number;
  size_breakdown: Record<string, number>;
  size_source: 'smart_hybrid' | 'historical_only' | 'default_only' | 'historical' | 'default_assortment';
  size_factors?: Record<string, SizeFactors>;
  current_stock: number;
  current_on_order: number;
  net_need_before: number;
  net_need_after: number;
  warning: string | null;
  action: 'create_po' | 'skip_overstocked' | 'review_needed';
  stock_table?: StockTableData;
}

interface StockTableRow {
  section: string;
  row_label: string | null;
  sizes: string[];
  values: number[];
  total: number;
}

interface StockTableData {
  sizes: string[];
  stock: number[];
  soldSum: number[];
  soldRows: StockTableRow[];
  purchaseSum: number[];
  purchaseRows: StockTableRow[];
  netNeed: number[];
  stockTotal: number;
  soldTotal: number;
  purchaseTotal: number;
  netNeedTotal: number;
}

interface ColorStockData {
  color: string;
  sizes: string[];
  stock: number[];
  stockTotal: number;
  sold: number[];
  soldTotal: number;
  purchase: number[];
  purchaseTotal: number;
  netNeed: number[];
  netNeedTotal: number;
  historicalSales?: number;
}

interface ColorDistItem {
  qty: number;
  pct: number;
  stockData: ColorStockData;
  newNetNeed: number;
  isTarget?: boolean;
  newOrderBySize?: number[];
  newNetNeedBySize?: number[];
}

interface ColorBreakdownPlan {
  style_no: string;
  style_name: string;
  source_color: string;
  target_quantity: number;
  color_distribution: Record<string, ColorDistItem>;
  source_stock_needed: number;
  source_po_available: number;   // WHITE WEFT PO's available to color
  source_po_remaining: number;   // WHITE WEFT PO's remaining after coloring
  action: string;
  look_sales?: boolean;
  stock_table?: StockTableData;
  white_weft_stock_table?: StockTableData; // WHITE WEFT source material stock levels
  white_weft_remaining_by_size?: number[]; // WHITE WEFT stock after colors are deducted
}

interface WaitReminder {
  style_no: string;
  color: string;
  weeks: number;
  reminder_date: string;
}

interface StockFixSuggestion {
  style_no: string;
  color: string;
  current_curve: Record<string, number>;
  suggested_additions: Record<string, number>;
  target_curve: Record<string, number>;
  total_to_add: number;
  reasoning: string;
}

interface QuickPoResult {
  parsed_commands: ParsedCommand[];
  order_plans: OrderPlan[];
  color_breakdown_plans: ColorBreakdownPlan[];
  wait_reminders: WaitReminder[];
  stock_fix_suggestions: StockFixSuggestion[];
  summary: {
    total_orders: number;
    total_units_to_order: number;
    total_coloring_jobs: number;
    total_reminders: number;
    warnings: string[];
  };
  promptVersion?: string;
}

// ==================== Month Picker ====================

function MonthYearPicker({
  selectedMonths,
  setSelectedMonths
}: {
  selectedMonths: string[];
  setSelectedMonths: (months: string[]) => void;
}) {
  const [selectedYear, setSelectedYear] = React.useState(() => new Date().getFullYear());
  
  const months = [
    { value: '01', label: 'Jan' },
    { value: '02', label: 'Feb' },
    { value: '03', label: 'Mar' },
    { value: '04', label: 'Apr' },
    { value: '05', label: 'May' },
    { value: '06', label: 'Jun' },
    { value: '07', label: 'Jul' },
    { value: '08', label: 'Aug' },
    { value: '09', label: 'Sep' },
    { value: '10', label: 'Oct' },
    { value: '11', label: 'Nov' },
    { value: '12', label: 'Dec' },
  ];
  
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  
  const toggleMonth = (yearMonth: string) => {
    if (selectedMonths.includes(yearMonth)) {
      setSelectedMonths(selectedMonths.filter(m => m !== yearMonth));
    } else {
      setSelectedMonths([...selectedMonths, yearMonth].sort());
    }
  };
  
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-slate-700">Year:</label>
        <div className="flex gap-1">
          {years.map(year => (
            <button
              key={year}
              type="button"
              onClick={() => setSelectedYear(year)}
              className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                selectedYear === year
                  ? 'bg-[#8FA894] text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {year}
            </button>
          ))}
        </div>
      </div>
      
      <div className="flex flex-wrap gap-1.5">
        {months.map(month => {
          const yearMonth = `${selectedYear}-${month.value}`;
          const isSelected = selectedMonths.includes(yearMonth);
          return (
            <button
              key={month.value}
              type="button"
              onClick={() => toggleMonth(yearMonth)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                isSelected
                  ? 'bg-[#8FA894] text-white ring-2 ring-[#8FA894] ring-offset-1'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {month.label}
            </button>
          );
        })}
      </div>
      
      {selectedMonths.length > 0 && (
        <p className="text-xs text-slate-500">
          Selected: {selectedMonths.map(m => {
            const [y, mon] = m.split('-');
            const d = new Date(Number(y), Number(mon) - 1);
            return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
          }).join(', ')}
        </p>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export default function QuickPoFlow({
  onAddWaitReminders
}: {
  onAddWaitReminders?: (reminders: WaitReminder[]) => void;
}) {
  const supabase = createClientComponentClient();
  
  // State
  const [commandText, setCommandText] = React.useState('');
  const [selectedMonths, setSelectedMonths] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<QuickPoResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creatingPos, setCreatingPos] = React.useState(false);
  const [createResult, setCreateResult] = React.useState<{ success: number; failed: number } | null>(null);
  const [feedbackSent, setFeedbackSent] = React.useState<Record<string, 'correct' | 'incorrect'>>({});
  const [sendingFeedback, setSendingFeedback] = React.useState<string | null>(null);
  const [correctionModal, setCorrectionModal] = React.useState<{
    plan: OrderPlan;
    corrections: Record<string, number>;
  } | null>(null);
  
  // Send feedback for an order plan
  const handleSendFeedback = async (
    plan: OrderPlan, 
    verdict: 'correct' | 'incorrect',
    actualOrder?: Record<string, number>
  ) => {
    const key = `${plan.style_no}|${plan.color}`;
    setSendingFeedback(key);
    
    // Parse prompt version for attribution (format: "key_vN")
    let promptKey: string | null = null;
    let promptVersion: number | null = null;
    if (result?.promptVersion) {
      const match = result.promptVersion.match(/^(.+)_v(\d+)$/);
      if (match) {
        promptKey = match[1];
        promptVersion = parseInt(match[2]);
      } else {
        promptKey = result.promptVersion;
      }
    }
    
    try {
      const response = await fetch('/api/call-off/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style_no: plan.style_no,
          color: plan.color,
          verdict,
          suggested_order: plan.size_breakdown,
          actual_order: actualOrder || null,
          notes: verdict === 'incorrect' 
            ? `Size distribution was wrong. Source: ${plan.size_source}${actualOrder ? '. Corrected by user.' : ''}` 
            : `Size distribution was correct. Source: ${plan.size_source}`,
          // Attribution for learning
          flow: 'quick_po',
          prompt_key: promptKey,
          prompt_version: promptVersion
        })
      });
      
      if (response.ok) {
        setFeedbackSent(prev => ({ ...prev, [key]: verdict }));
        setCorrectionModal(null);
      }
    } catch (err) {
      console.error('Failed to send feedback:', err);
    } finally {
      setSendingFeedback(null);
    }
  };
  
  // Open correction modal
  const openCorrectionModal = (plan: OrderPlan) => {
    // Initialize with suggested values
    setCorrectionModal({
      plan,
      corrections: { ...plan.size_breakdown }
    });
  };
  
  // Update a correction value
  const updateCorrection = (size: string, value: number) => {
    if (!correctionModal) return;
    setCorrectionModal({
      ...correctionModal,
      corrections: {
        ...correctionModal.corrections,
        [size]: value
      }
    });
  };

  // Parse and analyze
  const handleAnalyze = async () => {
    if (!commandText.trim()) {
      setError('Please enter some commands');
      return;
    }
    if (selectedMonths.length === 0) {
      setError('Please select at least one month for historical data');
      return;
    }
    
    setLoading(true);
    setError(null);
    setResult(null);
    setCreateResult(null);
    
    try {
      const res = await fetch('/api/quick-po/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandText,
          months: selectedMonths
        })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Analysis failed');
      }
      
      setResult(data);
      
      // If there are wait reminders, pass them up
      if (data.wait_reminders?.length > 0 && onAddWaitReminders) {
        onAddWaitReminders(data.wait_reminders);
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  // Create POs from approved plans
  const handleCreatePos = async () => {
    if (!result?.order_plans?.length) return;
    
    setCreatingPos(true);
    setError(null);
    
    try {
      const res = await fetch('/api/quick-po/create-app-pos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_plans: result.order_plans.filter(p => p.action === 'create_po'),
          color_breakdown_plans: result.color_breakdown_plans
        })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create POs');
      }
      
      setCreateResult(data);
    } catch (err: any) {
      setError(err.message || 'Failed to create POs');
    } finally {
      setCreatingPos(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Input Card */}
      <Card className="border-[#C5D5CA]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-[#8FA894]" />
            Quick PO Flow
          </CardTitle>
          <CardDescription>
            Enter text commands to quickly create purchase orders, schedule reminders, or manage stock.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Disclaimer */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
            <Info className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p className="font-medium mb-1">Command Reference</p>
              <ul className="text-xs space-y-0.5 text-amber-700">
                <li><code className="bg-amber-100 px-1 rounded">STYLE COLOR - ORDER Xpcs</code> — Create a PO for X pieces</li>
                <li><code className="bg-amber-100 px-1 rounded">STYLE COLOR - Color breakdown for Xpcs</code> — Distribute WHITE WEFT into colors</li>
                <li><code className="bg-amber-100 px-1 rounded">STYLE COLOR - Color breakdown for Xpcs. Look sales</code> — Same + show stock table</li>
                <li><code className="bg-amber-100 px-1 rounded">STYLE COLOR - Wait X weeks</code> — Add a reminder to revisit</li>
                <li><code className="bg-amber-100 px-1 rounded">STYLE COLOR - Make sure stock is fixed</code> — Smooth out stock curves</li>
              </ul>
            </div>
          </div>
          
          {/* Month Selection */}
          <div className="border rounded-lg p-3 bg-slate-50/50">
            <h4 className="text-sm font-medium text-slate-700 mb-2">Historical Months (for size ratios)</h4>
            <MonthYearPicker
              selectedMonths={selectedMonths}
              setSelectedMonths={setSelectedMonths}
            />
          </div>
          
          {/* Command Text Area */}
          <div>
            <label className="text-sm font-medium text-slate-700 block mb-1.5">
              Commands
            </label>
            <textarea
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
              placeholder={`RANY WHITE - ORDER 400pcs
RANY NEW KITT - Color breakdown for 200pcs
RANY BLACK - Wait 2 weeks
RANY NAVY - Wait 2 weeks
KAXY BLACK - ORDER 300pcs
KAXY NAVY - Make sure stock is fixed`}
              className="w-full h-40 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#8FA894] resize-none"
            />
          </div>
          
          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 text-red-800 text-sm">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          
          {/* Analyze Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleAnalyze}
              disabled={loading || !commandText.trim() || selectedMonths.length === 0}
              className="bg-[#8FA894] hover:bg-[#7a9380]"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Analyze Commands
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      
      {/* Results */}
      {result && (
        <>
          {/* Summary Card */}
          <Card className="border-[#C5D5CA]">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Analysis Results</CardTitle>
              {result.promptVersion && (
                <Badge className="w-fit bg-slate-100 text-slate-600 text-[10px]">
                  Prompt: {result.promptVersion}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-[#8FA894]">{result.summary.total_orders}</div>
                  <div className="text-xs text-slate-600">Orders</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-[#8FA894]">{result.summary.total_units_to_order.toLocaleString()}</div>
                  <div className="text-xs text-slate-600">Total Units</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-purple-600">{result.summary.total_coloring_jobs}</div>
                  <div className="text-xs text-slate-600">Coloring Jobs</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-amber-600">{result.summary.total_reminders}</div>
                  <div className="text-xs text-slate-600">Reminders</div>
                </div>
              </div>
              
              {result.summary.warnings.length > 0 && (
                <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-sm font-medium text-amber-800 mb-1">Warnings</div>
                  <ul className="text-xs text-amber-700 space-y-0.5">
                    {result.summary.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Order Plans */}
          {result.order_plans.length > 0 && (
            <Card className="border-[#C5D5CA]">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Order Plans ({result.order_plans.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {result.order_plans.map((plan, idx) => {
                    const st = plan.stock_table;
                    const sizes = st?.sizes || Object.keys(plan.size_breakdown);
                    
                    return (
                    <div
                      key={idx}
                      className={`border rounded-lg p-3 ${
                        plan.action === 'skip_overstocked' ? 'border-amber-200 bg-amber-50/50' :
                        plan.action === 'review_needed' ? 'border-blue-200 bg-blue-50/50' :
                        'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-medium">{plan.style_name} - {plan.color}</div>
                          <div className="text-xs text-slate-500">
                            {plan.style_no} · Size source: {
                              plan.size_source === 'smart_hybrid' ? '🎯 Smart (25% base, 45% hist, 30% need)' :
                              plan.size_source === 'historical_only' ? '📊 Historical' :
                              plan.size_source === 'historical' ? '📊 Historical' :
                              '📐 Default Assortment'
                            }
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Feedback buttons */}
                          {(() => {
                            const key = `${plan.style_no}|${plan.color}`;
                            const sent = feedbackSent[key];
                            const isSending = sendingFeedback === key;
                            
                            if (sent) {
                              return (
                                <span className={`text-xs px-2 py-0.5 rounded ${sent === 'correct' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                  {sent === 'correct' ? '✓ Good' : '✗ Wrong'}
                                </span>
                              );
                            }
                            
                            return (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleSendFeedback(plan, 'correct')}
                                  disabled={isSending}
                                  className="p-1 rounded hover:bg-green-100 text-slate-400 hover:text-green-600 transition-colors"
                                  title="Distribution looks good"
                                >
                                  {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
                                </button>
                                <button
                                  onClick={() => openCorrectionModal(plan)}
                                  disabled={isSending}
                                  className="p-1 rounded hover:bg-red-100 text-slate-400 hover:text-red-600 transition-colors"
                                  title="Distribution is wrong - click to enter correct quantities"
                                >
                                  <ThumbsDown className="h-4 w-4" />
                                </button>
                              </div>
                            );
                          })()}
                          
                          <Badge className={
                            plan.action === 'create_po' ? 'bg-green-100 text-green-700' :
                            plan.action === 'skip_overstocked' ? 'bg-amber-100 text-amber-700' :
                            'bg-blue-100 text-blue-700'
                          }>
                            {plan.action === 'create_po' ? 'Ready' :
                             plan.action === 'skip_overstocked' ? 'Overstocked' :
                             'Review Needed'}
                          </Badge>
                        </div>
                      </div>
                      
                      {/* Full Stock Table */}
                      <div className="overflow-x-auto mb-2">
                        <table className="w-full text-[11px] border-collapse">
                          <thead>
                            <tr className="bg-slate-50">
                              <th className="p-1.5 text-left border-b font-medium w-24">Section</th>
                              {sizes.map((size, i) => (
                                <th key={i} className="p-1.5 text-right border-b font-medium w-10">{size}</th>
                              ))}
                              <th className="p-1.5 text-right border-b font-medium w-14">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* Stock */}
                            <tr>
                              <td className="p-1.5 border-b text-slate-600">Stock</td>
                              {sizes.map((size, i) => (
                                <td key={i} className="p-1.5 text-right border-b">{st?.stock[i] ?? '-'}</td>
                              ))}
                              <td className="p-1.5 text-right border-b font-medium">{st?.stockTotal ?? plan.current_stock}</td>
                            </tr>
                            {/* Sold */}
                            <tr>
                              <td className="p-1.5 border-b text-red-600">Sold</td>
                              {sizes.map((size, i) => (
                                <td key={i} className="p-1.5 text-right border-b text-red-600">
                                  {st?.soldSum[i] !== undefined ? (st.soldSum[i] > 0 ? `-${st.soldSum[i]}` : st.soldSum[i]) : '-'}
                                </td>
                              ))}
                              <td className="p-1.5 text-right border-b font-medium text-red-700">
                                {st?.soldTotal !== undefined ? (st.soldTotal > 0 ? `-${st.soldTotal}` : st.soldTotal) : '-'}
                              </td>
                            </tr>
                            {/* Purchase */}
                            <tr>
                              <td className="p-1.5 border-b text-green-600">PO's</td>
                              {sizes.map((size, i) => (
                                <td key={i} className="p-1.5 text-right border-b text-green-600">{st?.purchaseSum[i] ?? '-'}</td>
                              ))}
                              <td className="p-1.5 text-right border-b font-medium text-green-700">{st?.purchaseTotal ?? plan.current_on_order}</td>
                            </tr>
                            {/* Net Need 1 = Stock - Sold + POs */}
                            <tr className="bg-amber-50/50">
                              <td className="p-1.5 border-b font-medium">Net Need 1</td>
                              {sizes.map((size, i) => (
                                <td key={i} className={`p-1.5 text-right border-b font-medium ${(st?.netNeed[i] ?? 0) < 0 ? 'text-red-600' : 'text-slate-700'}`}>
                                  {st?.netNeed[i] ?? '-'}
                                </td>
                              ))}
                              <td className={`p-1.5 text-right border-b font-bold ${plan.net_need_before < 0 ? 'text-red-700' : 'text-slate-700'}`}>
                                {plan.net_need_before}
                              </td>
                            </tr>
                            {/* Weight Factors (only show if smart_hybrid) */}
                            {plan.size_factors && plan.size_source === 'smart_hybrid' && (
                              <tr className="bg-indigo-50/50">
                                <td className="p-1.5 border-b text-indigo-600 text-[10px]">Weight %</td>
                                {sizes.map((size, i) => {
                                  const factor = plan.size_factors?.[size];
                                  const pct = factor ? Math.round(factor.combinedWeight * 100) : 0;
                                  return (
                                    <td key={i} className="p-1.5 text-right border-b text-indigo-500 text-[10px]">
                                      {pct}%
                                    </td>
                                  );
                                })}
                                <td className="p-1.5 text-right border-b text-indigo-600 text-[10px]">100%</td>
                              </tr>
                            )}
                            {/* New Order */}
                            <tr className="bg-purple-50">
                              <td className="p-1.5 border-b text-purple-700 font-medium">+ New Order</td>
                              {sizes.map((size, i) => (
                                <td key={i} className="p-1.5 text-right border-b text-purple-600 font-medium">
                                  +{plan.size_breakdown[size] ?? 0}
                                </td>
                              ))}
                              <td className="p-1.5 text-right border-b font-bold text-purple-700">+{plan.total_qty}</td>
                            </tr>
                            {/* New Net Need */}
                            {/* Net Need 2 = Net Need 1 + New Order (stock position after order arrives) */}
                            <tr className="bg-green-50">
                              <td className="p-1.5 font-semibold">Net Need 2</td>
                              {sizes.map((size, i) => {
                                const netNeed1 = st?.netNeed[i] ?? 0;
                                const newOrder = plan.size_breakdown[size] ?? 0;
                                const netNeed2 = netNeed1 + newOrder; // ADD the order, not subtract
                                return (
                                  <td key={i} className={`p-1.5 text-right font-medium ${netNeed2 < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                    {netNeed2}
                                  </td>
                                );
                              })}
                              {(() => {
                                // Calculate total Net Need 2 = Net Need 1 + New Order
                                const totalNetNeed1 = st?.netNeedTotal ?? plan.net_need_before;
                                const totalNetNeed2 = totalNetNeed1 + plan.total_qty;
                                return (
                                  <td className={`p-1.5 text-right font-bold ${totalNetNeed2 < 0 ? 'text-red-700' : 'text-green-700'}`}>
                                    {totalNetNeed2}
                                  </td>
                                );
                              })()}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      
                      {plan.warning && (
                        <div className="mt-2 text-xs text-amber-700 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {plan.warning}
                        </div>
                      )}
                      
                      {/* Calculation Details */}
                      {plan.size_factors && plan.size_source === 'smart_hybrid' && (
                        <details className="mt-2">
                          <summary className="text-xs text-indigo-600 cursor-pointer hover:text-indigo-800">
                            📊 Show calculation breakdown
                          </summary>
                          <div className="mt-1 p-2 bg-indigo-50 rounded text-[10px] font-mono">
                            <div className="grid grid-cols-4 gap-1 text-indigo-700 mb-1 font-semibold">
                              <span>Size</span>
                              <span>Base</span>
                              <span>Hist</span>
                              <span>Need</span>
                            </div>
                            {sizes.map((size) => {
                              const f = plan.size_factors?.[size];
                              if (!f) return null;
                              return (
                                <div key={size} className="grid grid-cols-4 gap-1 text-indigo-600">
                                  <span className="font-medium">{size}</span>
                                  <span>{(f.baseWeight * 100).toFixed(0)}%</span>
                                  <span>{(f.historicalWeight * 100).toFixed(0)}%</span>
                                  <span>{(f.netNeedWeight * 100).toFixed(0)}%</span>
                                </div>
                              );
                            })}
                            <div className="mt-1 pt-1 border-t border-indigo-200 text-indigo-700">
                              Formula: 25% base + 45% historical + 30% net need
                            </div>
                          </div>
                        </details>
                      )}
                    </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
          
          {/* Color Breakdown Plans */}
          {result.color_breakdown_plans.length > 0 && (
            <Card className="border-[#C5D5CA]">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Palette className="h-4 w-4" />
                  Color Breakdown Plans ({result.color_breakdown_plans.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {result.color_breakdown_plans.map((plan, idx) => (
                    <div key={idx} className="border border-purple-200 bg-purple-50/30 rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-medium">{plan.style_name}</div>
                          <div className="text-xs text-slate-500">
                            {plan.style_no} · Source: {plan.source_color}
                            {plan.look_sales && <span className="ml-2 text-purple-600">(with sales data)</span>}
                          </div>
                        </div>
                        <Badge className="bg-purple-100 text-purple-700">
                          {plan.target_quantity} pcs
                        </Badge>
                      </div>
                      
                      {/* ==================== SECTION 1: WHITE WEFT PO's (Source for Coloring) ==================== */}
                      {plan.white_weft_stock_table && (
                        <div className="mb-4">
                          <div className="bg-amber-100 text-amber-800 rounded px-2 py-1 mb-2 text-xs font-medium flex items-center gap-1">
                            🧵 WHITE WEFT - Purchase Orders (Available to Color)
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="bg-amber-50">
                                  <th className="p-2 text-left border-b font-medium">Section</th>
                                  {plan.white_weft_stock_table.sizes.map((size, i) => (
                                    <th key={i} className="p-2 text-right border-b font-medium w-14">{size}</th>
                                  ))}
                                  <th className="p-2 text-right border-b font-medium w-16">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* PO's Row - This is the PRIMARY value for WHITE WEFT */}
                                <tr className="bg-green-50 font-medium">
                                  <td className="p-2 border-b font-semibold text-green-700">📦 PO's on Order</td>
                                  {plan.white_weft_stock_table.purchaseSum.map((v, i) => (
                                    <td key={i} className="p-2 text-right border-b text-green-700 font-semibold">{v}</td>
                                  ))}
                                  <td className="p-2 text-right border-b font-bold text-green-800">
                                    {plan.white_weft_stock_table.purchaseTotal}
                                  </td>
                                </tr>
                                {/* Stock Row - Reference only */}
                                <tr className="text-slate-400">
                                  <td className="p-2 border-b text-xs">(Stock in hand)</td>
                                  {plan.white_weft_stock_table.stock.map((v, i) => (
                                    <td key={i} className="p-2 text-right border-b text-xs">{v}</td>
                                  ))}
                                  <td className="p-2 text-right border-b text-xs">{plan.white_weft_stock_table.stockTotal}</td>
                                </tr>
                                {/* Sold Row - Reference only */}
                                <tr className="text-slate-400">
                                  <td className="p-2 border-b text-xs">(Sold)</td>
                                  {plan.white_weft_stock_table.soldSum.map((v, i) => (
                                    <td key={i} className="p-2 text-right border-b text-xs">{v > 0 ? `-${v}` : v}</td>
                                  ))}
                                  <td className="p-2 text-right border-b text-xs">
                                    {plan.white_weft_stock_table.soldTotal > 0 ? `-${plan.white_weft_stock_table.soldTotal}` : plan.white_weft_stock_table.soldTotal}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div className="mt-2 text-xs text-amber-600">
                            ℹ️ For color breakdowns, we use <strong>PO&apos;s on order</strong> as the source material to color, not current stock.
                          </div>
                        </div>
                      )}
                      
                      {/* Fallback summary if no white weft stock table */}
                      {!plan.white_weft_stock_table && (
                        <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                          <div>
                            <span className="text-slate-500">Source Needed:</span>
                            <span className="ml-1 font-medium">{plan.source_stock_needed}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">PO's Available:</span>
                            <span className="ml-1 font-medium">{plan.source_po_available}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">PO's Remaining:</span>
                            <span className={`ml-1 font-medium ${plan.source_po_remaining < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {plan.source_po_remaining}
                            </span>
                          </div>
                        </div>
                      )}
                      
                      {/* Color distribution with full stock data */}
                      {/* Show TARGET color first, then others */}
                      <div className="space-y-3">
                        {Object.entries(plan.color_distribution)
                          .sort(([, a], [, b]) => (b.isTarget ? 1 : 0) - (a.isTarget ? 1 : 0))
                          .map(([color, dist]) => {
                          const sd = dist.stockData;
                          return (
                            <div key={color} className={`border rounded-lg p-3 ${
                              dist.isTarget 
                                ? 'border-purple-400 bg-purple-50 ring-2 ring-purple-200' 
                                : 'border-slate-200 bg-white'
                            }`}>
                              {/* Target Color Banner */}
                              {dist.isTarget && (
                                <div className="bg-purple-600 text-white rounded px-2 py-1 mb-2 text-xs font-medium">
                                  🎯 TARGET COLOR - Receiving {dist.qty} pcs from WHITE WEFT
                                </div>
                              )}
                              
                              {/* Historical Sales - Top Banner */}
                              {sd.historicalSales !== undefined && sd.historicalSales > 0 && (
                                <div className="bg-slate-100 rounded px-2 py-1 mb-2 text-[10px] text-slate-600">
                                  📊 Historical Sales: <strong>{sd.historicalSales}</strong> pcs sold
                                </div>
                              )}
                              
                              {/* Color header */}
                              <div className="flex items-center justify-between mb-2">
                                <div className={`font-medium text-sm ${dist.isTarget ? 'text-purple-800' : ''}`}>{color}</div>
                                <div className="flex items-center gap-2">
                                  {dist.isTarget ? (
                                    <Badge className="bg-purple-600 text-white">
                                      +{dist.qty} pcs (100%)
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-slate-100 text-slate-500 text-[10px]">
                                      Reference only
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              
                              {/* Mini stock table */}
                              <div className="overflow-x-auto">
                                <table className="w-full text-[11px] border-collapse">
                                  <thead>
                                    <tr className="bg-slate-50">
                                      <th className="p-1.5 text-left border-b font-medium w-24">Section</th>
                                      {sd.sizes.map((size, i) => (
                                        <th key={i} className="p-1.5 text-right border-b font-medium w-10">{size}</th>
                                      ))}
                                      <th className="p-1.5 text-right border-b font-medium w-14">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {/* Stock */}
                                    <tr>
                                      <td className="p-1.5 border-b text-slate-600">Stock</td>
                                      {sd.stock.map((v, i) => (
                                        <td key={i} className="p-1.5 text-right border-b">{v}</td>
                                      ))}
                                      <td className="p-1.5 text-right border-b font-medium">{sd.stockTotal}</td>
                                    </tr>
                                    {/* Sold */}
                                    <tr>
                                      <td className="p-1.5 border-b text-red-600">Sold</td>
                                      {sd.sold.map((v, i) => (
                                        <td key={i} className="p-1.5 text-right border-b text-red-600">{v > 0 ? `-${v}` : v}</td>
                                      ))}
                                      <td className="p-1.5 text-right border-b font-medium text-red-700">
                                        {sd.soldTotal > 0 ? `-${sd.soldTotal}` : sd.soldTotal}
                                      </td>
                                    </tr>
                                    {/* Purchase */}
                                    <tr>
                                      <td className="p-1.5 border-b text-green-600">PO's</td>
                                      {sd.purchase.map((v, i) => (
                                        <td key={i} className="p-1.5 text-right border-b text-green-600">{v}</td>
                                      ))}
                                      <td className="p-1.5 text-right border-b font-medium text-green-700">{sd.purchaseTotal}</td>
                                    </tr>
                                    {/* Net Need 1 = Stock - Sold + POs */}
                                    <tr className="bg-amber-50/50">
                                      <td className="p-1.5 border-b font-medium">Net Need 1</td>
                                      {sd.netNeed.map((v, i) => (
                                        <td key={i} className={`p-1.5 text-right border-b font-medium ${v < 0 ? 'text-red-600' : 'text-slate-700'}`}>{v}</td>
                                      ))}
                                      <td className={`p-1.5 text-right border-b font-bold ${sd.netNeedTotal > 0 ? 'text-red-700' : sd.netNeedTotal < 0 ? 'text-green-700' : ''}`}>
                                        {sd.netNeedTotal}
                                      </td>
                                    </tr>
                                    {/* New Order */}
                                    <tr className="bg-purple-50">
                                      <td className="p-1.5 border-b text-purple-700 font-medium">+ New Order</td>
                                      {sd.sizes.map((_, i) => (
                                        <td key={i} className="p-1.5 text-right border-b text-purple-600 font-medium">
                                          {dist.newOrderBySize?.[i] !== undefined && dist.newOrderBySize[i] > 0 
                                            ? `+${dist.newOrderBySize[i]}` 
                                            : dist.newOrderBySize?.[i] === 0 ? '-' : '-'}
                                        </td>
                                      ))}
                                      <td className="p-1.5 text-right border-b font-bold text-purple-700">+{dist.qty}</td>
                                    </tr>
                                    {/* Net Need 2 = Net Need 1 + New Order */}
                                    <tr className="bg-green-50">
                                      <td className="p-1.5 font-semibold">Net Need 2</td>
                                      {sd.sizes.map((_, i) => {
                                        const netNeed1 = sd.netNeed[i] ?? 0;
                                        const newOrder = dist.newOrderBySize?.[i] ?? 0;
                                        const netNeed2 = netNeed1 + newOrder;
                                        return (
                                          <td key={i} className={`p-1.5 text-right font-medium ${netNeed2 < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                            {netNeed2}
                                          </td>
                                        );
                                      })}
                                      {(() => {
                                        // Net Need 2 = Net Need 1 + New Order
                                        const netNeed1Total = sd.netNeedTotal;
                                        const netNeed2Total = netNeed1Total + dist.qty;
                                        return (
                                          <td className={`p-1.5 text-right font-bold ${netNeed2Total < 0 ? 'text-red-700' : 'text-green-700'}`}>
                                            {netNeed2Total}
                                          </td>
                                        );
                                      })()}
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      
                      {/* ==================== SECTION 3: WHITE WEFT PO's REMAINING AFTER COLORING ==================== */}
                      {plan.white_weft_stock_table && plan.white_weft_remaining_by_size && (
                        <div className="mt-4">
                          <div className="bg-teal-100 text-teal-800 rounded px-2 py-1 mb-2 text-xs font-medium flex items-center gap-1">
                            ✅ WHITE WEFT PO&apos;s - Remaining After Coloring
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="bg-teal-50">
                                  <th className="p-2 text-left border-b font-medium">Section</th>
                                  {plan.white_weft_stock_table.sizes.map((size, i) => (
                                    <th key={i} className="p-2 text-right border-b font-medium w-14">{size}</th>
                                  ))}
                                  <th className="p-2 text-right border-b font-medium w-16">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* Original PO's */}
                                <tr className="text-green-700">
                                  <td className="p-2 border-b font-medium">📦 PO&apos;s Available</td>
                                  {plan.white_weft_stock_table.purchaseSum.map((v, i) => (
                                    <td key={i} className="p-2 text-right border-b">{v}</td>
                                  ))}
                                  <td className="p-2 text-right border-b font-medium">{plan.white_weft_stock_table.purchaseTotal}</td>
                                </tr>
                                {/* Color Deduction */}
                                <tr>
                                  <td className="p-2 border-b font-medium text-purple-600">- Coloring</td>
                                  {plan.white_weft_stock_table.sizes.map((_, i) => {
                                    const deduction = (plan.white_weft_stock_table?.purchaseSum[i] ?? 0) - (plan.white_weft_remaining_by_size?.[i] ?? 0);
                                    return (
                                      <td key={i} className="p-2 text-right border-b text-purple-600">
                                        {deduction > 0 ? `-${deduction}` : deduction}
                                      </td>
                                    );
                                  })}
                                  <td className="p-2 text-right border-b font-medium text-purple-700">
                                    -{plan.target_quantity}
                                  </td>
                                </tr>
                                {/* Final Remaining PO's */}
                                <tr className="bg-teal-50">
                                  <td className="p-2 font-semibold">📦 PO&apos;s Remaining</td>
                                  {plan.white_weft_remaining_by_size.map((v, i) => (
                                    <td key={i} className={`p-2 text-right font-semibold ${v < 0 ? 'text-red-700' : 'text-teal-700'}`}>{v}</td>
                                  ))}
                                  <td className={`p-2 text-right font-bold ${plan.source_po_remaining < 0 ? 'text-red-700' : 'text-teal-700'}`}>
                                    {plan.source_po_remaining}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          {plan.source_po_remaining < 0 && (
                            <div className="mt-2 text-xs text-red-600 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Not enough WHITE WEFT on order! Need {Math.abs(plan.source_po_remaining)} more pieces.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          
          {/* Wait Reminders */}
          {result.wait_reminders.length > 0 && (
            <Card className="border-[#C5D5CA]">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Wait Reminders ({result.wait_reminders.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {result.wait_reminders.map((reminder, idx) => (
                    <div key={idx} className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
                      <Clock className="h-4 w-4 text-amber-600" />
                      <div>
                        <div className="text-sm font-medium">{reminder.style_no} - {reminder.color}</div>
                        <div className="text-xs text-amber-700">
                          Wait {reminder.weeks} week{reminder.weeks !== 1 ? 's' : ''} → {reminder.reminder_date}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          
          {/* Stock Fix Suggestions */}
          {result.stock_fix_suggestions.length > 0 && (
            <Card className="border-[#C5D5CA]">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Stock Fix Suggestions ({result.stock_fix_suggestions.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {result.stock_fix_suggestions.map((fix, idx) => (
                    <div key={idx} className="border border-slate-200 rounded-lg p-3">
                      <div className="font-medium mb-2">{fix.style_no} - {fix.color}</div>
                      <div className="text-xs text-slate-600 mb-2">{fix.reasoning}</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-slate-500">Current:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {Object.entries(fix.current_curve).map(([size, qty]) => (
                              <span key={size} className="bg-slate-100 rounded px-1 py-0.5">{size}: {qty}</span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className="text-slate-500">Add:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {Object.entries(fix.suggested_additions).map(([size, qty]) => (
                              <span key={size} className="bg-green-100 text-green-700 rounded px-1 py-0.5">+{qty} ({size})</span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 text-xs">
                        <span className="text-slate-500">Total to add:</span>
                        <span className="ml-1 font-medium">{fix.total_to_add} pcs</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          
          {/* Create POs Button */}
          {(result.order_plans.some(p => p.action === 'create_po') || result.color_breakdown_plans.length > 0) && (
            <Card className="border-[#C5D5CA]">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">
                      Ready to create {result.order_plans.filter(p => p.action === 'create_po').length} PO{result.order_plans.filter(p => p.action === 'create_po').length !== 1 ? 's' : ''}
                      {result.color_breakdown_plans.length > 0 && ` + ${result.color_breakdown_plans.length} coloring job${result.color_breakdown_plans.length !== 1 ? 's' : ''}`}
                    </div>
                    <div className="text-xs text-slate-500">
                      This will create draft App POs for review
                    </div>
                  </div>
                  <Button
                    onClick={handleCreatePos}
                    disabled={creatingPos}
                    className="bg-[#8FA894] hover:bg-[#7a9380]"
                  >
                    {creatingPos ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        Create POs
                      </>
                    )}
                  </Button>
                </div>
                
                {createResult && (
                  <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
                    <Check className="h-4 w-4 inline mr-1" />
                    Created {createResult.success} PO{createResult.success !== 1 ? 's' : ''} successfully
                    {createResult.failed > 0 && ` (${createResult.failed} failed)`}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
      
      {/* Correction Modal */}
      {correctionModal && (() => {
        const plan = correctionModal.plan;
        const st = plan.stock_table;
        const sizes = st?.sizes || Object.keys(plan.size_breakdown).sort((a, b) => {
          const numA = parseInt(a);
          const numB = parseInt(b);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.localeCompare(b);
        });
        
        // Calculate Net Need 2 with corrections
        const calculateNetNeed2 = () => {
          const netNeed2BySize: Record<string, number> = {};
          let totalNetNeed2 = 0;
          
          for (let i = 0; i < sizes.length; i++) {
            const size = sizes[i];
            const netNeed1 = st?.netNeed[i] ?? 0;
            const correctedOrder = correctionModal.corrections[size] ?? 0;
            const netNeed2 = netNeed1 + correctedOrder;
            netNeed2BySize[size] = netNeed2;
            totalNetNeed2 += netNeed2;
          }
          
          return { netNeed2BySize, totalNetNeed2 };
        };
        
        const { netNeed2BySize, totalNetNeed2 } = calculateNetNeed2();
        
        // Calculate % distribution of Net Need 2
        const getDistributionPct = (value: number) => {
          if (totalNetNeed2 === 0) return 0;
          return (value / totalNetNeed2) * 100;
        };
        
        return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b">
              <h3 className="font-semibold text-lg">Correct Size Distribution</h3>
              <p className="text-sm text-slate-500 mt-1">
                Enter the correct quantities so the AI can learn for next time.
              </p>
            </div>
            
            <div className="p-4">
              <div className="mb-4">
                <div className="text-sm font-medium text-slate-700">
                  {plan.style_name} - {plan.color}
                </div>
                <div className="text-xs text-slate-500">
                  {plan.style_no} · Total: {plan.total_qty} pcs
                </div>
              </div>
              
              {/* Full table with Net Need 1, Order, Net Need 2 */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100">
                      <th className="p-2 text-left font-medium">Section</th>
                      {sizes.map((size, i) => (
                        <th key={i} className="p-2 text-right font-medium w-12">{size}</th>
                      ))}
                      <th className="p-2 text-right font-medium w-16">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Net Need 1 */}
                    {st && (
                      <tr className="bg-amber-50/50">
                        <td className="p-2 font-medium border-b">Net Need 1</td>
                        {sizes.map((size, i) => (
                          <td key={i} className={`p-2 text-right border-b ${(st.netNeed[i] ?? 0) < 0 ? 'text-red-600' : ''}`}>
                            {st.netNeed[i] ?? 0}
                          </td>
                        ))}
                        <td className="p-2 text-right border-b font-medium">{st.netNeedTotal}</td>
                      </tr>
                    )}
                    
                    {/* Suggested Order */}
                    <tr className="text-slate-500">
                      <td className="p-2 font-medium border-b">Suggested</td>
                      {sizes.map((size) => (
                        <td key={size} className="p-2 text-right border-b">
                          {plan.size_breakdown[size] ?? 0}
                        </td>
                      ))}
                      <td className="p-2 text-right border-b font-medium">
                        {Object.values(plan.size_breakdown).reduce((a, b) => a + b, 0)}
                      </td>
                    </tr>
                    
                    {/* Corrected Order (editable) */}
                    <tr className="bg-indigo-50">
                      <td className="p-2 font-medium border-b text-indigo-700">Correct Order</td>
                      {sizes.map((size) => {
                        const suggested = plan.size_breakdown[size] ?? 0;
                        const corrected = correctionModal.corrections[size] ?? 0;
                        const diff = corrected - suggested;
                        return (
                          <td key={size} className="p-1 border-b">
                            <input
                              type="number"
                              min="0"
                              value={corrected}
                              onChange={(e) => updateCorrection(size, parseInt(e.target.value) || 0)}
                              className={`w-full text-right text-xs border rounded px-1 py-0.5 focus:ring-1 focus:ring-indigo-500 ${
                                diff !== 0 ? 'bg-indigo-100 font-medium' : ''
                              }`}
                            />
                          </td>
                        );
                      })}
                      <td className="p-2 text-right border-b font-bold text-indigo-700">
                        {Object.values(correctionModal.corrections).reduce((a, b) => a + b, 0)}
                      </td>
                    </tr>
                    
                    {/* Net Need 2 (after correction) */}
                    <tr className="bg-green-50">
                      <td className="p-2 font-semibold">Net Need 2</td>
                      {sizes.map((size) => {
                        const nn2 = netNeed2BySize[size] ?? 0;
                        return (
                          <td key={size} className={`p-2 text-right font-medium ${nn2 < 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {nn2}
                          </td>
                        );
                      })}
                      <td className={`p-2 text-right font-bold ${totalNetNeed2 < 0 ? 'text-red-700' : 'text-green-700'}`}>
                        {totalNetNeed2}
                      </td>
                    </tr>
                    
                    {/* % Distribution of Net Need 2 */}
                    <tr className="text-slate-500 text-[10px]">
                      <td className="p-2 font-medium">% Dist</td>
                      {sizes.map((size) => {
                        const nn2 = netNeed2BySize[size] ?? 0;
                        const pct = getDistributionPct(nn2);
                        return (
                          <td key={size} className="p-2 text-right">
                            {totalNetNeed2 !== 0 ? `${pct.toFixed(0)}%` : '-'}
                          </td>
                        );
                      })}
                      <td className="p-2 text-right">100%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              
              {/* Diff summary */}
              <div className="mt-3 text-xs text-slate-500">
                {(() => {
                  const corrTotal = Object.values(correctionModal.corrections).reduce((a, b) => a + b, 0);
                  const sugTotal = Object.values(plan.size_breakdown).reduce((a, b) => a + b, 0);
                  const diff = corrTotal - sugTotal;
                  if (diff === 0) return <span className="text-slate-400">No change in total quantity</span>;
                  return (
                    <span className={diff > 0 ? 'text-green-600' : 'text-red-600'}>
                      {diff > 0 ? '+' : ''}{diff} units compared to suggested
                    </span>
                  );
                })()}
              </div>
            </div>
            
            <div className="p-4 border-t bg-slate-50 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setCorrectionModal(null)}
                className="border-slate-300"
              >
                Cancel
              </Button>
              <Button
                onClick={() => handleSendFeedback(
                  plan, 
                  'incorrect',
                  correctionModal.corrections
                )}
                disabled={sendingFeedback !== null}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {sendingFeedback ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <ThumbsDown className="h-4 w-4 mr-2" />
                    Submit Correction
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
