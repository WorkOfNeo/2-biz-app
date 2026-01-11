'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { supabase } from '../../lib/supabaseClient';
import Link from 'next/link';
import { Brain, Play, TrendingUp, Users, Package, AlertTriangle, Calendar, Clock, ChevronRight } from 'lucide-react';

type Analysis = {
  id: string;
  season_id: string;
  analysis_type: 'daily' | 'purchase_round';
  analysis_date: string;
  executive_summary: string | null;
  metrics: any;
  warnings: string[];
  recommendations: string[];
  created_at: string;
  email_sent_at: string | null;
  purchase_round_number: number | null;
  season?: { name: string; year: number | null };
};

export default function AIAnalysisDashboard() {
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Fetch latest analyses
  const { data: analyses, mutate } = useSWR('ai-analyses', async () => {
    const { data, error } = await supabase
      .from('ai_season_analyses')
      .select(`
        id, season_id, analysis_type, analysis_date, executive_summary, 
        metrics, warnings, recommendations, created_at, email_sent_at, purchase_round_number,
        season:seasons(name, year)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as Analysis[];
  });

  // Fetch seasons for context
  const { data: seasonCompare } = useSWR('season-compare', async () => {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'season_compare')
      .maybeSingle();
    return data?.value as { s1?: string; s2?: string } | null;
  });

  const { data: currentSeason } = useSWR(
    seasonCompare?.s1 ? ['season', seasonCompare.s1] : null,
    async () => {
      const { data } = await supabase
        .from('seasons')
        .select('id, name, year')
        .eq('id', seasonCompare!.s1!)
        .single();
      return data;
    }
  );

  const latestAnalysis = analyses?.[0];
  const todayStr = new Date().toISOString().split('T')[0];
  const hasRunToday = latestAnalysis?.analysis_date === todayStr;

  async function runAnalysis(type: 'daily' | 'purchase_round') {
    setRunningAnalysis(true);
    setAnalysisError(null);
    try {
      // Use different endpoints for daily vs purchase round
      const endpoint = type === 'purchase_round' 
        ? '/api/ai-analysis/purchase-round'
        : '/api/ai-analysis/run';
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(type === 'daily' ? { analysisType: 'daily' } : {})
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Analysis failed');
      }
      await mutate();
    } catch (e: any) {
      setAnalysisError(e?.message || 'Failed to run analysis');
    } finally {
      setRunningAnalysis(false);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Brain className="h-6 w-6 text-indigo-600" />
            AI Season Analysis
          </h1>
          <p className="text-slate-500 mt-1">
            Daily monitoring and purchase round recommendations powered by GPT-5
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => runAnalysis('daily')}
            disabled={runningAnalysis}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {runningAnalysis ? (
              <>
                <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run Analysis Now
              </>
            )}
          </button>
          <button
            onClick={() => runAnalysis('purchase_round')}
            disabled={runningAnalysis}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            <Package className="h-4 w-4" />
            Start Purchase Round
          </button>
        </div>
      </div>

      {analysisError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {analysisError}
        </div>
      )}

      {/* Current Season Banner */}
      {currentSeason && (
        <div className="mb-6 p-4 bg-indigo-50 border border-indigo-100 rounded-lg flex items-center justify-between">
          <div>
            <div className="text-sm text-indigo-600 font-medium">Current Season</div>
            <div className="text-lg font-semibold text-slate-900">
              {currentSeason.name} {currentSeason.year}
            </div>
          </div>
          {hasRunToday && (
            <span className="px-3 py-1 bg-green-100 text-green-700 text-sm rounded-full">
              ✓ Analyzed today
            </span>
          )}
        </div>
      )}

      {/* Latest Analysis Card */}
      {latestAnalysis && (
        <div className="mb-8 bg-white border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${latestAnalysis.analysis_type === 'purchase_round' ? 'bg-emerald-100' : 'bg-indigo-100'}`}>
                {latestAnalysis.analysis_type === 'purchase_round' ? (
                  <Package className="h-5 w-5 text-emerald-600" />
                ) : (
                  <TrendingUp className="h-5 w-5 text-indigo-600" />
                )}
              </div>
              <div>
                <div className="font-semibold text-slate-900">
                  {latestAnalysis.analysis_type === 'purchase_round' 
                    ? `Purchase Round #${latestAnalysis.purchase_round_number || '?'}`
                    : 'Daily Analysis'
                  }
                </div>
                <div className="text-sm text-slate-500 flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(latestAnalysis.analysis_date).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              </div>
            </div>
            <Link
              href={`/ai-analysis/${latestAnalysis.id}`}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-md"
            >
              View Full Report <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="p-5">
            {/* Executive Summary */}
            <div className="mb-5">
              <h3 className="text-sm font-medium text-slate-500 mb-2">Executive Summary</h3>
              <p className="text-slate-900">{latestAnalysis.executive_summary || 'No summary available'}</p>
            </div>

            {/* Key Metrics */}
            {latestAnalysis.metrics && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Total Sold</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {(latestAnalysis.metrics.totals?.qty_sold || 0).toLocaleString()}
                  </div>
                  <div className="text-xs text-slate-500">pieces</div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Revenue</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {((latestAnalysis.metrics.totals?.revenue || 0) / 1000).toFixed(0)}K
                  </div>
                  <div className="text-xs text-slate-500">DKK</div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Visit Rate</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {latestAnalysis.metrics.customer_coverage?.visit_rate_percent || 0}%
                  </div>
                  <div className="text-xs text-slate-500">customers</div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Active Styles</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {latestAnalysis.metrics.totals?.unique_styles || 0}
                  </div>
                  <div className="text-xs text-slate-500">selling</div>
                </div>
              </div>
            )}

            {/* Warnings */}
            {latestAnalysis.warnings && latestAnalysis.warnings.length > 0 && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-slate-500 mb-2 flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Warnings
                </h3>
                <ul className="space-y-1">
                  {latestAnalysis.warnings.slice(0, 3).map((w, i) => (
                    <li key={i} className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded">
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            {latestAnalysis.recommendations && latestAnalysis.recommendations.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-slate-500 mb-2">💡 Recommendations</h3>
                <ul className="space-y-1">
                  {latestAnalysis.recommendations.slice(0, 3).map((r, i) => (
                    <li key={i} className="text-sm text-slate-700 bg-slate-50 px-3 py-2 rounded">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* History List */}
      <div className="bg-white border rounded-xl shadow-sm">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <Clock className="h-5 w-5 text-slate-400" />
            Analysis History
          </h2>
        </div>
        <div className="divide-y">
          {(analyses ?? []).slice(0, 20).map((a) => (
            <Link
              key={a.id}
              href={`/ai-analysis/${a.id}`}
              className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${a.analysis_type === 'purchase_round' ? 'bg-emerald-100' : 'bg-indigo-100'}`}>
                  {a.analysis_type === 'purchase_round' ? (
                    <Package className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <TrendingUp className="h-4 w-4 text-indigo-600" />
                  )}
                </div>
                <div>
                  <div className="font-medium text-slate-900">
                    {a.analysis_type === 'purchase_round' 
                      ? `Purchase Round #${a.purchase_round_number || '?'}`
                      : 'Daily Analysis'
                    }
                    <span className="text-slate-400 font-normal ml-2">
                      {(a.season as any)?.name} {(a.season as any)?.year}
                    </span>
                  </div>
                  <div className="text-sm text-slate-500">
                    {new Date(a.analysis_date).toLocaleDateString('da-DK')}
                    {a.email_sent_at && <span className="ml-2 text-green-600">📧 Sent</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {a.metrics?.totals && (
                  <div className="text-right text-sm">
                    <div className="font-medium text-slate-900">{(a.metrics.totals.qty_sold || 0).toLocaleString()} pcs</div>
                    <div className="text-slate-500">{a.metrics.customer_coverage?.visit_rate_percent || 0}% visited</div>
                  </div>
                )}
                {a.warnings && a.warnings.length > 0 && (
                  <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs rounded-full">
                    {a.warnings.length} warnings
                  </span>
                )}
                <ChevronRight className="h-5 w-5 text-slate-300" />
              </div>
            </Link>
          ))}
          {(!analyses || analyses.length === 0) && (
            <div className="p-8 text-center text-slate-500">
              No analyses yet. Click "Run Analysis Now" to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
