'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Badge } from '../../../components/ui/badge';
import { 
  TrendingUp, TrendingDown, Minus, Brain,
  CheckCircle2, XCircle, AlertCircle, BarChart3, Activity
} from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

const supabase = createClientComponentClient();

type PromptPerformance = {
  summary: {
    currentPromptKey: string;
    currentVersion: number | null;
    currentVersionUpdated: string | null;
    totalRounds: number;
    totalSuggestions: number;
    latestApprovalRate: number;
    latestSkipRate: number;
    latestAvgAdjustmentRatio: number | null;
    approvalRateChange?: number;
    skipRateChange?: number;
  };
  versionMetrics: Array<{
    version: string;
    versionNumber: number | null;
    roundCount: number;
    totalSuggestions: number;
    approvedCount: number;
    adjustedCount: number;
    skippedCount: number;
    approvalRate: number;
    skipRate: number;
    avgAdjustmentRatio: number | null;
    firstUsed: string | null;
    lastUsed: string | null;
  }>;
  stageMetrics: Record<string, Array<{
    version: string;
    versionNumber: number | null;
    approvalRate: number;
    count: number;
  }>>;
  supplierMetrics: Array<{
    supplier: string;
    totalSuggestions: number;
    versions: Array<{
      version: string;
      versionNumber: number | null;
      approvalRate: number;
      count: number;
    }>;
  }>;
};

