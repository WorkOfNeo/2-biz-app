'use client';
import React from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';

type Selection = { style_no: string; color: string };

type FullAnalysisItem = {
  style_no: string;
  style_name: string;
  color: string;
  sizes: string[];
  stock: number[];
  sold: number[];
  netStock: number[];
  historical: number[];
  nextMonthHistorical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalHistorical: number;
  totalNextMonthHistorical: number;
  weeklyRate: number;
  nextMonthWeeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  suggestedOrderBySize: number[];
  trendDirection: 'up' | 'down' | 'stable';
  trendPercent: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  priority: number;
};

type OrderByStyle = {
  style_no: string;
  style_name: string;
  totalOrder: number;
  colors: Array<{
    color: string;
    order: number;
    status: 'critical' | 'low' | 'ok' | 'surplus';
  }>;
};

type FullAnalysisResult = {
  items: FullAnalysisItem[];
  ordersByStyle: OrderByStyle[];
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    aiSummary: string;
    trendSummary: string;
  };
  dateRange: {
    start: string;
    end: string;
    display: string;
  };
  nextMonthRange: {
    start: string;
    end: string;
    display: string;
  };
};

// User-editable order state per item
type OrderEdits = Record<string, number[]>; // key: style_no|color -> per-size order values

// Feedback state per item
type FeedbackState = Record<string, {
  verdict: 'correct' | 'incorrect' | null;
  notes: string;
  saved: boolean;
}>;

interface FullAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  selections: Selection[];
  dateRange: { start: string; end: string };
  setDateRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  weeksCover: number;
  setWeeksCover: React.Dispatch<React.SetStateAction<number>>;
  loading: boolean;
  result: FullAnalysisResult | null;
  onRunAnalysis: () => void;
}

