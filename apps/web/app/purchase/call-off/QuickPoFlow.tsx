'use client';

import React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Info, Loader2, AlertTriangle, Check, Clock, Zap, Package, Palette } from 'lucide-react';

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

interface OrderPlan {
  style_no: string;
  style_name: string;
  color: string;
  total_qty: number;
  size_breakdown: Record<string, number>;
  size_source: 'historical' | 'default_assortment';
  current_stock: number;
  current_on_order: number;
  net_need_before: number;
  net_need_after: number;
  warning: string | null;
  action: 'create_po' | 'skip_overstocked' | 'review_needed';
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
}

interface ColorBreakdownPlan {
  style_no: string;
  style_name: string;
  source_color: string;
  target_quantity: number;
  color_distribution: Record<string, ColorDistItem>;
  source_stock_needed: number;
  source_stock_available: number;
  source_stock_remaining: number;
  action: string;
  look_sales?: boolean;
  stock_table?: StockTableData;
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
                  {result.order_plans.map((plan, idx) => (
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
                          <div className="text-xs text-slate-500">{plan.style_no}</div>
                        </div>
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
                      
                      <div className="grid grid-cols-4 gap-2 text-xs mb-2">
                        <div>
                          <span className="text-slate-500">Order:</span>
                          <span className="ml-1 font-medium">{plan.total_qty} pcs</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Stock:</span>
                          <span className="ml-1">{plan.current_stock}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">On Order:</span>
                          <span className="ml-1">{plan.current_on_order}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Source:</span>
                          <span className="ml-1">{plan.size_source === 'historical' ? 'Historical' : 'Default'}</span>
                        </div>
                      </div>
                      
                      {/* Size breakdown */}
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(plan.size_breakdown).map(([size, qty]) => (
                          <span key={size} className="bg-slate-100 rounded px-1.5 py-0.5 text-[10px]">
                            {size}: <strong>{qty}</strong>
                          </span>
                        ))}
                      </div>
                      
                      {plan.warning && (
                        <div className="mt-2 text-xs text-amber-700 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {plan.warning}
                        </div>
                      )}
                    </div>
                  ))}
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
                      
                      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                        <div>
                          <span className="text-slate-500">Source Needed:</span>
                          <span className="ml-1 font-medium">{plan.source_stock_needed}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Available:</span>
                          <span className="ml-1">{plan.source_stock_available}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Remaining:</span>
                          <span className="ml-1">{plan.source_stock_remaining}</span>
                        </div>
                      </div>
                      
                      {/* Stock Table (when look_sales is true) */}
                      {plan.look_sales && plan.stock_table && (
                        <div className="mb-4 overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="bg-slate-100">
                                <th className="p-2 text-left border-b font-medium">Section</th>
                                {plan.stock_table.sizes.map((size, i) => (
                                  <th key={i} className="p-2 text-right border-b font-medium w-14">{size}</th>
                                ))}
                                <th className="p-2 text-right border-b font-medium w-16">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {/* Stock Row */}
                              <tr>
                                <td className="p-2 border-b font-medium">Stock</td>
                                {plan.stock_table.stock.map((v, i) => (
                                  <td key={i} className="p-2 text-right border-b">{v}</td>
                                ))}
                                <td className="p-2 text-right border-b font-medium">{plan.stock_table.stockTotal}</td>
                              </tr>
                              {/* Sold Row */}
                              <tr>
                                <td className="p-2 border-b font-medium text-red-600">Sold</td>
                                {plan.stock_table.soldSum.map((v, i) => (
                                  <td key={i} className="p-2 text-right border-b text-red-600">{v > 0 ? `-${v}` : v}</td>
                                ))}
                                <td className="p-2 text-right border-b font-medium text-red-700">
                                  {plan.stock_table.soldTotal > 0 ? `-${plan.stock_table.soldTotal}` : plan.stock_table.soldTotal}
                                </td>
                              </tr>
                              {/* Purchase Row */}
                              <tr>
                                <td className="p-2 border-b font-medium text-green-600">Purchase</td>
                                {plan.stock_table.purchaseSum.map((v, i) => (
                                  <td key={i} className="p-2 text-right border-b text-green-600">{v}</td>
                                ))}
                                <td className="p-2 text-right border-b font-medium text-green-700">{plan.stock_table.purchaseTotal}</td>
                              </tr>
                              {/* Net Need Row */}
                              <tr className="bg-slate-50">
                                <td className="p-2 font-semibold">Net Need</td>
                                {plan.stock_table.netNeed.map((v, i) => (
                                  <td key={i} className={`p-2 text-right font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}`}>{v}</td>
                                ))}
                                <td className={`p-2 text-right font-bold ${plan.stock_table.netNeedTotal < 0 ? 'text-red-700' : plan.stock_table.netNeedTotal > 0 ? 'text-green-700' : ''}`}>
                                  {plan.stock_table.netNeedTotal}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                      
                      {/* Color distribution with full stock data */}
                      <div className="space-y-3">
                        {Object.entries(plan.color_distribution).map(([color, dist]) => {
                          const sd = dist.stockData;
                          return (
                            <div key={color} className={`border rounded-lg p-3 ${dist.qty > 0 ? 'border-purple-200 bg-purple-50/20' : 'border-slate-200 bg-white'}`}>
                              {/* Historical Sales - Top Banner */}
                              {sd.historicalSales !== undefined && sd.historicalSales > 0 && (
                                <div className="bg-slate-100 rounded px-2 py-1 mb-2 text-[10px] text-slate-600">
                                  📊 Historical Sales: <strong>{sd.historicalSales}</strong> pcs sold
                                </div>
                              )}
                              
                              {/* Color header */}
                              <div className="flex items-center justify-between mb-2">
                                <div className="font-medium text-sm">{color}</div>
                                <div className="flex items-center gap-2">
                                  {dist.qty > 0 ? (
                                    <Badge className="bg-purple-100 text-purple-700">
                                      +{dist.qty} pcs ({dist.pct}%)
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-slate-100 text-slate-500">
                                      No allocation needed
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
                                    {/* Net Need (current) */}
                                    <tr className="bg-amber-50/50">
                                      <td className="p-1.5 border-b font-medium">Net Need</td>
                                      {sd.netNeed.map((v, i) => (
                                        <td key={i} className={`p-1.5 text-right border-b font-medium ${v > 0 ? 'text-red-600' : v < 0 ? 'text-green-600' : ''}`}>{v}</td>
                                      ))}
                                      <td className={`p-1.5 text-right border-b font-bold ${sd.netNeedTotal > 0 ? 'text-red-700' : sd.netNeedTotal < 0 ? 'text-green-700' : ''}`}>
                                        {sd.netNeedTotal}
                                      </td>
                                    </tr>
                                    {/* New Order */}
                                    <tr className="bg-purple-50">
                                      <td className="p-1.5 border-b text-purple-700 font-medium">+ New Order</td>
                                      <td colSpan={sd.sizes.length} className="p-1.5 text-center border-b text-purple-600 text-[10px]">
                                        (distributed proportionally)
                                      </td>
                                      <td className="p-1.5 text-right border-b font-bold text-purple-700">+{dist.qty}</td>
                                    </tr>
                                    {/* New Net Need */}
                                    <tr className="bg-green-50">
                                      <td className="p-1.5 font-semibold">New Net Need</td>
                                      <td colSpan={sd.sizes.length} className="p-1.5"></td>
                                      <td className={`p-1.5 text-right font-bold ${dist.newNetNeed > 0 ? 'text-amber-600' : dist.newNetNeed < 0 ? 'text-green-700' : 'text-slate-600'}`}>
                                        {dist.newNetNeed > 0 ? dist.newNetNeed : dist.newNetNeed === 0 ? '✓ Covered' : `+${Math.abs(dist.newNetNeed)} surplus`}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}
                      </div>
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
    </div>
  );
}