export default function PromptPerformancePage() {
  const [days, setDays] = useState(90);
  const [activeTab, setActiveTab] = useState('overview');
  
  const { data: performance, error, isLoading } = useSWR<PromptPerformance>(
    `/api/purchase/patterns?days=${days}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch prompt performance');
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
            <p className="text-red-600">Failed to load prompt performance</p>
            <p className="text-sm text-slate-500 mt-2">{error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Brain className="h-8 w-8 text-indigo-600" />
            Prompt Performance
          </h1>
          <p className="text-slate-500 mt-1">
            Track AI prompt versions and analyze performance improvements
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          <Badge className="text-sm py-1 px-3 bg-slate-100 text-slate-700">
            {performance?.summary.totalRounds || 0} rounds analyzed
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
          <TabsTrigger value="versions">Version Comparison</TabsTrigger>
          <TabsTrigger value="context">Context Performance</TabsTrigger>
        </TabsList>
        
        <TabsContent value="overview" className="space-y-6 mt-6">
          <OverviewTab performance={performance} />
        </TabsContent>
        
        <TabsContent value="versions" className="space-y-6 mt-6">
          <VersionComparisonTab performance={performance} />
        </TabsContent>
        
        <TabsContent value="context" className="space-y-6 mt-6">
          <ContextPerformanceTab performance={performance} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Overview Tab
function OverviewTab({ performance }: { performance: PromptPerformance | undefined }) {
  if (!performance) return null;
  
  const { summary, versionMetrics } = performance;
  
  // Determine trend icon
  const getTrendIcon = (change?: number) => {
    if (change === undefined) return <Minus className="h-5 w-5 text-slate-400" />;
    if (change > 0.02) return <TrendingUp className="h-5 w-5 text-green-600" />;
    if (change < -0.02) return <TrendingDown className="h-5 w-5 text-red-600" />;
    return <Minus className="h-5 w-5 text-slate-400" />;
  };
  
  // Prepare chart data
  const versionChartData = versionMetrics.map(v => ({
    version: v.version,
    approvalRate: v.approvalRate * 100,
    skipRate: v.skipRate * 100,
    suggestions: v.totalSuggestions,
  })).reverse(); // Oldest to newest
  
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Active Version
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-600">
              {summary.currentVersion ? `v${summary.currentVersion}` : 'Unknown'}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {summary.currentPromptKey || 'No prompt key'}
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Current Approval Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold text-emerald-600">
                {(summary.latestApprovalRate * 100).toFixed(1)}%
              </div>
              {getTrendIcon(summary.approvalRateChange)}
            </div>
            {summary.approvalRateChange !== undefined && (
              <p className="text-xs text-slate-500 mt-1">
                {summary.approvalRateChange > 0 ? '+' : ''}
                {(summary.approvalRateChange * 100).toFixed(1)}% from previous
              </p>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Skip Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold text-slate-900">
                {(summary.latestSkipRate * 100).toFixed(1)}%
              </div>
              {summary.skipRateChange !== undefined && summary.skipRateChange < 0 && (
                <TrendingDown className="h-5 w-5 text-green-600" />
              )}
            </div>
            {summary.skipRateChange !== undefined && (
              <p className="text-xs text-slate-500 mt-1">
                {summary.skipRateChange > 0 ? '+' : ''}
                {(summary.skipRateChange * 100).toFixed(1)}% from previous
              </p>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Total Analyzed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totalSuggestions.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">
              {summary.totalRounds} purchase rounds
            </p>
          </CardContent>
        </Card>
      </div>
      
      {/* Version Performance Chart */}
      {versionChartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Prompt Version Evolution</CardTitle>
            <CardDescription>
              How approval and skip rates have changed across prompt versions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={versionChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="version" />
                <YAxis label={{ value: 'Rate (%)', angle: -90, position: 'insideLeft' }} />
                <Tooltip 
                  formatter={(value: any) => `${value.toFixed(1)}%`}
                />
                <Legend />
                <Bar dataKey="approvalRate" fill="#10b981" name="Approval Rate" />
                <Bar dataKey="skipRate" fill="#ef4444" name="Skip Rate" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
      
      {/* Key Insights */}
      {versionMetrics.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-600" />
              Key Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary.approvalRateChange && summary.approvalRateChange > 0.05 && (
              <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg">
                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-green-900">Strong Improvement</p>
                  <p className="text-sm text-green-700">
                    Latest version improved approval rate by {(summary.approvalRateChange * 100).toFixed(1)}% - keep it active!
                  </p>
                </div>
              </div>
            )}
            
            {versionMetrics[0]?.approvalRate > 0.7 && (
              <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
                <Brain className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-blue-900">Well-Calibrated Prompt</p>
                  <p className="text-sm text-blue-700">
                    {versionMetrics[0].version} has {(versionMetrics[0].approvalRate * 100).toFixed(1)}% approval rate - AI suggestions are on target
                  </p>
                </div>
              </div>
            )}
            
            {versionMetrics[0]?.skipRate > 0.15 && (
              <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg">
                <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-amber-900">Room for Improvement</p>
                  <p className="text-sm text-amber-700">
                    {(versionMetrics[0].skipRate * 100).toFixed(1)}% of suggestions are being skipped - consider refining the prompt
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      
      {/* Empty state */}
      {versionMetrics.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Brain className="h-12 w-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No prompt performance data available yet</p>
            <p className="text-sm text-slate-400 mt-1">
              Complete purchase rounds to start tracking prompt improvements
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Version Comparison Tab
function VersionComparisonTab({ performance }: { performance: PromptPerformance | undefined }) {
  if (!performance) return null;
  
  const { versionMetrics } = performance;
  
  if (versionMetrics.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <BarChart3 className="h-12 w-12 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">No version data available</p>
        </CardContent>
      </Card>
    );
  }
  
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Version Metrics Comparison</CardTitle>
          <CardDescription>
            Detailed performance metrics for each prompt version
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="py-3 px-4 text-left font-medium text-slate-500">Version</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Rounds</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Suggestions</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Approved</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Adjusted</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Skipped</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Approval Rate</th>
                  <th className="py-3 px-4 text-right font-medium text-slate-500">Skip Rate</th>
                  <th className="py-3 px-4 text-center font-medium text-slate-500">Period</th>
                </tr>
              </thead>
              <tbody>
                {versionMetrics.map((v, idx) => {
                  const isLatest = idx === 0;
                  const approvalRateColor = v.approvalRate > 0.7 ? 'text-green-600' : v.approvalRate > 0.5 ? 'text-amber-600' : 'text-red-600';
                  
                  return (
                    <tr key={v.version} className={`border-b border-slate-100 hover:bg-slate-50 ${isLatest ? 'bg-indigo-50' : ''}`}>
                      <td className="py-3 px-4 font-medium">
                        <div className="flex items-center gap-2">
                          {v.version}
                          {isLatest && <Badge className="bg-indigo-600 text-white text-xs">Latest</Badge>}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">{v.roundCount}</td>
                      <td className="py-3 px-4 text-right">{v.totalSuggestions}</td>
                      <td className="py-3 px-4 text-right text-green-600">{v.approvedCount}</td>
                      <td className="py-3 px-4 text-right text-amber-600">{v.adjustedCount}</td>
                      <td className="py-3 px-4 text-right text-red-600">{v.skippedCount}</td>
                      <td className={`py-3 px-4 text-right font-bold ${approvalRateColor}`}>
                        {(v.approvalRate * 100).toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-right">
                        {(v.skipRate * 100).toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-center text-xs text-slate-500">
                        {v.firstUsed && new Date(v.firstUsed).toLocaleDateString('da-DK', { month: 'short', day: 'numeric' })}
                        {v.firstUsed !== v.lastUsed && (
                          <> - {v.lastUsed && new Date(v.lastUsed).toLocaleDateString('da-DK', { month: 'short', day: 'numeric' })}</>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Context Performance Tab
function ContextPerformanceTab({ performance }: { performance: PromptPerformance | undefined }) {
  if (!performance) return null;
  
  const { stageMetrics, supplierMetrics } = performance;
  
  return (
    <div className="space-y-6">
      {/* Stage Performance */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Purchase Stage</CardTitle>
          <CardDescription>
            How prompt versions perform across different purchase stages
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {Object.entries(stageMetrics).map(([stage, versions]) => (
              <div key={stage}>
                <h4 className="font-medium text-slate-900 mb-2 capitalize">{stage} Stage</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {versions.map(v => (
                    <div key={v.version} className="border rounded-lg p-3">
                      <div className="text-xs text-slate-500">{v.version}</div>
                      <div className="text-lg font-bold text-slate-900">
                        {(v.approvalRate * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-slate-500">{v.count} suggestions</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      
      {/* Supplier Performance */}
      <Card>
        <CardHeader>
          <CardTitle>Top Suppliers by Volume</CardTitle>
          <CardDescription>
            Version performance for your most frequently analyzed suppliers
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {supplierMetrics.map(supplier => (
              <div key={supplier.supplier} className="border-b pb-4 last:border-b-0">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-slate-900">{supplier.supplier}</h4>
                  <span className="text-sm text-slate-500">{supplier.totalSuggestions} total</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {supplier.versions.map(v => (
                    <div key={v.version} className="bg-slate-50 rounded p-2">
                      <div className="text-xs text-slate-500">{v.version}</div>
                      <div className="text-sm font-bold">
                        {(v.approvalRate * 100).toFixed(1)}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
