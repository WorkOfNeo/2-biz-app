'use client';
import React from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { Button } from '../../../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../../components/ui/card';
import { Badge } from '../../../../../components/ui/badge';

type AnalysisItem = {
  style_no: string;
  style_name: string;
  color: string;
  sizes: string[];
  stock: number[];
  sold: number[];
  netStock: number[];
  historical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalHistorical: number;
  weeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  suggestedOrderBySize: number[];
  userOrder?: number[];
  userOrderTotal?: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  trendDirection: 'up' | 'down' | 'stable';
  trendPercent: number;
};

type SavedAnalysis = {
  id: string;
  selections: Array<{ style_no: string; color: string }>;
  date_range_start: string;
  date_range_end: string;
  weeks_cover: number;
  items: AnalysisItem[];
  orders_by_style: Array<{
    style_no: string;
    style_name: string;
    totalOrder: number;
    colors: Array<{ color: string; order: number; status: string }>;
  }>;
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    totalUserOrder?: number;
    aiSummary?: string;
    trendSummary?: string;
  };
  ai_summary: string | null;
  supplier_rules_snapshot: any;
  created_at: string;
};

export default function AnalysisDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [expandedItem, setExpandedItem] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'critical' | 'low' | 'ok' | 'surplus'>('all');

  const { data: analysis, isLoading, error } = useSWR<SavedAnalysis>(
    `/api/call-off/save/${params.id}`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch analysis');
      const json = await res.json();
      return json.data;
    }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center space-y-4">
          <svg className="animate-spin h-8 w-8 mx-auto text-[#8FA894]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="text-slate-500">Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold text-slate-700 mb-2">Analysis not found</h2>
        <p className="text-slate-500 mb-6">The requested analysis could not be loaded.</p>
        <Button onClick={() => router.push('/purchase/make-order/analyses')} variant="outline">
          Back to Analyses
        </Button>
      </div>
    );
  }

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  };

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

  const filteredItems = (analysis.items || []).filter(item => {
    if (filter === 'all') return true;
    return item.status === filter;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" onClick={() => router.push('/purchase/make-order/analyses')} className="mb-2">
            ← Back to Analyses
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">
            Analysis: {formatDate(analysis.date_range_start)} - {formatDate(analysis.date_range_end)}
          </h1>
          <p className="text-sm text-slate-600">
            Created {new Date(analysis.created_at).toLocaleString()} • {analysis.weeks_cover} weeks cover
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-slate-50 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-slate-900">{analysis.summary.totalItems}</div>
          <div className="text-xs text-slate-600">Total Items</div>
        </div>
        <div className="bg-red-50 rounded-lg p-4 text-center cursor-pointer hover:bg-red-100" onClick={() => setFilter('critical')}>
          <div className="text-2xl font-bold text-red-600">{analysis.summary.criticalItems}</div>
          <div className="text-xs text-red-700">Critical</div>
        </div>
        <div className="bg-amber-50 rounded-lg p-4 text-center cursor-pointer hover:bg-amber-100" onClick={() => setFilter('low')}>
          <div className="text-2xl font-bold text-amber-600">{analysis.summary.lowItems}</div>
          <div className="text-xs text-amber-700">Low Stock</div>
        </div>
        <div className="bg-green-50 rounded-lg p-4 text-center cursor-pointer hover:bg-green-100" onClick={() => setFilter('ok')}>
          <div className="text-2xl font-bold text-green-600">{analysis.summary.okItems}</div>
          <div className="text-xs text-green-700">OK</div>
        </div>
        <div className="bg-blue-50 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-100" onClick={() => setFilter('surplus')}>
          <div className="text-2xl font-bold text-blue-600">{analysis.summary.surplusItems}</div>
          <div className="text-xs text-blue-700">Surplus</div>
        </div>
        <div className="bg-[#8FA894]/20 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-[#8FA894]">
            {analysis.summary.totalUserOrder ?? analysis.summary.totalSuggestedOrder}
          </div>
          <div className="text-xs text-[#8FA894]">Order Total</div>
        </div>
      </div>

      {/* AI Summary */}
      {analysis.ai_summary && (
        <Card className="border-[#B8A8D8] bg-[#B8A8D8]/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <svg className="w-4 h-4 text-[#B8A8D8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              AI Analysis
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-slate-700 whitespace-pre-wrap">{analysis.ai_summary}</div>
          </CardContent>
        </Card>
      )}

      {/* Order by Style */}
      {analysis.orders_by_style && analysis.orders_by_style.length > 0 && (
        <Card className="border-[#8FA894]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Order Summary by Style</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {analysis.orders_by_style.map((style, idx) => (
                <div key={idx} className="border rounded-lg p-3 bg-white">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-sm">{style.style_name || style.style_no}</span>
                    <span className="text-lg font-bold text-[#8FA894]">+{style.totalOrder}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {style.colors.map((c, i) => (
                      <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                        {c.color}: +{c.order}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Items Table */}
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
              <th className="text-right p-3 font-medium">Ordered</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item, idx) => {
              const itemKey = `${item.style_no}|${item.color}`;
              const isExpanded = expandedItem === itemKey;
              const orderTotal = item.userOrderTotal ?? item.suggestedOrder;

              return (
                <React.Fragment key={idx}>
                  <tr 
                    className={`border-t hover:bg-slate-50 cursor-pointer ${isExpanded ? 'bg-[#F5F3F0]' : ''}`}
                    onClick={() => setExpandedItem(isExpanded ? null : itemKey)}
                  >
                    <td className="p-3 text-center">
                      <svg className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </td>
                    <td className="p-3">
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
                      <span className={`font-bold ${orderTotal > 0 ? 'text-[#8FA894]' : 'text-slate-400'}`}>
                        {orderTotal > 0 ? `+${orderTotal}` : '—'}
                      </span>
                    </td>
                  </tr>
                  
                  {/* Expanded Detail */}
                  {isExpanded && (
                    <tr className="border-t bg-slate-50">
                      <td colSpan={7} className="p-4">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border">
                            <thead className="bg-slate-100">
                              <tr>
                                <th className="p-2 text-left border-r font-medium w-28">Metric</th>
                                {item.sizes.map((size, i) => (
                                  <th key={i} className="p-2 text-center border-r font-medium min-w-[50px]">{size}</th>
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
                                <td className="p-2 font-medium border-r bg-[#8FA894]/20">Order</td>
                                {(item.userOrder || item.suggestedOrderBySize || []).map((v, i) => (
                                  <td key={i} className="p-2 text-center border-r text-[#8FA894] font-semibold">{v > 0 ? `+${v}` : '—'}</td>
                                ))}
                                <td className="p-2 text-center font-bold bg-[#8FA894]/20 text-[#8FA894]">+{orderTotal}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <div className="flex items-center gap-6 text-xs text-slate-600 mt-3">
                          <div><span className="text-slate-500">Weekly Rate:</span> <strong>{item.weeklyRate?.toFixed(1) || '—'}/wk</strong></div>
                          <div><span className="text-slate-500">Target:</span> <strong>{item.targetStock}</strong></div>
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
    </div>
  );
}


