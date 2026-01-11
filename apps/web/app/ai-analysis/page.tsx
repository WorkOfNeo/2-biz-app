'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../lib/supabaseClient';
import Link from 'next/link';
import { Brain, Play, TrendingUp, Users, Package, AlertTriangle, Calendar, Clock, ChevronRight, Trash2, Database, RefreshCw, Loader2 } from 'lucide-react';

type AnalysisRaw = {
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
  season: { name: string; year: number | null }[] | null;
};

type Analysis = Omit<AnalysisRaw, 'season'> & {
  season?: { name: string; year: number | null };
};

type JobLog = {
  id: string;
  level: string;
  msg: string;
  data: any;
  created_at: string;
};

export default function AIAnalysisDashboard() {
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);

  // Fetch latest analyses
  const { data: analyses, mutate, error: analysesError } = useSWR('ai-analyses', async () => {
    console.log('[AI Analysis] Fetching analyses...');
    const { data, error } = await supabase
      .from('ai_season_analyses')
      .select(`
        id, season_id, analysis_type, analysis_date, executive_summary, 
        metrics, warnings, recommendations, created_at, email_sent_at, purchase_round_number,
        season:seasons!season_id(name, year)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('[AI Analysis] Fetch error:', error);
      throw new Error(error.message);
    }
    
    console.log('[AI Analysis] Fetched analyses:', data?.length || 0, 'rows', data);
    
    // Supabase returns season as array, flatten to single object
    return ((data ?? []) as AnalysisRaw[]).map(row => ({
      ...row,
      season: Array.isArray(row.season) && row.season.length > 0 ? row.season[0] : undefined
    })) as Analysis[];
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

  // Fetch data status - how much data is available for analysis
  const { data: dataStatus } = useSWR(
    seasonCompare?.s1 ? ['data-status', seasonCompare.s1] : null,
    async () => {
      const seasonId = seasonCompare!.s1!;
      
      // Count sales_stats rows
      const { count: salesStatsCount } = await supabase
        .from('sales_stats')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', seasonId);
      
      // Count style details rows
      const { count: styleDetailsCount } = await supabase
        .from('sales_style_details_rows')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', seasonId);
      
      // Count unique customers with style details
      const { data: styleDetailsCustomers } = await supabase
        .from('sales_style_details_scraped')
        .select('account_no, first_scraped_at')
        .eq('season_id', seasonId)
        .order('first_scraped_at', { ascending: false })
        .limit(1);
      
      // Get last scrape time
      const lastScrapeTime = styleDetailsCustomers?.[0]?.first_scraped_at;
      
      // Count customers with style details
      const { count: scrapedCustomersCount } = await supabase
        .from('sales_style_details_scraped')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', seasonId);
      
      // Get last analysis time
      const lastAnalysisTime = analyses?.[0]?.created_at;
      
      // Check if there's new data since last analysis
      const hasNewData = lastScrapeTime && lastAnalysisTime 
        ? new Date(lastScrapeTime) > new Date(lastAnalysisTime)
        : Boolean(styleDetailsCount && styleDetailsCount > 0);
      
      return {
        salesStatsCount: salesStatsCount || 0,
        styleDetailsCount: styleDetailsCount || 0,
        scrapedCustomersCount: scrapedCustomersCount || 0,
        lastScrapeTime,
        hasNewData
      };
    },
    { refreshInterval: 30000 }
  );

  const latestAnalysis = analyses?.[0];
  const todayStr = new Date().toISOString().split('T')[0];
  const hasRunToday = latestAnalysis?.analysis_date === todayStr;

  // Poll for job status and logs when a job is running
  useEffect(() => {
    if (!currentJobId) return;

    const pollInterval = setInterval(async () => {
      // Fetch job status (jobs table has 'error' not 'error_message' or 'result')
      const { data: job } = await supabase
        .from('jobs')
        .select('id, status, error')
        .eq('id', currentJobId)
        .single();

      // Fetch latest logs (job_logs uses 'ts' not 'created_at')
      const { data: logs } = await supabase
        .from('job_logs')
        .select('id, level, msg, data, ts')
        .eq('job_id', currentJobId)
        .order('ts', { ascending: true })
        .limit(100);

      if (logs) {
        // Map 'ts' to 'created_at' for consistency with JobLog type
        setJobLogs((logs as any[]).map(log => ({ ...log, created_at: log.ts })) as JobLog[]);
      }

      // Check if job completed or failed
      if (job?.status === 'succeeded') {
        clearInterval(pollInterval);
        setRunningAnalysis(false);
        setCurrentJobId(null);
        setJobLogs([]);
        await mutate(); // Refresh analyses list
      } else if (job?.status === 'failed' || job?.status === 'cancelled') {
        clearInterval(pollInterval);
        setRunningAnalysis(false);
        setCurrentJobId(null);
        setAnalysisError(job?.error || 'Job failed');
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(pollInterval);
  }, [currentJobId, mutate]);

  async function runAnalysis(type: 'daily' | 'purchase_round') {
    setRunningAnalysis(true);
    setAnalysisError(null);
    setJobLogs([]);
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
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Analysis failed');
      }

      // Job has been queued - start polling
      if (data.jobId) {
        setCurrentJobId(data.jobId);
      } else {
        // Direct response (shouldn't happen with new worker-based approach)
        setRunningAnalysis(false);
        await mutate();
      }
    } catch (e: any) {
      setAnalysisError(e?.message || 'Failed to run analysis');
      setRunningAnalysis(false);
    }
  }

  async function clearAllData() {
    if (!confirm('Are you sure you want to delete ALL AI analysis data? This cannot be undone.')) {
      return;
    }
    setClearing(true);
    setAnalysisError(null);
    try {
      // Delete all ai_season_analyses
      const { error } = await supabase
        .from('ai_season_analyses')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows
      if (error) throw error;
      await mutate();
    } catch (e: any) {
      setAnalysisError(e?.message || 'Failed to clear data');
    } finally {
      setClearing(false);
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
            disabled={runningAnalysis || clearing}
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
            disabled={runningAnalysis || clearing}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            <Package className="h-4 w-4" />
            Start Purchase Round
          </button>
          <button
            onClick={clearAllData}
            disabled={runningAnalysis || clearing}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {clearing ? (
              <>
                <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Clearing...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Clear Data
              </>
            )}
          </button>
        </div>
      </div>

      {analysisError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {analysisError}
        </div>
      )}

      {analysesError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          <strong>Error loading analyses:</strong> {analysesError.message}
        </div>
      )}

      {/* Job Progress Panel */}
      {currentJobId && (
        <div className="mb-6 bg-slate-900 text-white rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
              <span className="font-medium">AI Analysis Running...</span>
            </div>
            <span className="text-xs text-slate-400 font-mono">Job: {currentJobId.slice(0, 8)}...</span>
          </div>
          <div className="p-4 max-h-64 overflow-y-auto font-mono text-sm space-y-1">
            {jobLogs.length === 0 ? (
              <div className="text-slate-500">Waiting for logs...</div>
            ) : (
              jobLogs.map((log) => (
                <div key={log.id} className={`flex gap-2 ${log.level === 'error' ? 'text-red-400' : log.level === 'progress' ? 'text-yellow-400' : 'text-slate-300'}`}>
                  <span className="text-slate-500 shrink-0">
                    {new Date(log.created_at).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`shrink-0 w-12 uppercase text-xs ${log.level === 'error' ? 'text-red-500' : log.level === 'progress' ? 'text-yellow-500' : 'text-indigo-400'}`}>
                    [{log.level}]
                  </span>
                  <span>{log.msg}</span>
                  {log.data && Object.keys(log.data).length > 0 && (
                    <span className="text-slate-500 truncate">{JSON.stringify(log.data)}</span>
                  )}
                </div>
              ))
            )}
          </div>
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

      {/* Data Status Card */}
      {dataStatus && (
        <div className={`mb-6 p-4 border rounded-lg ${dataStatus.hasNewData ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className={`h-5 w-5 ${dataStatus.hasNewData ? 'text-amber-600' : 'text-slate-400'}`} />
              <div>
                <div className="font-medium text-slate-900 flex items-center gap-2">
                  Data Available for Analysis
                  {dataStatus.hasNewData && (
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" />
                      New data since last analysis
                    </span>
                  )}
                </div>
                <div className="text-sm text-slate-500 mt-1">
                  {dataStatus.salesStatsCount.toLocaleString()} sales records • {dataStatus.styleDetailsCount.toLocaleString()} style detail rows • {dataStatus.scrapedCustomersCount} customers scraped
                </div>
              </div>
            </div>
            <div className="text-right text-sm text-slate-500">
              {dataStatus.lastScrapeTime && (
                <div>
                  Last scrape: {new Date(dataStatus.lastScrapeTime).toLocaleDateString('da-DK')} {new Date(dataStatus.lastScrapeTime).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          </div>
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
