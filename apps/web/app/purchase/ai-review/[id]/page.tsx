'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Input } from '../../../../components/ui/input';
import Link from 'next/link';
import { 
  ArrowLeft, Check, X, Package, Loader2, 
  ChevronDown, ChevronRight, Building2, CheckCircle2, 
  AlertTriangle, Clock, XCircle, ShoppingCart, Info
} from 'lucide-react';

const supabase = createClientComponentClient();

type StyleSuggestion = {
  style_no: string;
  style_name: string;
  color: string;
  sold_qty: number;
  open_po_qty: number;
  suggested_qty_total: number;
  sizes: string[];
  size_breakdown: number[];
  active_salespeople_count: number;
  reasoning?: string;
};

type SupplierSuggestion = {
  supplier: string;
  moq: number;
  lead_time_days: number;
  travel_time_days: number;
  total_qty: number;
  below_moq: boolean;
  priority?: 'high' | 'medium' | 'low';
  commentary?: string;
  flags?: string[];
  styles: StyleSuggestion[];
};

type PurchaseRun = {
  id: string;
  season_id: string;
  run_label: string | null;
  run_number: number | null;
  status: 'pending' | 'reviewing' | 'completed' | 'cancelled';
  purchase_stage: 'early' | 'mid' | 'closing' | null;
  prompt_key: string | null;
  prompt_version: number | null;
  model: string | null;
  supplier_suggestions: SupplierSuggestion[] | null;
  computed_features_snapshot: any;
  run_started_at: string | null;
  run_completed_at: string | null;
  job_id: string | null;
  created_at: string;
  season?: { name: string; year: number | null };
};

type JobLog = {
  id: string;
  level: string;
  msg: string;
  data: any;
  created_at: string;
};

// Feedback per style with size breakdown
type LineFeedback = {
  style_no: string;
  color: string;
  supplier_name: string;
  suggested_qty: number;
  adjusted_qty: number | null;
  sizes: string[];
  suggested_breakdown: number[];
  adjusted_breakdown: number[] | null;
  verdict: 'approved' | 'adjusted' | 'skipped';
};