export default function FullAnalysisModal({
  isOpen,
  onClose,
  selections,
  dateRange,
  setDateRange,
  weeksCover,
  setWeeksCover,
  loading,
  result,
  onRunAnalysis
}: FullAnalysisModalProps) {
  const [filter, setFilter] = React.useState<'all' | 'critical' | 'low' | 'ok' | 'surplus'>('all');
  const [expandedItem, setExpandedItem] = React.useState<string | null>(null);
  
  // User-editable orders (initialized from AI suggestions)
  const [orderEdits, setOrderEdits] = React.useState<OrderEdits>({});
  
  // Feedback per item
  const [feedback, setFeedback] = React.useState<FeedbackState>({});
  
  // Saving state
  const [saving, setSaving] = React.useState(false);
  const [savedAnalysisId, setSavedAnalysisId] = React.useState<string | null>(null);

  // Initialize order edits from AI suggestions when result changes
  React.useEffect(() => {
    if (result) {
      const initial: OrderEdits = {};
      result.items.forEach(item => {
        const key = `${item.style_no}|${item.color}`;
        initial[key] = item.suggestedOrderBySize || item.sizes.map(() => 0);
      });
      setOrderEdits(initial);
    }
  }, [result]);

  if (!isOpen) return null;

  const toggleExpand = (key: string) => {
    setExpandedItem(expandedItem === key ? null : key);
  };

  const filteredItems = result?.items.filter(item => {
    if (filter === 'all') return true;
    return item.status === filter;
  }) || [];

  const getStatusBadge = (status: 'critical' | 'low' | 'ok' | 'surplus') => {
    switch (status) {
      case 'critical':
        return <Badge className="bg-red-500 text-white text-[10px]">Critical</Badge>;
      case 'low':
        return <Badge className="bg-amber-500 text-white text-[10px]">Low</Badge>;
      case 'ok':
        return <Badge className="bg-green-500 text-white text-[10px]">OK</Badge>;
      case 'surplus':
        return <Badge className="bg-blue-500 text-white text-[10px]">Surplus</Badge>;
    }
  };

  // Get current order for an item
  const getCurrentOrder = (item: FullAnalysisItem): number[] => {
    const key = `${item.style_no}|${item.color}`;
    return orderEdits[key] || item.suggestedOrderBySize || item.sizes.map(() => 0);
  };

  // Calculate net need per size: targetStock - (stock - sold + currentOrder)
  // This shows what we still need AFTER placing the current order
  const calculateNetNeed = (item: FullAnalysisItem): number[] => {
    const currentOrder = getCurrentOrder(item);
    const targetPerSize = item.sizes.map((_, i) => {
      // Distribute target stock by historical pressure
      const totalHist = item.historical.reduce((a, b) => a + b, 0);
      if (totalHist === 0) return Math.ceil(item.targetStock / item.sizes.length);
      return Math.ceil((item.historical[i] / totalHist) * item.targetStock);
    });
    
    return item.sizes.map((_, i) => {
      const stock = item.stock[i] || 0;
      const sold = item.sold[i] || 0;
      const order = currentOrder[i] || 0;
      const target = targetPerSize[i] || 0;
      // Net need = target - (current net stock + pending order)
      return target - (stock - sold + order);
    });
  };

  // Update order for a specific size
  const updateOrder = (itemKey: string, sizeIndex: number, value: number) => {
    setOrderEdits(prev => {
      const current = prev[itemKey] || [];
      const newOrder = [...current];
      newOrder[sizeIndex] = Math.max(0, value);
      return { ...prev, [itemKey]: newOrder };
    });
  };

  // Apply AI suggestion to an item
  const applySuggestion = (itemKey: string, suggestion: number[]) => {
    setOrderEdits(prev => ({ ...prev, [itemKey]: [...suggestion] }));
  };

  // Calculate total current order
  const getTotalCurrentOrder = (): number => {
    return Object.values(orderEdits).reduce((total, sizes) => 
      total + sizes.reduce((sum, v) => sum + (v || 0), 0), 0
    );
  };

  // Set feedback for an item
  const setItemFeedback = (itemKey: string, verdict: 'correct' | 'incorrect' | null, notes?: string) => {
    setFeedback(prev => ({
      ...prev,
      [itemKey]: {
        verdict,
        notes: notes ?? prev[itemKey]?.notes ?? '',
        saved: false
      }
    }));
  };

  // Save feedback for an item
  const saveFeedback = async (item: FullAnalysisItem) => {
    const key = `${item.style_no}|${item.color}`;
    const fb = feedback[key];
    if (!fb?.verdict) return;

    try {
      const response = await fetch('/api/call-off/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_id: savedAnalysisId,
          style_no: item.style_no,
          color: item.color,
          verdict: fb.verdict,
          notes: fb.notes,
          suggested_order: item.suggestedOrderBySize,
          actual_order: getCurrentOrder(item)
        })
      });

      if (response.ok) {
        setFeedback(prev => ({
          ...prev,
          [key]: { ...prev[key], saved: true }
        }));
      }
    } catch (error) {
      console.error('Failed to save feedback:', error);
    }
  };

  // Save the analysis
  const saveAnalysis = async () => {
    if (!result) return;
    
    setSaving(true);
    try {
      // Build modified items with user orders
      const modifiedItems = result.items.map(item => {
        const key = `${item.style_no}|${item.color}`;
        const userOrder = orderEdits[key] || item.suggestedOrderBySize;
        return {
          ...item,
          userOrder,
          userOrderTotal: userOrder.reduce((a, b) => a + b, 0)
        };
      });

      const response = await fetch('/api/call-off/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections,
          date_range_start: dateRange.start,
          date_range_end: dateRange.end,
          weeks_cover: weeksCover,
          items: modifiedItems,
          orders_by_style: result.ordersByStyle,
          summary: {
            ...result.summary,
            totalUserOrder: getTotalCurrentOrder()
          },
          ai_summary: result.summary.aiSummary
        })
      });

      if (response.ok) {
        const data = await response.json();
        setSavedAnalysisId(data.data.id);
        alert('Analysis saved successfully!');
      } else {
        throw new Error('Failed to save');
      }
    } catch (error) {
      console.error('Failed to save analysis:', error);
      alert('Failed to save analysis. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Simple markdown renderer for AI summary
  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let listItems: string[] = [];

    const processLine = (line: string) => {
      line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      line = line.replace(/__(.*?)__/g, '<strong>$1</strong>');
      line = line.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      line = line.replace(/_([^_]+)_/g, '<em>$1</em>');
      return line;
    };

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`list-${elements.length}`} className="list-disc list-inside my-2 space-y-1">
            {listItems.map((item, i) => (
              <li key={i} className="text-sm" dangerouslySetInnerHTML={{ __html: processLine(item) }} />
            ))}
          </ul>
        );
        listItems = [];
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('### ')) {
        flushList();
        elements.push(<h4 key={idx} className="font-semibold text-slate-800 mt-4 mb-2 text-sm">{trimmed.slice(4)}</h4>);
      } else if (trimmed.startsWith('## ')) {
        flushList();
        elements.push(<h3 key={idx} className="font-bold text-slate-900 mt-4 mb-2">{trimmed.slice(3)}</h3>);
      } else if (trimmed.startsWith('# ')) {
        flushList();
        elements.push(<h2 key={idx} className="font-bold text-lg text-slate-900 mt-4 mb-2">{trimmed.slice(2)}</h2>);
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
        listItems.push(trimmed.slice(2));
      } else if (/^\d+\.\s/.test(trimmed)) {
        listItems.push(trimmed.replace(/^\d+\.\s/, ''));
      } else if (trimmed === '') {
        flushList();
        elements.push(<div key={idx} className="h-2" />);
      } else {
        flushList();
        elements.push(<p key={idx} className="text-sm my-1" dangerouslySetInnerHTML={{ __html: processLine(trimmed) }} />);
      }
    });

    flushList();
    return elements;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b bg-[#F5F3F0]">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Full AI Analysis</h2>
            <p className="text-sm text-slate-600">
              Comprehensive stock analysis for {selections.length} selected items
              {savedAnalysisId && <span className="ml-2 text-green-600">(Saved)</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Configuration */}
          {!result && (
            <Card className="border-[#C5D5CA]">
              <CardHeader>
                <CardTitle className="text-lg">Analysis Configuration</CardTitle>
                <CardDescription>Set the comparison date range and target weeks cover</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Start Date</label>
                    <Input
                      type="date"
                      value={dateRange.start}
                      onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">End Date</label>
                    <Input
                      type="date"
                      value={dateRange.end}
                      onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Target Weeks Cover</label>
                    <Input
                      type="number"
                      min={1}
                      max={52}
                      value={weeksCover}
                      onChange={(e) => setWeeksCover(Math.max(1, parseInt(e.target.value) || 4))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                </div>
                
                <Button
                  onClick={onRunAnalysis}
                  disabled={loading || !dateRange.start || !dateRange.end}
                  className="w-full bg-[#B8A8D8] hover:bg-[#B8A8D8]/80 text-white"
                >
                  {loading ? 'Analyzing...' : `Run Full AI Analysis (${selections.length} items)`}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="text-center space-y-4">
                <svg className="animate-spin h-12 w-12 mx-auto text-[#B8A8D8]" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <p className="text-slate-600">Analyzing stock levels and generating AI insights...</p>
              </div>
            </div>
          )}

          {/* Results */}
          {result && !loading && (
            <>
              {/* Summary Cards with Order Totals */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <div className="bg-slate-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-slate-900">{result.summary.totalItems}</div>
                  <div className="text-xs text-slate-600">Total Items</div>
                </div>
                <div className="bg-red-50 rounded-lg p-4 text-center cursor-pointer hover:bg-red-100" onClick={() => setFilter('critical')}>
                  <div className="text-2xl font-bold text-red-600">{result.summary.criticalItems}</div>
                  <div className="text-xs text-red-700">Critical</div>
                </div>
                <div className="bg-amber-50 rounded-lg p-4 text-center cursor-pointer hover:bg-amber-100" onClick={() => setFilter('low')}>
                  <div className="text-2xl font-bold text-amber-600">{result.summary.lowItems}</div>
                  <div className="text-xs text-amber-700">Low Stock</div>
                </div>
                <div className="bg-green-50 rounded-lg p-4 text-center cursor-pointer hover:bg-green-100" onClick={() => setFilter('ok')}>
                  <div className="text-2xl font-bold text-green-600">{result.summary.okItems}</div>
                  <div className="text-xs text-green-700">OK</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-100" onClick={() => setFilter('surplus')}>
                  <div className="text-2xl font-bold text-blue-600">{result.summary.surplusItems}</div>
                  <div className="text-xs text-blue-700">Surplus</div>
                </div>
                <div className="bg-[#8FA894]/20 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-[#8FA894]">{getTotalCurrentOrder()}</div>
                  <div className="text-xs text-[#8FA894]">Your Order</div>
                </div>
              </div>

              {/* AI Summary */}
              <Card className="border-[#B8A8D8] bg-[#B8A8D8]/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <svg className="w-4 h-4 text-[#B8A8D8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    AI Analysis & Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-slate-700">{renderMarkdown(result.summary.aiSummary)}</div>
                </CardContent>
              </Card>

              {/* Filter Tabs */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Filter:</span>
                {(['all', 'critical', 'low', 'ok', 'surplus'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                      filter === f ? 'bg-[#8FA894] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              {/* Items Table with Per-Size Ordering */}
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#F5F3F0]">
                    <tr>
                      <th className="text-left p-3 font-medium w-8"></th>
                      <th className="text-left p-3 font-medium">Style / Color</th>
                      <th className="text-center p-3 font-medium">Status</th>
                      <th className="text-right p-3 font-medium">Net Stock</th>
                      <th className="text-right p-3 font-medium">Historical</th>
                      <th className="text-right p-3 font-medium">AI Suggest</th>
                      <th className="text-right p-3 font-medium">Your Order</th>
                      <th className="text-center p-3 font-medium w-24">Feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, idx) => {
                      const itemKey = `${item.style_no}|${item.color}`;
                      const isExpanded = expandedItem === itemKey;
                      const currentOrder = getCurrentOrder(item);
                      const totalOrder = currentOrder.reduce((a, b) => a + b, 0);
                      const netNeed = calculateNetNeed(item);
                      const fb = feedback[itemKey];

                      return (
                        <React.Fragment key={idx}>
                          <tr className={`border-t hover:bg-slate-50 ${isExpanded ? 'bg-[#F5F3F0]' : ''}`}>
                            <td className="p-3 text-center cursor-pointer" onClick={() => toggleExpand(itemKey)}>
                              <svg className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </td>
                            <td className="p-3 cursor-pointer" onClick={() => toggleExpand(itemKey)}>
                              <div className="font-medium">{item.style_name || item.style_no}</div>
                              <div className="text-xs text-slate-500">{item.color}</div>
                            </td>
                            <td className="p-3 text-center">{getStatusBadge(item.status)}</td>
                            <td className={`p-3 text-right font-medium ${item.totalNetStock < 0 ? 'text-red-600' : ''}`}>
                              {item.totalNetStock}
                            </td>
                            <td className="p-3 text-right text-slate-600">{item.totalHistorical}</td>
                            <td className="p-3 text-right text-slate-500">{item.suggestedOrder}</td>
                            <td className="p-3 text-right">
                              <span className={`font-bold ${totalOrder > 0 ? 'text-[#8FA894]' : 'text-slate-400'}`}>
                                {totalOrder > 0 ? `+${totalOrder}` : '—'}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={() => setItemFeedback(itemKey, fb?.verdict === 'correct' ? null : 'correct')}
                                  className={`p-1 rounded transition-colors ${
                                    fb?.verdict === 'correct' 
                                      ? 'bg-green-500 text-white' 
                                      : 'bg-slate-100 text-slate-400 hover:bg-green-100'
                                  }`}
                                  title="Mark as Correct"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => setItemFeedback(itemKey, fb?.verdict === 'incorrect' ? null : 'incorrect')}
                                  className={`p-1 rounded transition-colors ${
                                    fb?.verdict === 'incorrect' 
                                      ? 'bg-red-500 text-white' 
                                      : 'bg-slate-100 text-slate-400 hover:bg-red-100'
                                  }`}
                                  title="Mark as Incorrect"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                                {fb?.saved && (
                                  <span className="text-[10px] text-green-600">✓</span>
                                )}
                              </div>
                            </td>
                          </tr>
                          
                          {/* Expanded Detail with Per-Size Order Inputs */}
                          {isExpanded && (
                            <tr className="border-t bg-slate-50">
                              <td colSpan={8} className="p-4">
                                <div className="space-y-4">
                                  {/* Size Breakdown Table with Order Inputs */}
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs border">
                                      <thead className="bg-slate-100">
                                        <tr>
                                          <th className="p-2 text-left border-r font-medium w-28">Metric</th>
                                          {item.sizes.map((size, i) => (
                                            <th key={i} className="p-2 text-center border-r font-medium min-w-[60px]">{size}</th>
                                          ))}
                                          <th className="p-2 text-center font-bold bg-slate-200 w-20">Total</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Stock</td>
                                          {item.stock.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r">{v}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100">{item.totalStock}</td>
                                        </tr>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Sold</td>
                                          {item.sold.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r text-red-600">{v > 0 ? `-${v}` : '0'}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100 text-red-600">
                                            {item.totalSold > 0 ? `-${item.totalSold}` : '0'}
                                          </td>
                                        </tr>
                                        <tr className="border-t bg-amber-50">
                                          <td className="p-2 font-medium border-r bg-amber-100">Net Stock</td>
                                          {item.netStock.map((v, i) => (
                                            <td key={i} className={`p-2 text-center border-r font-semibold ${v < 0 ? 'text-red-700' : ''}`}>{v}</td>
                                          ))}
                                          <td className={`p-2 text-center font-bold bg-amber-100 ${item.totalNetStock < 0 ? 'text-red-700' : ''}`}>
                                            {item.totalNetStock}
                                          </td>
                                        </tr>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Historical</td>
                                          {item.historical.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r text-blue-600">{v}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100 text-blue-600">{item.totalHistorical}</td>
                                        </tr>
                                        <tr className="border-t bg-[#8FA894]/10">
                                          <td className="p-2 font-medium border-r bg-[#8FA894]/20">
                                            <div className="flex items-center gap-1">
                                              Order
                                              <button
                                                onClick={() => applySuggestion(itemKey, item.suggestedOrderBySize || [])}
                                                className="text-[9px] px-1 py-0.5 bg-[#8FA894] text-white rounded hover:bg-[#8FA894]/80"
                                                title="Apply AI Suggestion"
                                              >
                                                AI
                                              </button>
                                            </div>
                                          </td>
                                          {item.sizes.map((_, i) => (
                                            <td key={i} className="p-1 text-center border-r">
                                              <input
                                                type="number"
                                                min={0}
                                                value={currentOrder[i] || 0}
                                                onChange={(e) => updateOrder(itemKey, i, parseInt(e.target.value) || 0)}
                                                className="w-full text-center text-xs p-1 border rounded focus:ring-1 focus:ring-[#8FA894] focus:border-[#8FA894]"
                                              />
                                            </td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-[#8FA894]/20 text-[#8FA894]">
                                            +{totalOrder}
                                          </td>
                                        </tr>
                                        <tr className="border-t bg-purple-50">
                                          <td className="p-2 font-medium border-r bg-purple-100">Net Need</td>
                                          {netNeed.map((v, i) => (
                                            <td key={i} className={`p-2 text-center border-r font-semibold ${
                                              v > 0 ? 'text-red-600' : v < 0 ? 'text-green-600' : ''
                                            }`}>
                                              {v > 0 ? v : v < 0 ? `+${Math.abs(v)}` : '✓'}
                                            </td>
                                          ))}
                                          <td className={`p-2 text-center font-bold bg-purple-100 ${
                                            netNeed.reduce((a, b) => a + b, 0) > 0 ? 'text-red-600' : 'text-green-600'
                                          }`}>
                                            {netNeed.reduce((a, b) => a + b, 0)}
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>

                                  {/* Feedback Notes */}
                                  {fb?.verdict && (
                                    <div className="flex items-center gap-3 pt-2 border-t">
                                      <input
                                        type="text"
                                        placeholder="Add a note about this suggestion..."
                                        value={fb.notes}
                                        onChange={(e) => setFeedback(prev => ({
                                          ...prev,
                                          [itemKey]: { ...prev[itemKey], notes: e.target.value, saved: false }
                                        }))}
                                        className="flex-1 text-xs p-2 border rounded"
                                      />
                                      <Button
                                        size="sm"
                                        onClick={() => saveFeedback(item)}
                                        disabled={fb.saved}
                                        className="text-xs"
                                      >
                                        {fb.saved ? 'Saved' : 'Save Feedback'}
                                      </Button>
                                    </div>
                                  )}

                                  {/* Item Stats */}
                                  <div className="flex items-center gap-6 text-xs text-slate-600">
                                    <div><span className="text-slate-500">Weekly Rate:</span> <strong>{item.weeklyRate.toFixed(1)}/wk</strong></div>
                                    <div><span className="text-slate-500">Target:</span> <strong>{item.targetStock}</strong></div>
                                    <div><span className="text-slate-500">AI Suggested:</span> <strong className="text-[#B8A8D8]">+{item.suggestedOrder}</strong></div>
                                    <div><span className="text-slate-500">Your Order:</span> <strong className="text-[#8FA894]">+{totalOrder}</strong></div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {filteredItems.length === 0 && (
                  <div className="p-8 text-center text-slate-500">No items match the selected filter</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t bg-[#F5F3F0]">
          {result && !loading ? (
            <>
              <Button variant="outline" onClick={() => { setFilter('all'); onRunAnalysis(); }}>
                Re-run Analysis
              </Button>
              <div className="flex gap-2">
                <Button
                  onClick={saveAnalysis}
                  disabled={saving || savedAnalysisId !== null}
                  className="bg-[#8FA894] hover:bg-[#8FA894]/80"
                >
                  {saving ? 'Saving...' : savedAnalysisId ? 'Analysis Saved' : `Save Analysis (${getTotalCurrentOrder()} units)`}
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <div className="w-full flex justify-end">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


