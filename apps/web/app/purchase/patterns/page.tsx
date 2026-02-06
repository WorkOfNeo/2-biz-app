'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Badge } from '../../../components/ui/badge';
import { 
  TrendingUp, TrendingDown, Minus, Package, 
  CheckCircle2, XCircle, AlertCircle, BarChart3
} from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

const supabase = createClientComponentClient();

type PatternData = {
  summary: {
    totalRounds: number;
    totalSuggestions: number;
    approvedCount: number;
    adjustedCount: number;
    skippedCount: number;
    avgAdjustmentRatio: number | null;
    approvalRate: number;
  };
  trendsByWeek: Array<{
    week: string;
    avgRatio: number;
    count: number;
  }>;
  supplierPatterns: Array<{
    supplier: string;
    totalSuggestions: number;
    adjustedCount: number;
    skippedCount: number;
    avgAdjustmentRatio: number | null;
    skipRate: number;
  }>;
  stagePatterns: Record<string, {
    avgRatio: number | null;
    count: number;
    approvalRate: number;
    adjustedCount: number;
  }>;
  topAdjustedStyles: Array<{
    style_no: string;
    color: string;
    avgSuggested: number;
    avgAdjusted: number;
    avgRatio: number;
    count: number;
  }>;
  adjustmentDistribution: {
    decrease_50plus: number;
    decrease_25_50: number;
    decrease_0_25: number;
    no_change: number;
    increase_0_25: number;
    increase_25_50: number;
    increase_50plus: number;
  };
};