export default function AIPurchaseReviewPage() {
  const params = useParams();
  const router = useRouter();
  const purchaseRunId = params.id as string;

  const [feedback, setFeedback] = useState<Record<string, LineFeedback>>({});
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set());
  const [expandedStyles, setExpandedStyles] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [creatingPOs, setCreatingPOs] = useState(false);
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);
  const [shouldPoll, setShouldPoll] = useState(true);

  // Fetch the purchase run
  const { data: purchaseRun, mutate, error } = useSWR<PurchaseRun>(
    purchaseRunId ? `purchase-run-${purchaseRunId}` : null,
    async () => {
      const { data, error } = await supabase
        .from('purchase_ai_runs')
        .select(`
          id, season_id, run_label, run_number, status,
          purchase_stage, prompt_key, prompt_version, model,
          supplier_suggestions, computed_features_snapshot,
          run_started_at, run_completed_at, job_id, created_at
        `)
        .eq('id', purchaseRunId)
        .single();

      if (error) throw new Error(error.message);
      
      let season: { name: string; year: number | null } | undefined;
      if (data.season_id) {
        const { data: seasonData } = await supabase
          .from('seasons')
          .select('name, year')
          .eq('id', data.season_id)
          .single();
        if (seasonData) season = seasonData;
      }
      
      return { ...data, season } as PurchaseRun;
    },
    { refreshInterval: shouldPoll ? 2000 : 0 }
  );

  useEffect(() => {
    if (purchaseRun && purchaseRun.status !== 'pending') {
      setShouldPoll(false);
    }
  }, [purchaseRun?.status]);

  // Initialize feedback from suggestions
  useEffect(() => {
    if (!purchaseRun?.supplier_suggestions) return;
    
    const initial: Record<string, LineFeedback> = {};
    purchaseRun.supplier_suggestions.forEach(supplier => {
      supplier.styles.forEach(style => {
        const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
        if (!feedback[key]) {
          initial[key] = {
            style_no: style.style_no,
            color: style.color,
            supplier_name: supplier.supplier,
            suggested_qty: style.suggested_qty_total,
            adjusted_qty: null,
            sizes: style.sizes,
            suggested_breakdown: style.size_breakdown,
            adjusted_breakdown: null,
            verdict: 'approved', // Default to approved
          };
        }
      });
    });
    
    if (Object.keys(initial).length > 0) {
      setFeedback(prev => ({ ...initial, ...prev }));
    }
  }, [purchaseRun?.supplier_suggestions]);

  // Poll job logs while pending
  useEffect(() => {
    if (purchaseRun?.status !== 'pending') return;

    // If we don't have job_id yet, just keep polling the main record
    if (!purchaseRun?.job_id) {
      const pollInterval = setInterval(() => mutate(), 2000);
      return () => clearInterval(pollInterval);
    }

    const fetchLogs = async () => {
      const { data } = await supabase
        .from('job_logs')
        .select('id, level, msg, data, created_at')
        .eq('job_id', purchaseRun.job_id)
        .order('created_at', { ascending: true });
      if (data) setJobLogs(data);
    };

    fetchLogs();
    const pollInterval = setInterval(fetchLogs, 2000);
    return () => clearInterval(pollInterval);
  }, [purchaseRun?.job_id, purchaseRun?.status, mutate]);

  // Auto-expand first supplier
  useEffect(() => {
    const suggestions = purchaseRun?.supplier_suggestions;
    if (suggestions && suggestions.length > 0 && suggestions[0]) {
      setExpandedSuppliers(new Set([suggestions[0].supplier]));
    }
  }, [purchaseRun?.supplier_suggestions]);

  // Calculate totals
  const totals = useMemo(() => {
    if (!purchaseRun?.supplier_suggestions) return { suggested: 0, adjusted: 0, approved: 0, skipped: 0 };
    
    let suggested = 0;
    let adjusted = 0;
    let approvedCount = 0;
    let skippedCount = 0;

    purchaseRun.supplier_suggestions.forEach(supplier => {
      supplier.styles.forEach(style => {
        const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
        const fb = feedback[key];
        
        suggested += style.suggested_qty_total;
        
        if (fb) {
          if (fb.verdict === 'skipped') {
            skippedCount++;
          } else {
            approvedCount++;
            if (fb.adjusted_breakdown) {
              adjusted += fb.adjusted_breakdown.reduce((a, b) => a + b, 0);
            } else {
              adjusted += style.suggested_qty_total;
            }
          }
        } else {
          adjusted += style.suggested_qty_total;
        }
      });
    });

    return { suggested, adjusted, approved: approvedCount, skipped: skippedCount };
  }, [purchaseRun?.supplier_suggestions, feedback]);

  function toggleSupplier(supplier: string) {
    setExpandedSuppliers(prev => {
      const next = new Set(prev);
      if (next.has(supplier)) next.delete(supplier);
      else next.add(supplier);
      return next;
    });
  }

  function toggleStyle(key: string) {
    setExpandedStyles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleVerdict(supplier: string, style: StyleSuggestion, verdict: 'approved' | 'skipped') {
    const key = `${supplier}|${style.style_no}|${style.color}`;
    setFeedback(prev => {
      const existing = prev[key] || {
        style_no: style.style_no,
        color: style.color,
        supplier_name: supplier,
        suggested_qty: style.suggested_qty_total,
        adjusted_qty: null,
        sizes: style.sizes,
        suggested_breakdown: style.size_breakdown,
        adjusted_breakdown: null,
        verdict: 'approved' as const,
      };
      
      return {
        ...prev,
        [key]: {
          ...existing,
          verdict,
          adjusted_breakdown: verdict === 'skipped' ? null : existing.adjusted_breakdown,
          adjusted_qty: verdict === 'skipped' ? null : existing.adjusted_qty,
        }
      };
    });
  }

  function handleSizeQtyChange(supplier: string, style: StyleSuggestion, sizeIndex: number, value: number) {
    const key = `${supplier}|${style.style_no}|${style.color}`;
    setFeedback(prev => {
      const current = prev[key];
      if (!current) return prev;
      
      const newBreakdown = current.adjusted_breakdown 
        ? [...current.adjusted_breakdown]
        : [...style.size_breakdown];
      newBreakdown[sizeIndex] = value;
      
      return {
        ...prev,
        [key]: {
          ...current,
          verdict: 'adjusted',
          adjusted_breakdown: newBreakdown,
          adjusted_qty: newBreakdown.reduce((a, b) => a + b, 0),
        }
      };
    });
  }

  function approveAllForSupplier(supplier: SupplierSuggestion) {
    const updates: Record<string, LineFeedback> = {};
    supplier.styles.forEach(style => {
      const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
      updates[key] = {
        style_no: style.style_no,
        color: style.color,
        supplier_name: supplier.supplier,
        suggested_qty: style.suggested_qty_total,
        adjusted_qty: null,
        sizes: style.sizes,
        suggested_breakdown: style.size_breakdown,
        adjusted_breakdown: null,
        verdict: 'approved',
      };
    });
    setFeedback(prev => ({ ...prev, ...updates }));
  }

  async function saveFeedback() {
    if (!purchaseRunId) return;
    setSaving(true);

    try {
      await supabase
        .from('purchase_ai_line_feedback')
        .delete()
        .eq('purchase_run_id', purchaseRunId);

      const rows = Object.values(feedback).map(fb => ({
        purchase_run_id: purchaseRunId,
        supplier_name: fb.supplier_name,
        style_no: fb.style_no,
        color: fb.color,
        suggested_qty: fb.suggested_qty,
        adjusted_qty: fb.adjusted_qty,
        verdict: fb.verdict,
        sizes: fb.sizes,
        suggested_breakdown: fb.suggested_breakdown,
        adjusted_breakdown: fb.adjusted_breakdown,
      }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('purchase_ai_line_feedback')
          .insert(rows);
        if (error) throw new Error(error.message);
      }

      await mutate();
    } catch (e: any) {
      alert('Failed to save feedback: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function createAppPOs() {
    if (!purchaseRunId || !purchaseRun?.supplier_suggestions) return;
    
    if (!confirm('Create APP Purchase Orders from approved items? This will create draft POs that you can review before pushing to SPY.')) {
      return;
    }

    setCreatingPOs(true);

    try {
      const createdPoIds: number[] = [];
      const today = new Date().toISOString().split('T')[0] || '';
      const todayClean = today.replace(/-/g, '');
      
      for (const supplier of purchaseRun.supplier_suggestions) {
        const items: any[] = [];
        let totalQty = 0;

        for (const style of supplier.styles) {
          const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
          const fb = feedback[key];
          
          if (fb?.verdict === 'skipped') continue;
          
          const quantities = fb?.adjusted_breakdown || style.size_breakdown;
          const total = quantities.reduce((a, b) => a + b, 0);
          
          if (total > 0) {
            items.push({
              style_no: style.style_no,
              color: style.color,
              quantities: quantities,
              total: total,
            });
            totalQty += total;
          }
        }

        if (items.length === 0) continue;

        // Generate PO number
        const poNo = `AI-${purchaseRun.run_number}-${supplier.supplier.substring(0, 10).toUpperCase()}-${todayClean}`;

        const { data: po, error } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            supplier: supplier.supplier,
            status: 'Running',
            styles: items.length,
            ordered: totalQty,
            meta: { 
              items,
              source: 'ai_purchase_round',
              purchase_run_id: purchaseRunId,
              run_number: purchaseRun.run_number,
            },
          })
          .select('id')
          .single();

        if (error) {
          console.error('Failed to create PO for', supplier.supplier, error);
        } else if (po) {
          createdPoIds.push(po.id);
        }
      }

      await supabase
        .from('purchase_ai_runs')
        .update({ 
          status: 'completed',
          created_app_po_ids: createdPoIds,
        })
        .eq('id', purchaseRunId);

      await mutate();

      alert(`Created ${createdPoIds.length} APP Purchase Orders. Redirecting...`);
      router.push('/purchase/app-pos');

    } catch (e: any) {
      alert('Failed to create POs: ' + e.message);
    } finally {
      setCreatingPOs(false);
    }
  }

  // Loading state
  if (!purchaseRun && !error) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <XCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <p className="text-slate-800 font-medium">Failed to load purchase round</p>
          <p className="text-slate-500 text-sm">{error.message}</p>
          <Link href="/ai-analysis" className="inline-flex items-center gap-2 mt-4 text-indigo-600">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
        </div>
      </div>
    );
  }

  // Pending state
  if (purchaseRun?.status === 'pending') {
    const hasJobId = !!purchaseRun?.job_id;
    const lastLog = jobLogs.length > 0 ? jobLogs[jobLogs.length - 1] : null;
    const currentStep = lastLog?.msg || (hasJobId ? 'Starting...' : 'Waiting for worker...');
    const lastUpdated = lastLog?.created_at ? new Date(lastLog.created_at).toLocaleTimeString('da-DK') : null;
    
    const stepMessages: Record<string, string> = {
      'purchase_engine_start': 'Starting purchase engine...',
      'loading_season_data': 'Loading season data...',
      'season_loaded': 'Season loaded',
      'loading_sales_data': 'Loading sales data...',
      'stage_computed': 'Computing purchase stage...',
      'loading_style_details': 'Loading style details...',
      'style_details_loaded': 'Style details loaded',
      'loading_styles_and_suppliers': 'Loading suppliers...',
      'suppliers_loaded': 'Suppliers loaded',
      'loading_open_pos': 'Loading existing POs...',
      'open_pos_loaded': 'Open POs loaded',
      'aggregating_sales': 'Aggregating sales...',
      'sales_aggregated': 'Sales aggregated',
      'calculating_recommendations': 'Calculating recommendations...',
      'recommendations_calculated': 'Recommendations ready',
      'calling_ai_for_commentary': 'Getting AI commentary...',
      'ai_commentary_received': 'AI commentary received',
      'persisting_results': 'Saving results...',
      'purchase_engine_complete': 'Complete!',
    };

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-8">
        <div className="w-full max-w-xl">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-indigo-600/20 border border-indigo-500/30 mb-6">
              <Package className="h-10 w-10 text-indigo-400" />
            </div>
            <h1 className="text-2xl font-semibold text-white mb-2">
              Purchase Round #{purchaseRun.run_number}
            </h1>
            <p className="text-slate-400">
              Analyzing season data and calculating purchase recommendations...
            </p>
          </div>

          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl border border-slate-700/50 p-6">
            <div className="flex items-center gap-4 mb-6">
              <Loader2 className="h-8 w-8 text-indigo-400 animate-spin" />
              <div className="flex-1">
                <p className="text-white font-medium">
                  {stepMessages[currentStep] || currentStep.replace(/_/g, ' ')}
                </p>
                <p className="text-slate-500 text-sm">
                  {purchaseRun.season?.name} {purchaseRun.season?.year}
                  {lastUpdated && <> • Opdateret {lastUpdated}</>}
                </p>
                {!hasJobId && (
                  <p className="text-amber-400/80 text-xs mt-1">
                    Venter på at worker starter jobbet...
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {jobLogs.map((log, idx) => (
                <div
                  key={log.id}
                  className={`flex items-center gap-3 text-sm ${
                    idx === jobLogs.length - 1 ? 'text-white' : 'text-slate-500 opacity-60'
                  }`}
                >
                  {log.level === 'error' ? (
                    <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                  ) : idx === jobLogs.length - 1 ? (
                    <Clock className="h-4 w-4 text-indigo-400 flex-shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                  )}
                  <span>{stepMessages[log.msg] || log.msg.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-center mt-6">
            <Link href="/ai-analysis" className="text-slate-400 hover:text-white text-sm">
              ← Back to AI Analysis
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const suppliers = purchaseRun?.supplier_suggestions || [];
  const snapshot = purchaseRun?.computed_features_snapshot || {};
  const stageColors = {
    early: 'bg-amber-100 text-amber-800',
    mid: 'bg-blue-100 text-blue-800',
    closing: 'bg-emerald-100 text-emerald-800',
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/ai-analysis" className="text-slate-400 hover:text-slate-600">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold text-slate-900">
                    Purchase Round #{purchaseRun?.run_number}
                  </h1>
                  {purchaseRun?.purchase_stage && (
                    <Badge className={stageColors[purchaseRun.purchase_stage]}>
                      {purchaseRun.purchase_stage.toUpperCase()}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-slate-500">
                  {purchaseRun?.season?.name} {purchaseRun?.season?.year}
                  {snapshot?.visit_rate_percent && (
                    <> • {snapshot.visit_rate_percent}% besøgt</>
                  )}
                  {purchaseRun?.model && (
                    <> • {purchaseRun.prompt_key} v{purchaseRun.prompt_version}</>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Badge className={purchaseRun?.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}>
                {purchaseRun?.status}
              </Badge>
              
              {purchaseRun?.status === 'reviewing' && (
                <>
                  <Button variant="outline" onClick={saveFeedback} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                    Save
                  </Button>
                  <Button onClick={createAppPOs} disabled={creatingPOs}>
                    {creatingPOs ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ShoppingCart className="h-4 w-4 mr-2" />}
                    Create APP POs
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-slate-900">{suppliers.length}</div>
              <div className="text-sm text-slate-500">Suppliers</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-indigo-600">{totals.suggested.toLocaleString('da-DK')}</div>
              <div className="text-sm text-slate-500">Suggested Units</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-emerald-600">{totals.adjusted.toLocaleString('da-DK')}</div>
              <div className="text-sm text-slate-500">Final Total</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div>
                  <div className="text-lg font-bold text-emerald-600">{totals.approved}</div>
                  <div className="text-xs text-slate-500">Approved</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-red-600">{totals.skipped}</div>
                  <div className="text-xs text-slate-500">Skipped</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Suppliers */}
        {suppliers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900">No suggestions</h3>
              <p className="text-slate-500">No purchase recommendations were generated.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {suppliers.map((supplier) => {
              const isExpanded = expandedSuppliers.has(supplier.supplier);
              const supplierTotal = supplier.styles.reduce((sum, s) => {
                const key = `${supplier.supplier}|${s.style_no}|${s.color}`;
                const fb = feedback[key];
                if (fb?.verdict === 'skipped') return sum;
                const breakdown = fb?.adjusted_breakdown || s.size_breakdown;
                return sum + breakdown.reduce((a, b) => a + b, 0);
              }, 0);

              return (
                <Card key={supplier.supplier} className="overflow-hidden">
                  <div 
                    className="px-6 py-4 bg-slate-50 border-b cursor-pointer hover:bg-slate-100"
                    onClick={() => toggleSupplier(supplier.supplier)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown className="h-5 w-5 text-slate-400" /> : <ChevronRight className="h-5 w-5 text-slate-400" />}
                        <Building2 className="h-5 w-5 text-slate-600" />
                        <span className="font-semibold text-slate-900">{supplier.supplier}</span>
                        <Badge className="bg-slate-100 text-slate-600">{supplier.styles.length} styles</Badge>
                        {supplier.below_moq && (
                          <Badge className="bg-amber-100 text-amber-800">Under MOQ ({supplier.moq})</Badge>
                        )}
                        {supplier.priority && (
                          <Badge className={supplier.priority === 'high' ? 'bg-red-100 text-red-800' : supplier.priority === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}>
                            {supplier.priority}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-lg font-bold text-slate-900">{supplierTotal.toLocaleString('da-DK')}</div>
                          <div className="text-xs text-slate-500">
                            {supplier.lead_time_days > 0 && `${supplier.lead_time_days}d lead`}
                          </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); approveAllForSupplier(supplier); }}>
                          <Check className="h-4 w-4 mr-1" /> Approve All
                        </Button>
                      </div>
                    </div>
                    {supplier.commentary && (
                      <p className="mt-2 text-sm text-slate-600 ml-12">{supplier.commentary}</p>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="divide-y">
                      {supplier.styles.map((style, idx) => {
                        const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
                        const fb = feedback[key];
                        const isStyleExpanded = expandedStyles.has(key);
                        const breakdown = fb?.adjusted_breakdown || style.size_breakdown;
                        const styleTotal = breakdown.reduce((a, b) => a + b, 0);

                        return (
                          <div 
                            key={idx} 
                            className={`${fb?.verdict === 'skipped' ? 'bg-red-50/50' : fb?.verdict === 'adjusted' ? 'bg-amber-50/50' : ''}`}
                          >
                            <div className="px-6 py-4 flex items-center gap-4">
                              <button 
                                className="text-slate-400 hover:text-slate-600"
                                onClick={() => toggleStyle(key)}
                              >
                                {isStyleExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                              
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-slate-900">{style.style_name}</div>
                                <div className="text-sm text-slate-500">{style.style_no} • {style.color}</div>
                                {style.reasoning && (
                                  <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                                    <Info className="h-3 w-3" /> {style.reasoning}
                                  </div>
                                )}
                              </div>

                              <div className="text-right min-w-[80px]">
                                <div className="text-lg font-bold text-slate-900">{styleTotal.toLocaleString('da-DK')}</div>
                                <div className="text-xs text-slate-500">
                                  {style.active_salespeople_count} sælgere
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <Button
                                  variant={fb?.verdict === 'approved' && !fb?.adjusted_breakdown ? 'default' : 'outline'}
                                  size="sm"
                                  onClick={() => handleVerdict(supplier.supplier, style, 'approved')}
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant={fb?.verdict === 'skipped' ? 'destructive' : 'outline'}
                                  size="sm"
                                  onClick={() => handleVerdict(supplier.supplier, style, 'skipped')}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            {/* Size breakdown */}
                            {isStyleExpanded && style.sizes.length > 0 && (
                              <div className="px-6 pb-4 ml-8">
                                <div className="bg-slate-50 rounded-lg p-3">
                                  <div className="text-xs text-slate-500 mb-2">Per-size quantities:</div>
                                  <div className="flex flex-wrap gap-2">
                                    {style.sizes.map((size, sizeIdx) => (
                                      <div key={size} className="flex flex-col items-center">
                                        <div className="text-xs text-slate-600 font-medium mb-1">{size}</div>
                                        <Input
                                          type="number"
                                          className="w-16 text-center text-sm h-8"
                                          value={breakdown[sizeIdx] || 0}
                                          min={0}
                                          onChange={(e) => handleSizeQtyChange(
                                            supplier.supplier, 
                                            style, 
                                            sizeIdx, 
                                            parseInt(e.target.value) || 0
                                          )}
                                          disabled={fb?.verdict === 'skipped'}
                                        />
                                        <div className="text-xs text-slate-400 mt-1">
                                          ({style.size_breakdown[sizeIdx]})
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="mt-2 text-xs text-slate-500">
                                    Solgt: {style.sold_qty} • Åbne PO: {style.open_po_qty}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Bottom action bar */}
        {suppliers.length > 0 && purchaseRun?.status === 'reviewing' && (
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg">
            <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
              <div className="text-sm text-slate-600">
                <strong>{totals.adjusted.toLocaleString('da-DK')}</strong> units from{' '}
                <strong>{suppliers.filter(s => s.styles.some(st => feedback[`${s.supplier}|${st.style_no}|${st.color}`]?.verdict !== 'skipped')).length}</strong> suppliers
              </div>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={saveFeedback} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Save Progress
                </Button>
                <Button onClick={createAppPOs} disabled={creatingPOs} className="bg-emerald-600 hover:bg-emerald-700">
                  {creatingPOs && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Create APP POs →
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Completed state */}
        {purchaseRun?.status === 'completed' && (
          <div className="mt-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-900 mb-2">Purchase Round Complete</h3>
            <p className="text-slate-500 mb-4">Draft POs have been created and are ready for review.</p>
            <Link href="/purchase/app-pos">
              <Button>View APP Purchase Orders →</Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
