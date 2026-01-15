'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../lib/supabaseClient';
import Link from 'next/link';
import { Brain, Play, TrendingUp, Package, Calendar, Clock, ChevronRight, Trash2, Database, RefreshCw, Loader2, FileDown, FileText } from 'lucide-react';

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
  pdf_url: string | null;
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

type PurchaseRun = {
  id: string;
  season_id: string;
  run_label: string | null;
  run_number: number | null;
  status: 'pending' | 'reviewing' | 'completed' | 'cancelled';
  purchase_stage: string | null;
  created_at: string;
  run_completed_at: string | null;
  pdf_url: string | null;
  season?: { name: string; year: number | null };
};

type CombinedHistoryItem = {
  id: string;
  type: 'daily_analysis' | 'purchase_round';
  seasonName: string;
  seasonYear: number | null;
  date: string;
  status: string;
  purchaseStage?: string | null;
  pdfUrl?: string | null;
  link: string;
};

export default function AIAnalysisDashboard() {
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);
  const [generatingPdfFor, setGeneratingPdfFor] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Fetch latest analyses
  const { data: analyses, mutate, error: analysesError } = useSWR('ai-analyses', async () => {
    console.log('[AI Analysis] Fetching analyses...');
    const { data, error } = await supabase
      .from('ai_season_analyses')
      .select(`
        id, season_id, analysis_type, analysis_date, executive_summary, 
        metrics, warnings, recommendations, created_at, email_sent_at, purchase_round_number, pdf_url,
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

  // Fetch purchase runs for the history list
  const { data: purchaseRuns } = useSWR('purchase-runs', async () => {
    const { data, error } = await supabase
      .from('purchase_ai_runs')
      .select(`
        id, season_id, run_label, run_number, status,
        purchase_stage, created_at, run_completed_at, pdf_url,
        season:seasons!season_id(name, year)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw new Error(error.message);
    
    return ((data ?? []) as any[]).map(row => ({
      ...row,
      season: Array.isArray(row.season) && row.season.length > 0 ? row.season[0] : undefined
    })) as PurchaseRun[];
  });

  // Combine analyses and purchase runs for history
  const combinedHistory: CombinedHistoryItem[] = [
    ...((analyses ?? []).map(a => ({
      id: a.id,
      type: 'daily_analysis' as const,
      seasonName: a.season?.name || 'Unknown',
      seasonYear: a.season?.year ?? null,
      date: a.analysis_date,
      status: 'completed',
      pdfUrl: a.pdf_url,
      link: `/ai-analysis/${a.id}`,
    }))),
    ...((purchaseRuns ?? []).map(p => ({
      id: p.id,
      type: 'purchase_round' as const,
      seasonName: p.season?.name || 'Unknown',
      seasonYear: p.season?.year ?? null,
      date: p.created_at.split('T')[0] || '',
      status: p.status,
      purchaseStage: p.purchase_stage,
      pdfUrl: p.pdf_url,
      link: `/purchase/ai-review/${p.id}`,
    }))),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

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
        throw new Error(data.error || data.detail || 'Analysis failed');
      }

      // Purchase round now redirects to the review page
      if (type === 'purchase_round' && data.purchaseRunId) {
        // Redirect to the new AI Purchase Review page
        window.location.href = `/purchase/ai-review/${data.purchaseRunId}`;
        return;
      }

      // Daily analysis uses job-based approach - start polling
      if (data.jobId) {
        setCurrentJobId(data.jobId);
      } else {
        // Direct response
        setRunningAnalysis(false);
        await mutate();
      }
    } catch (e: any) {
      setAnalysisError(e?.message || 'Failed to run analysis');
      setRunningAnalysis(false);
    }
  }

  async function generatePdf(analysisId: string) {
    // Add to generating set
    setGeneratingPdfFor(prev => new Set(prev).add(analysisId));
    
    try {
      // Enqueue the export job
      const { data: job, error } = await supabase
        .from('jobs')
        .insert({
          type: 'export_ai_analysis',
          payload: { analysisId },
          status: 'queued',
          max_attempts: 2
        })
        .select('id')
        .single();
      
      if (error) throw error;
      
      // Poll for job completion
      const pollForCompletion = async () => {
        const maxAttempts = 60; // 2 minutes max
        let attempts = 0;
        
        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds
          
          const { data: jobStatus } = await supabase
            .from('jobs')
            .select('status')
            .eq('id', job.id)
            .single();
          
          if (jobStatus?.status === 'succeeded') {
            // Refresh to get the new pdf_url
            await mutate();
            break;
          } else if (jobStatus?.status === 'failed' || jobStatus?.status === 'cancelled') {
            throw new Error('PDF generation failed');
          }
          
          attempts++;
        }
      };
      
      await pollForCompletion();
    } catch (e: any) {
      console.error('PDF generation failed:', e);
      setAnalysisError(`Failed to generate PDF: ${e.message}`);
    } finally {
      setGeneratingPdfFor(prev => {
        const next = new Set(prev);
        next.delete(analysisId);
        return next;
      });
    }
  }

  async function deleteAnalysis(analysisId: string, analysisType: string) {
    const typeLabel = analysisType === 'purchase_round' ? 'purchase round' : 'daily analysis';
    if (!confirm(`Are you sure you want to delete this ${typeLabel}? This cannot be undone.`)) {
      return;
    }
    
    setDeletingId(analysisId);
    setAnalysisError(null);
    
    try {
      const res = await fetch(`/api/ai-analysis/${analysisId}`, {
        method: 'DELETE',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete');
      }
      
      await mutate(); // Refresh the list
    } catch (e: any) {
      setAnalysisError(`Failed to delete: ${e.message}`);
    } finally {
      setDeletingId(null);
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

      {/* Job Progress Panel - Clean single-step display with fade */}
      {currentJobId && (
        <div className="mb-6 bg-gradient-to-br from-indigo-50 via-white to-purple-50 border border-indigo-100 rounded-2xl overflow-hidden shadow-sm">
          <div className="p-6 flex items-center gap-4">
            {/* Animated brain icon */}
            <div className="relative shrink-0">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
                <Brain className="h-7 w-7 text-white" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow">
                <Loader2 className="h-3 w-3 animate-spin text-indigo-600" />
              </div>
            </div>
            
            {/* Current step - single headline with fade animation */}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-indigo-600 font-medium uppercase tracking-wide mb-1">
                AI Analysis Running
              </div>
              {(() => {
                // Get the latest meaningful step
                const stepLabels: Record<string, { emoji: string; label: string }> = {
                  'start': { emoji: '🚀', label: 'Starter analyse...' },
                  'fetching_seasons': { emoji: '📅', label: 'Henter sæsondata...' },
                  'seasons_loaded': { emoji: '📅', label: 'Sæsondata hentet' },
                  'fetching_sales_stats': { emoji: '📊', label: 'Henter salgsstatistik...' },
                  'sales_stats_loaded': { emoji: '📊', label: 'Salgsstatistik hentet' },
                  'fetching_style_details': { emoji: '👗', label: 'Henter style-detaljer...' },
                  'style_details_loaded': { emoji: '👗', label: 'Style-detaljer hentet' },
                  'fetching_customers': { emoji: '👥', label: 'Henter kundedata...' },
                  'customers_loaded': { emoji: '👥', label: 'Kundedata hentet' },
                  'fetching_salespersons': { emoji: '👤', label: 'Henter sælgerdata...' },
                  'salespersons_loaded': { emoji: '👤', label: 'Sælgerdata hentet' },
                  'fetching_stock_data': { emoji: '📦', label: 'Henter lagerdata...' },
                  'stock_data_loaded': { emoji: '📦', label: 'Lagerdata hentet' },
                  'fetching_comparison_data': { emoji: '📈', label: 'Sammenligner med sidste sæson...' },
                  'comparison_data_loaded': { emoji: '📈', label: 'Sammenligningsdata hentet' },
                  'fetching_last_analysis': { emoji: '🔍', label: 'Henter forrige analyse...' },
                  'last_analysis_loaded': { emoji: '🔍', label: 'Forrige analyse hentet' },
                  'calculating_metrics': { emoji: '🧮', label: 'Beregner nøgletal...' },
                  'metrics_calculated': { emoji: '🧮', label: 'Nøgletal beregnet' },
                  'calling_openai': { emoji: '🤖', label: 'AI analyserer dine data...' },
                  'openai_request': { emoji: '🤖', label: 'AI analyserer...' },
                  'openai_complete': { emoji: '✨', label: 'AI-analyse færdig!' },
                  'saving_results': { emoji: '💾', label: 'Gemmer resultater...' },
                  'complete': { emoji: '🎉', label: 'Analyse færdig!' },
                  'enqueuing_pdf': { emoji: '📄', label: 'Genererer PDF-rapport...' },
                  'failed': { emoji: '❌', label: 'Analyse fejlede' },
                };
                
                const latestLog = jobLogs.length > 0 ? jobLogs[jobLogs.length - 1] : null;
                const latestStep = latestLog?.msg
                  ?.replace('AI_ANALYSIS:', '')
                  .replace('STEP:', '')
                  .toLowerCase()
                  .trim() || '';
                
                const stepInfo = stepLabels[latestStep] || { emoji: '⏳', label: latestLog?.msg || 'Initializing...' };
                const isError = latestLog?.level === 'error';
                
                return (
                  <div 
                    key={latestStep}
                    className={`text-xl font-semibold transition-all duration-500 animate-in fade-in slide-in-from-bottom-2 ${
                      isError ? 'text-red-600' : 'text-slate-800'
                    }`}
                  >
                    <span className="mr-2">{isError ? '❌' : stepInfo.emoji}</span>
                    {isError ? latestLog?.msg : stepInfo.label}
                  </div>
                );
              })()}
              
              {/* Progress dots */}
              <div className="flex gap-1.5 mt-3">
                {['start', 'data', 'ai', 'save'].map((phase, i) => {
                  const latestLog = jobLogs.length > 0 ? jobLogs[jobLogs.length - 1] : null;
                  const step = latestLog?.msg?.toLowerCase() || '';
                  const phaseCompleted = 
                    (phase === 'start' && step.includes('fetching')) ||
                    (phase === 'data' && (step.includes('openai') || step.includes('calculating'))) ||
                    (phase === 'ai' && (step.includes('saving') || step.includes('complete'))) ||
                    (phase === 'save' && step.includes('complete'));
                  const phaseCurrent = 
                    (phase === 'start' && step.includes('start')) ||
                    (phase === 'data' && step.includes('fetching')) ||
                    (phase === 'ai' && step.includes('openai')) ||
                    (phase === 'save' && step.includes('saving'));
                  
                  return (
                    <div
                      key={phase}
                      className={`h-1.5 rounded-full transition-all duration-300 ${
                        phaseCompleted ? 'w-8 bg-green-400' :
                        phaseCurrent ? 'w-8 bg-indigo-500 animate-pulse' :
                        'w-4 bg-slate-200'
                      }`}
                    />
                  );
                })}
              </div>
            </div>
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

      {/* Data Status Card - only show if there's new data or no analysis today */}
      {dataStatus && (dataStatus.hasNewData || !hasRunToday) && (
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
              {(() => {
                // Parse executive_summary - it may be stored as JSON string in TEXT column
                let summary = latestAnalysis.executive_summary;
                if (typeof summary === 'string' && summary.startsWith('{')) {
                  try {
                    summary = JSON.parse(summary);
                  } catch {
                    // Keep as string if parsing fails
                  }
                }
                
                if (typeof summary === 'string') {
                  return <p className="text-slate-900">{summary || 'No summary available'}</p>;
                } else if (summary && typeof summary === 'object') {
                  const s = summary as { headline?: string; bullets?: string[] };
                  return (
                    <div className="space-y-2">
                      {s.headline && (
                        <p className="font-semibold text-slate-900">{s.headline}</p>
                      )}
                      {s.bullets && Array.isArray(s.bullets) && (
                        <ul className="space-y-1">
                          {s.bullets.slice(0, 3).map((bullet: string, idx: number) => (
                            <li key={idx} className="text-sm text-slate-700">{bullet}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                }
                return <p className="text-slate-900">No summary available</p>;
              })()}
            </div>

            {/* Key Metrics with Changes */}
            {latestAnalysis.metrics && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Total Sold</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {(latestAnalysis.metrics.totals?.qty_sold || 0).toLocaleString()}
                  </div>
                  {latestAnalysis.metrics.changes_since_last?.qty_change != null && (
                    <div className={`text-xs ${latestAnalysis.metrics.changes_since_last.qty_change > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                      {latestAnalysis.metrics.changes_since_last.qty_change > 0 ? '+' : ''}{latestAnalysis.metrics.changes_since_last.qty_change} since last
                    </div>
                  )}
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Revenue</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {((latestAnalysis.metrics.totals?.revenue || 0) / 1000).toFixed(0)}K
                  </div>
                  {latestAnalysis.metrics.changes_since_last?.revenue_change != null && (
                    <div className={`text-xs ${latestAnalysis.metrics.changes_since_last.revenue_change > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                      {latestAnalysis.metrics.changes_since_last.revenue_change > 0 ? '+' : ''}{(latestAnalysis.metrics.changes_since_last.revenue_change / 1000).toFixed(1)}K
                    </div>
                  )}
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Visit Rate</div>
                  <div className="text-2xl font-bold text-slate-900">
                    {latestAnalysis.metrics.customer_coverage?.visit_rate_percent || 0}%
                  </div>
                  {latestAnalysis.metrics.changes_since_last?.customers_change != null && (
                    <div className={`text-xs ${latestAnalysis.metrics.changes_since_last.customers_change > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                      {latestAnalysis.metrics.changes_since_last.customers_change > 0 ? '+' : ''}{latestAnalysis.metrics.changes_since_last.customers_change} customers
                    </div>
                  )}
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

            {/* Salesperson Table */}
            {latestAnalysis.metrics?.salesperson_table && latestAnalysis.metrics.salesperson_table.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-medium text-slate-500 mb-3">Salesperson Progress</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left py-2 px-3 font-medium text-slate-600">Salesperson</th>
                        <th className="text-right py-2 px-3 font-medium text-slate-600">Visited</th>
                        <th className="text-right py-2 px-3 font-medium text-slate-600">Qty</th>
                        <th className="text-right py-2 px-3 font-medium text-slate-600">Price</th>
                        <th className="text-right py-2 px-3 font-medium text-slate-600">Index</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latestAnalysis.metrics.salesperson_table.map((sp: any, i: number) => (
                        <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="py-2 px-3 font-medium text-slate-900">{sp.salesperson}</td>
                          <td className="py-2 px-3 text-right text-slate-700">{sp.visited_customers}</td>
                          <td className="py-2 px-3 text-right text-slate-700">{sp.qty.toLocaleString()}</td>
                          <td className="py-2 px-3 text-right text-slate-700">{sp.price.toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                          <td className="py-2 px-3 text-right">
                            {sp.index != null ? (
                              <span className={`font-medium ${sp.index >= 100 ? 'text-green-600' : sp.index >= 80 ? 'text-amber-600' : 'text-red-600'}`}>
                                {sp.index}%
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  Index = This season qty / Last season qty for visited customers (100% = same as last year)
                </p>
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
          {combinedHistory.slice(0, 30).map((item) => (
            <div
              key={`${item.type}-${item.id}`}
              className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            >
              <Link
                href={item.link as any}
                className="flex items-center gap-3 flex-1"
              >
                <div className={`p-2 rounded-lg ${item.type === 'purchase_round' ? 'bg-emerald-100' : 'bg-indigo-100'}`}>
                  {item.type === 'purchase_round' ? (
                    <Package className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <TrendingUp className="h-4 w-4 text-indigo-600" />
                  )}
                </div>
                <div>
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {item.type === 'purchase_round' 
                      ? 'Purchase Round'
                      : 'Daily Analysis'
                    }
                    <span className="text-slate-400 font-normal">
                      {item.seasonName} {item.seasonYear}
                    </span>
                    {item.type === 'purchase_round' && item.status && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        item.status === 'reviewing' ? 'bg-blue-100 text-blue-700' :
                        item.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {item.status}
                      </span>
                    )}
                    {item.purchaseStage && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        item.purchaseStage === 'early' ? 'bg-amber-100 text-amber-700' :
                        item.purchaseStage === 'mid' ? 'bg-blue-100 text-blue-700' :
                        'bg-emerald-100 text-emerald-700'
                      }`}>
                        {item.purchaseStage}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-500">
                    {new Date(item.date).toLocaleDateString('da-DK')}
                  </div>
                </div>
              </Link>
              <div className="flex items-center gap-4">
                {/* PDF Button */}
                {item.pdfUrl ? (
                  <a
                    href={item.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-50 text-green-700 hover:bg-green-100 rounded-lg transition-colors"
                  >
                    <FileDown className="h-4 w-4" />
                    Download
                  </a>
                ) : item.type === 'daily_analysis' ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      generatePdf(item.id);
                    }}
                    disabled={generatingPdfFor.has(item.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {generatingPdfFor.has(item.id) ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <FileText className="h-4 w-4" />
                        Generate PDF
                      </>
                    )}
                  </button>
                ) : null}
                
                {/* Delete Button (only for daily analyses) */}
                {item.type === 'daily_analysis' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      deleteAnalysis(item.id, 'daily');
                    }}
                    disabled={deletingId === item.id}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                    title="Delete this analysis"
                  >
                    {deletingId === item.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                )}
                
                <Link href={item.link as any}>
                  <ChevronRight className="h-5 w-5 text-slate-300" />
                </Link>
              </div>
            </div>
          ))}
          {combinedHistory.length === 0 && (
            <div className="p-8 text-center text-slate-500">
              No analyses yet. Click "Run Analysis Now" to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