export default function PurchasePatternsPage() {
  const [days, setDays] = useState(90);
  const [activeTab, setActiveTab] = useState('overview');
  
  const { data: patterns, error, isLoading } = useSWR<PatternData>(
    `/api/purchase/patterns?days=${days}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch patterns');
      return res.json();
    },
    { refreshInterval: 60000 }
  );
  
  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-64" />
          <div className="h-32 bg-slate-200 rounded" />
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <p className="text-red-600">Failed to load purchase patterns</p>
            <p className="text-sm text-slate-500 mt-2">{error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  return (
    <div className="page-container-wide space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Purchase Patterns</h1>
          <p className="text-slate-500 mt-1">
            Analyze AI performance and learn from completed purchase rounds
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          <Badge className="text-sm py-1 px-3 bg-slate-100 text-slate-700">
            {patterns?.summary.totalRounds || 0} rounds analyzed
          </Badge>
          
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
      </div>
      
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-slate-100">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="insights">Adjustment Insights</TabsTrigger>
          <TabsTrigger value="suppliers">Supplier Analysis</TabsTrigger>
        </TabsList>
        
        <TabsContent value="overview" className="space-y-6 mt-6">
          {/* Overview content will be added in next step */}
          <OverviewTab patterns={patterns} />
        </TabsContent>
        
        <TabsContent value="insights" className="space-y-6 mt-6">
          {/* Insights content will be added in next step */}
          <AdjustmentInsightsTab patterns={patterns} />
        </TabsContent>
        
        <TabsContent value="suppliers" className="space-y-6 mt-6">
          {/* Supplier content will be added in next step */}
          <SupplierAnalysisTab patterns={patterns} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Tab components defined below
function OverviewTab({ patterns }: { patterns: PatternData | undefined }) {
  if (!patterns) return null;
  
  const { summary, trendsByWeek, stagePatterns } = patterns;
  
  // Determine trend direction for adjustment ratio
  const getTrendIcon = () => {
    if (!summary.avgAdjustmentRatio) return <Minus className="h-5 w-5 text-slate-400" />;
    
    if (summary.avgAdjustmentRatio > 1.1) {
      return <TrendingUp className="h-5 w-5 text-green-600" />;
    } else if (summary.avgAdjustmentRatio < 0.9) {
      return <TrendingDown className="h-5 w-5 text-red-600" />;
    }
    return <Minus className="h-5 w-5 text-slate-400" />;
  };
  
  // Find most adjusted supplier
  const mostAdjustedSupplier = patterns.supplierPatterns.length > 0
    ? patterns.supplierPatterns.reduce((prev, curr) => 
        curr.adjustedCount > prev.adjustedCount ? curr : prev
      )
    : null;
  
  // Prepare stage data for chart
  const stageChartData = Object.entries(stagePatterns).map(([stage, data]) => ({
    stage: stage.charAt(0).toUpperCase() + stage.slice(1),
    avgRatio: data.avgRatio || 0,
    approvalRate: data.approvalRate * 100,
    count: data.count,
  }));
  
  // Format trend data for chart
  const trendChartData = trendsByWeek.map(w => ({
    week: new Date(w.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    ratio: w.avgRatio,
    count: w.count,
  }));
  
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Total Rounds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totalRounds}</div>
            <p className="text-xs text-slate-500 mt-1">
              {summary.totalSuggestions} total suggestions
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Avg Adjustment Ratio
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold">
                {summary.avgAdjustmentRatio 
                  ? `${(summary.avgAdjustmentRatio * 100).toFixed(0)}%`
                  : 'N/A'}
              </div>
              {getTrendIcon()}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {summary.adjustedCount} adjustments made
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Approval Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold">
                {(summary.approvalRate * 100).toFixed(1)}%
              </div>
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {summary.approvedCount} approved as-is
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Most Adjusted Supplier
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">
              {mostAdjustedSupplier?.supplier || 'N/A'}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {mostAdjustedSupplier?.adjustedCount || 0} adjustments
            </p>
          </CardContent>
        </Card>
      </div>
      
      {/* Trend Chart */}
      {trendChartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Adjustment Trend Over Time</CardTitle>
            <CardDescription>
              Shows how your adjustment ratio has changed week by week
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={trendChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="week" 
                  tick={{ fontSize: 12 }}
                />
                <YAxis 
                  label={{ value: 'Adjustment Ratio', angle: -90, position: 'insideLeft' }}
                  domain={[0, 'auto']}
                />
                <Tooltip 
                  formatter={(value: any, name: string) => {
                    if (name === 'ratio') return [`${(value * 100).toFixed(0)}%`, 'Avg Ratio'];
                    return [value, name];
                  }}
                />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="ratio" 
                  stroke="#3b82f6" 
                  strokeWidth={2}
                  name="Adjustment Ratio"
                  dot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
      
      {/* Stage Comparison */}
      {stageChartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Adjustment by Purchase Stage</CardTitle>
            <CardDescription>
              Compare your buying behavior across early, mid, and closing stages
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stageChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="stage" />
                <YAxis 
                  yAxisId="left"
                  label={{ value: 'Adjustment Ratio', angle: -90, position: 'insideLeft' }}
                />
                <YAxis 
                  yAxisId="right"
                  orientation="right"
                  label={{ value: 'Approval Rate (%)', angle: 90, position: 'insideRight' }}
                />
                <Tooltip 
                  formatter={(value: any, name: string) => {
                    if (name === 'avgRatio') return [`${(value * 100).toFixed(0)}%`, 'Avg Adjustment'];
                    if (name === 'approvalRate') return [`${value.toFixed(1)}%`, 'Approval Rate'];
                    return [value, name];
                  }}
                />
                <Legend />
                <Bar yAxisId="left" dataKey="avgRatio" fill="#3b82f6" name="Avg Adjustment" />
                <Bar yAxisId="right" dataKey="approvalRate" fill="#10b981" name="Approval Rate" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
      
      {/* Empty state */}
      {trendChartData.length === 0 && stageChartData.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <BarChart3 className="h-12 w-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No pattern data available yet</p>
            <p className="text-sm text-slate-400 mt-1">
              Complete more purchase rounds to see insights
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AdjustmentInsightsTab({ patterns }: { patterns: PatternData | undefined }) {
  if (!patterns) return null;
  
  const { summary, adjustmentDistribution, topAdjustedStyles } = patterns;
  
  // Prepare distribution data for chart
  const distributionData = [
    { label: '-50%+', value: adjustmentDistribution.decrease_50plus, color: '#dc2626' },
    { label: '-25-50%', value: adjustmentDistribution.decrease_25_50, color: '#f97316' },
    { label: '-0-25%', value: adjustmentDistribution.decrease_0_25, color: '#fbbf24' },
    { label: 'No Change', value: adjustmentDistribution.no_change, color: '#94a3b8' },
    { label: '+0-25%', value: adjustmentDistribution.increase_0_25, color: '#4ade80' },
    { label: '+25-50%', value: adjustmentDistribution.increase_25_50, color: '#22c55e' },
    { label: '+50%+', value: adjustmentDistribution.increase_50plus, color: '#16a34a' },
  ].filter(d => d.value > 0);
  
  // Verdict breakdown for pie chart
  const verdictData = [
    { name: 'Approved', value: summary.approvedCount, color: '#10b981' },
    { name: 'Adjusted', value: summary.adjustedCount, color: '#3b82f6' },
    { name: 'Skipped', value: summary.skippedCount, color: '#ef4444' },
  ].filter(d => d.value > 0);
  
  return (
    <div className="space-y-6">
      {/* Verdict Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Review Verdict Breakdown</CardTitle>
            <CardDescription>
              How you typically respond to AI suggestions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={verdictData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={(entry) => `${entry.name}: ${entry.value}`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {verdictData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {summary.approvedCount}
                </div>
                <div className="text-xs text-slate-500">Approved</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {summary.adjustedCount}
                </div>
                <div className="text-xs text-slate-500">Adjusted</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">
                  {summary.skippedCount}
                </div>
                <div className="text-xs text-slate-500">Skipped</div>
              </div>
            </div>
          </CardContent>
        </Card>
        
        {/* Adjustment Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>Adjustment Distribution</CardTitle>
            <CardDescription>
              How much you typically increase or decrease quantities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={distributionData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="label" type="category" width={80} />
                <Tooltip />
                <Bar dataKey="value" fill="#3b82f6">
                  {distributionData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
      
      {/* Top Adjusted Styles */}
      <Card>
        <CardHeader>
          <CardTitle>Most Frequently Adjusted Styles</CardTitle>
          <CardDescription>
            Styles where you most often change the AI suggestion
          </CardDescription>
        </CardHeader>
        <CardContent>
          {topAdjustedStyles.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th className="py-3 px-4 font-medium text-slate-500">Style</th>
                    <th className="py-3 px-4 font-medium text-slate-500">Color</th>
                    <th className="py-3 px-4 font-medium text-slate-500 text-right">Avg Suggested</th>
                    <th className="py-3 px-4 font-medium text-slate-500 text-right">Avg Adjusted</th>
                    <th className="py-3 px-4 font-medium text-slate-500 text-right">Ratio</th>
                    <th className="py-3 px-4 font-medium text-slate-500 text-right">Frequency</th>
                  </tr>
                </thead>
                <tbody>
                  {topAdjustedStyles.slice(0, 15).map((style, idx) => {
                    const ratioColor = 
                      style.avgRatio > 1.1 ? 'text-green-600' :
                      style.avgRatio < 0.9 ? 'text-red-600' :
                      'text-slate-600';
                    
                    return (
                      <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-3 px-4 font-medium">{style.style_no}</td>
                        <td className="py-3 px-4">{style.color}</td>
                        <td className="py-3 px-4 text-right">{style.avgSuggested}</td>
                        <td className="py-3 px-4 text-right font-medium">{style.avgAdjusted}</td>
                        <td className={`py-3 px-4 text-right font-bold ${ratioColor}`}>
                          {(style.avgRatio * 100).toFixed(0)}%
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Badge className="bg-slate-100 text-slate-700">{style.count}×</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-slate-500">
              No adjusted styles yet
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SupplierAnalysisTab({ patterns }: { patterns: PatternData | undefined }) {
  if (!patterns) return null;
  
  const { supplierPatterns } = patterns;
  const [sortBy, setSortBy] = useState<'suggestions' | 'adjustments' | 'ratio' | 'skipRate'>('suggestions');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  
  const sortedSuppliers = [...supplierPatterns].sort((a, b) => {
    let aVal: number, bVal: number;
    
    switch (sortBy) {
      case 'suggestions':
        aVal = a.totalSuggestions;
        bVal = b.totalSuggestions;
        break;
      case 'adjustments':
        aVal = a.adjustedCount;
        bVal = b.adjustedCount;
        break;
      case 'ratio':
        aVal = a.avgAdjustmentRatio || 0;
        bVal = b.avgAdjustmentRatio || 0;
        break;
      case 'skipRate':
        aVal = a.skipRate;
        bVal = b.skipRate;
        break;
      default:
        return 0;
    }
    
    return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
  });
  
  const handleSort = (column: typeof sortBy) => {
    if (sortBy === column) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(column);
      setSortDir('desc');
    }
  };
  
  // Generate insights
  const insights: string[] = [];
  
  if (supplierPatterns.length > 0) {
    const highRatioSuppliers = supplierPatterns.filter(s => 
      s.avgAdjustmentRatio && s.avgAdjustmentRatio > 1.25
    );
    const lowRatioSuppliers = supplierPatterns.filter(s => 
      s.avgAdjustmentRatio && s.avgAdjustmentRatio < 0.75
    );
    const wellCalibratedSuppliers = supplierPatterns.filter(s => 
      s.totalSuggestions >= 5 && s.skipRate < 0.1 && 
      s.avgAdjustmentRatio && Math.abs(s.avgAdjustmentRatio - 1.0) < 0.15
    );
    
    if (highRatioSuppliers.length > 0) {
      const top = highRatioSuppliers[0];
      if (top && top.avgAdjustmentRatio) {
        insights.push(
          `You typically increase quantities from ${top.supplier} by ${((top.avgAdjustmentRatio - 1) * 100).toFixed(0)}%`
        );
      }
    }
    
    if (lowRatioSuppliers.length > 0) {
      const top = lowRatioSuppliers[0];
      if (top && top.avgAdjustmentRatio) {
        insights.push(
          `You typically decrease quantities from ${top.supplier} by ${((1 - top.avgAdjustmentRatio) * 100).toFixed(0)}%`
        );
      }
    }
    
    if (wellCalibratedSuppliers.length > 0) {
      const top = wellCalibratedSuppliers[0];
      if (top) {
        insights.push(
          `${top.supplier} has ${((1 - top.skipRate) * 100).toFixed(0)}% acceptance rate - AI is well-calibrated`
        );
      }
    }
    
    const highSkipSuppliers = supplierPatterns.filter(s => s.skipRate > 0.3);
    if (highSkipSuppliers.length > 0) {
      const top = highSkipSuppliers[0];
      if (top) {
        insights.push(
          `You skip ${(top.skipRate * 100).toFixed(0)}% of suggestions from ${top.supplier}`
        );
      }
    }
  }
  
  return (
    <div className="space-y-6">
      {/* Insights Cards */}
      {insights.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {insights.map((insight, idx) => (
            <Card key={idx}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <BarChart3 className="h-5 w-5 text-blue-600" />
                  </div>
                  <p className="text-sm text-slate-700 flex-1">{insight}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      
      {/* Supplier Performance Table */}
      <Card>
        <CardHeader>
          <CardTitle>Supplier Performance</CardTitle>
          <CardDescription>
            Detailed analysis of how you interact with AI suggestions per supplier
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sortedSuppliers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th className="py-3 px-4 font-medium text-slate-500">Supplier</th>
                    <th 
                      className="py-3 px-4 font-medium text-slate-500 text-right cursor-pointer hover:text-slate-700"
                      onClick={() => handleSort('suggestions')}
                    >
                      Suggestions {sortBy === 'suggestions' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th 
                      className="py-3 px-4 font-medium text-slate-500 text-right cursor-pointer hover:text-slate-700"
                      onClick={() => handleSort('adjustments')}
                    >
                      Adjustments {sortBy === 'adjustments' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th 
                      className="py-3 px-4 font-medium text-slate-500 text-right cursor-pointer hover:text-slate-700"
                      onClick={() => handleSort('ratio')}
                    >
                      Avg Ratio {sortBy === 'ratio' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th 
                      className="py-3 px-4 font-medium text-slate-500 text-right cursor-pointer hover:text-slate-700"
                      onClick={() => handleSort('skipRate')}
                    >
                      Skip Rate {sortBy === 'skipRate' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="py-3 px-4 font-medium text-slate-500 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSuppliers.map((supplier, idx) => {
                    const ratioColor = 
                      supplier.avgAdjustmentRatio && supplier.avgAdjustmentRatio > 1.15 ? 'text-green-600' :
                      supplier.avgAdjustmentRatio && supplier.avgAdjustmentRatio < 0.85 ? 'text-red-600' :
                      'text-slate-600';
                    
                    const skipRateColor = 
                      supplier.skipRate > 0.3 ? 'text-red-600' :
                      supplier.skipRate > 0.15 ? 'text-orange-600' :
                      'text-slate-600';
                    
                    // Determine status badge
                    let status = { label: 'Neutral', color: 'bg-slate-100 text-slate-700' };
                    if (supplier.avgAdjustmentRatio) {
                      if (supplier.avgAdjustmentRatio > 1.15) {
                        status = { label: 'Buy More', color: 'bg-green-100 text-green-700' };
                      } else if (supplier.avgAdjustmentRatio < 0.85) {
                        status = { label: 'Buy Less', color: 'bg-red-100 text-red-700' };
                      } else if (supplier.skipRate < 0.1) {
                        status = { label: 'Well-calibrated', color: 'bg-blue-100 text-blue-700' };
                      }
                    }
                    
                    if (supplier.skipRate > 0.3) {
                      status = { label: 'Often Skipped', color: 'bg-orange-100 text-orange-700' };
                    }
                    
                    return (
                      <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-3 px-4 font-medium">{supplier.supplier}</td>
                        <td className="py-3 px-4 text-right">{supplier.totalSuggestions}</td>
                        <td className="py-3 px-4 text-right">{supplier.adjustedCount}</td>
                        <td className={`py-3 px-4 text-right font-bold ${ratioColor}`}>
                          {supplier.avgAdjustmentRatio 
                            ? `${(supplier.avgAdjustmentRatio * 100).toFixed(0)}%` 
                            : 'N/A'}
                        </td>
                        <td className={`py-3 px-4 text-right ${skipRateColor}`}>
                          {(supplier.skipRate * 100).toFixed(1)}%
                        </td>
                        <td className="py-3 px-4 text-center">
                          <Badge className={status.color}>{status.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-slate-500">
              No supplier data yet
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
