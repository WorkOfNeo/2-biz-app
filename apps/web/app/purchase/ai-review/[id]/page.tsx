'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Input } from '../../../../components/ui/input';
import Link from 'next/link';
import { 
  ArrowLeft, Check, X, Edit3, Package, Loader2, TrendingUp, 
  ChevronDown, ChevronRight, Building2, RefreshCw, CheckCircle2, 
  AlertTriangle, Clock, XCircle, ShoppingCart
} from 'lucide-react';

const supabase = createClientComponentClient();

type SupplierSuggestion = {
  supplier: string;
  styles: StyleSuggestion[];
  total_qty: number;
  priority?: 'high' | 'medium' | 'low';
  commentary?: string;
};

type StyleSuggestion = {
  style_no: string;
  style_name?: string;
  color: string;
  suggested_qty: number;
  size_breakdown?: Record<string, number>;
  reasoning?: string;
};

type PurchaseRun = {
  id: string;
  season_id: string;
  comparison_season_id: string | null;
  run_label: string | null;
  run_number: number | null;
  status: 'pending' | 'reviewing' | 'completed' | 'cancelled';
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

// Feedback per style
type LineFeedback = {
  style_no: string;
  color: string;
  supplier_name: string;
  suggested_qty: number;
  adjusted_qty: number | null;
  verdict: 'approved' | 'adjusted' | 'skipped';
  reason: string | null;
};

export default function AIPurchaseReviewPage() {
  const params = useParams();
  const router = useRouter();
  const purchaseRunId = params.id as string;

  const [feedback, setFeedback] = useState<Record<string, LineFeedback>>({});
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [creatingPOs, setCreatingPOs] = useState(false);
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);

  // Track if we should poll (for pending status)
  const [shouldPoll, setShouldPoll] = useState(true);

  // Fetch the purchase run
  const { data: purchaseRun, mutate, error } = useSWR<PurchaseRun>(
    purchaseRunId ? `purchase-run-${purchaseRunId}` : null,
    async () => {
      const { data, error } = await supabase
        .from('purchase_ai_runs')
        .select(`
          id, season_id, comparison_season_id, run_label, run_number, status,
          supplier_suggestions, computed_features_snapshot,
          run_started_at, run_completed_at, job_id, created_at,
          season:seasons!season_id(name, year)
        `)
        .eq('id', purchaseRunId)
        .single();

      if (error) throw new Error(error.message);
      
      // Flatten season array
      const row = data as any;
      return {
        ...row,
        season: Array.isArray(row.season) && row.season.length > 0 ? row.season[0] : undefined
      } as PurchaseRun;
    },
    { refreshInterval: shouldPoll ? 2000 : 0 }
  );

  // Stop polling once no longer pending
  useEffect(() => {
    if (purchaseRun && purchaseRun.status !== 'pending') {
      setShouldPoll(false);
    }
  }, [purchaseRun?.status]);

  // Fetch existing line feedback
  const { data: existingFeedback } = useSWR(
    purchaseRunId ? `line-feedback-${purchaseRunId}` : null,
    async () => {
      const { data } = await supabase
        .from('purchase_ai_line_feedback')
        .select('*')
        .eq('purchase_run_id', purchaseRunId);
      return data || [];
    }
  );

  // Initialize feedback from existing data
  useEffect(() => {
    if (existingFeedback && existingFeedback.length > 0) {
      const feedbackMap: Record<string, LineFeedback> = {};
      existingFeedback.forEach((fb: any) => {
        const key = `${fb.supplier_name}|${fb.style_no}|${fb.color}`;
        feedbackMap[key] = {
          style_no: fb.style_no,
          color: fb.color,
          supplier_name: fb.supplier_name,
          suggested_qty: fb.suggested_qty,
          adjusted_qty: fb.adjusted_qty,
          verdict: fb.verdict,
          reason: fb.reason,
        };
      });
      setFeedback(feedbackMap);
    }
  }, [existingFeedback]);

  // Poll job logs while pending
  useEffect(() => {
    if (!purchaseRun?.job_id || purchaseRun.status !== 'pending') return;

    const fetchLogs = async () => {
      const { data } = await supabase
        .from('job_logs')
        .select('id, level, msg, data, created_at')
        .eq('job_id', purchaseRun.job_id)
        .order('created_at', { ascending: true });
      
      if (data) {
        setJobLogs(data);
      }
    };

    fetchLogs();
    const pollInterval = setInterval(fetchLogs, 2000);

    return () => clearInterval(pollInterval);
  }, [purchaseRun?.job_id, purchaseRun?.status]);

  // Auto-expand first supplier with suggestions
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
        
        suggested += style.suggested_qty;
        
        if (fb) {
          if (fb.verdict === 'skipped') {
            skippedCount++;
          } else {
            approvedCount++;
            adjusted += fb.verdict === 'adjusted' ? (fb.adjusted_qty || 0) : style.suggested_qty;
          }
        } else {
          adjusted += style.suggested_qty;
        }
      });
    });

    return { suggested, adjusted, approved: approvedCount, skipped: skippedCount };
  }, [purchaseRun?.supplier_suggestions, feedback]);

  function toggleSupplier(supplier: string) {
    setExpandedSuppliers(prev => {
      const next = new Set(prev);
      if (next.has(supplier)) {
        next.delete(supplier);
      } else {
        next.add(supplier);
      }
      return next;
    });
  }

  function handleVerdict(supplier: string, style: StyleSuggestion, verdict: 'approved' | 'adjusted' | 'skipped', adjustedQty?: number) {
    const key = `${supplier}|${style.style_no}|${style.color}`;
    setFeedback(prev => ({
      ...prev,
      [key]: {
        style_no: style.style_no,
        color: style.color,
        supplier_name: supplier,
        suggested_qty: style.suggested_qty,
        adjusted_qty: verdict === 'adjusted' ? adjustedQty || null : null,
        verdict,
        reason: null,
      }
    }));
  }

  function approveAllForSupplier(supplier: SupplierSuggestion) {
    const updates: Record<string, LineFeedback> = {};
    supplier.styles.forEach(style => {
      const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
      updates[key] = {
        style_no: style.style_no,
        color: style.color,
        supplier_name: supplier.supplier,
        suggested_qty: style.suggested_qty,
        adjusted_qty: null,
        verdict: 'approved',
        reason: null,
      };
    });
    setFeedback(prev => ({ ...prev, ...updates }));
  }

  async function saveFeedback() {
    if (!purchaseRunId) return;
    setSaving(true);

    try {
      // Delete existing feedback
      await supabase
        .from('purchase_ai_line_feedback')
        .delete()
        .eq('purchase_run_id', purchaseRunId);

      // Insert new feedback
      const rows = Object.values(feedback).map(fb => ({
        purchase_run_id: purchaseRunId,
        ...fb,
      }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('purchase_ai_line_feedback')
          .insert(rows);
        
        if (error) throw new Error(error.message);
      }

      // Update purchase run status
      await supabase
        .from('purchase_ai_runs')
        .update({ status: 'reviewing', user_feedback: { saved_at: new Date().toISOString() } })
        .eq('id', purchaseRunId);

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
      // Group approved items by supplier
      const bySupplier: Record<string, { styles: any[], totalQty: number }> = {};

      purchaseRun.supplier_suggestions.forEach(supplier => {
        supplier.styles.forEach(style => {
          const key = `${supplier.supplier}|${style.style_no}|${style.color}`;
          const fb = feedback[key];
          
          // Include if no feedback (default approve) or explicitly approved/adjusted
          if (!fb || fb.verdict !== 'skipped') {
            if (!bySupplier[supplier.supplier]) {
              bySupplier[supplier.supplier] = { styles: [], totalQty: 0 };
            }
            
            const supplierEntry = bySupplier[supplier.supplier]!;
            const qty = fb?.verdict === 'adjusted' ? (fb.adjusted_qty || 0) : style.suggested_qty;
            if (qty > 0) {
              supplierEntry.styles.push({
                style_no: style.style_no,
                style_name: style.style_name,
                color: style.color,
                qty,
                size_breakdown: style.size_breakdown,
              });
              supplierEntry.totalQty += qty;
            }
          }
        });
      });

      // Create APP POs
      const createdPoIds: number[] = [];
      
      for (const [supplierName, data] of Object.entries(bySupplier)) {
        if (data.styles.length === 0) continue;

        const { data: po, error } = await supabase
          .from('app_pos')
          .insert({
            supplier_name: supplierName,
            status: 'draft',
            source: 'ai_purchase_round',
            purchase_run_id: purchaseRunId,
            lines: data.styles,
            total_qty: data.totalQty,
            notes: `AI Purchase Round #${purchaseRun.run_number} - Created ${new Date().toLocaleDateString('da-DK')}`,
          })
          .select('id')
          .single();

        if (error) {
          console.error('Failed to create PO for', supplierName, error);
        } else if (po) {
          createdPoIds.push(po.id);
        }
      }

      // Update purchase run with created PO IDs
      await supabase
        .from('purchase_ai_runs')
        .update({ 
          status: 'completed',
          created_app_po_ids: createdPoIds,
        })
        .eq('id', purchaseRunId);

      await mutate();

      alert(`Created ${createdPoIds.length} draft Purchase Orders. Redirecting to APP POs...`);
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
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading purchase round...</p>
        </div>
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
          <Link href="/ai-analysis" className="inline-flex items-center gap-2 mt-4 text-indigo-600 hover:text-indigo-800">
            <ArrowLeft className="h-4 w-4" /> Back to AI Analysis
          </Link>
        </div>
      </div>
    );
  }

  // Pending state - show progress
  if (purchaseRun?.status === 'pending') {
    const currentStep = jobLogs.length > 0 
      ? jobLogs[jobLogs.length - 1]?.msg || 'Starting...'
      : 'Starting...';
    
    const stepMessages: Record<string, string> = {
      'start': 'Starting analysis...',
      'fetching_seasons': 'Loading season data...',
      'seasons_loaded': 'Seasons loaded',
      'fetching_sales_stats': 'Fetching sales statistics...',
      'sales_stats_loaded': 'Sales data loaded',
      'fetching_style_details': 'Loading style details...',
      'style_details_loaded': 'Style details loaded',
      'fetching_comparison': 'Fetching comparison season...',
      'comparison_loaded': 'Comparison data loaded',
      'computing_metrics': 'Computing metrics...',
      'calling_openai': 'Analyzing with AI...',
      'openai_request': 'Waiting for AI response...',
      'openai_complete': 'AI analysis complete',
      'saving_results': 'Saving results...',
      'updating_purchase_run': 'Updating purchase run...',
      'complete': 'Complete!',
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
              AI is analyzing your season data and generating purchase recommendations...
            </p>
          </div>

          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl border border-slate-700/50 p-6">
            {/* Progress indicator */}
            <div className="flex items-center gap-4 mb-6">
              <div className="relative">
                <Loader2 className="h-8 w-8 text-indigo-400 animate-spin" />
              </div>
              <div className="flex-1">
                <p className="text-white font-medium">
                  {stepMessages[currentStep] || currentStep.replace(/_/g, ' ')}
                </p>
                <p className="text-slate-500 text-sm">
                  {purchaseRun.season?.name} {purchaseRun.season?.year}
                </p>
              </div>
            </div>

            {/* Step log */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {jobLogs.map((log, idx) => (
                <div
                  key={log.id}
                  className={`flex items-center gap-3 text-sm transition-all duration-500 ${
                    idx === jobLogs.length - 1 
                      ? 'text-white opacity-100' 
                      : 'text-slate-500 opacity-60'
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

  // Main review UI
  const suppliers = purchaseRun?.supplier_suggestions || [];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/ai-analysis" className="text-slate-400 hover:text-slate-600">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <h1 className="text-xl font-semibold text-slate-900">
                  Purchase Round #{purchaseRun?.run_number}
                </h1>
                <p className="text-sm text-slate-500">
                  {purchaseRun?.season?.name} {purchaseRun?.season?.year} • 
                  {purchaseRun?.run_completed_at && (
                    <> Completed {new Date(purchaseRun.run_completed_at).toLocaleDateString('da-DK')}</>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Badge variant={purchaseRun?.status === 'completed' ? 'default' : 'secondary'}>
                {purchaseRun?.status}
              </Badge>
              
              {purchaseRun?.status === 'reviewing' && (
                <>
                  <Button variant="outline" onClick={saveFeedback} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                    Save Progress
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
              <div className="text-sm text-slate-500">AI Suggested Units</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-emerald-600">{totals.adjusted.toLocaleString('da-DK')}</div>
              <div className="text-sm text-slate-500">Adjusted Total</div>
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

        {/* Supplier Accordions */}
        {suppliers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900">No suggestions available</h3>
              <p className="text-slate-500">The AI analysis didn't generate any purchase recommendations.</p>
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
                return sum + (fb?.verdict === 'adjusted' ? (fb.adjusted_qty || 0) : s.suggested_qty);
              }, 0);

              return (
                <Card key={supplier.supplier} className="overflow-hidden">
                  <div 
                    className="px-6 py-4 bg-slate-50 border-b cursor-pointer hover:bg-slate-100 transition-colors"
                    onClick={() => toggleSupplier(supplier.supplier)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="h-5 w-5 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-5 w-5 text-slate-400" />
                        )}
                        <Building2 className="h-5 w-5 text-slate-600" />
                        <span className="font-semibold text-slate-900">{supplier.supplier}</span>
                        <Badge variant="outline" className="ml-2">
                          {supplier.styles.length} styles
                        </Badge>
                        {supplier.priority && (
                          <Badge variant={supplier.priority === 'high' ? 'destructive' : supplier.priority === 'medium' ? 'default' : 'secondary'}>
                            {supplier.priority}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-lg font-bold text-slate-900">{supplierTotal.toLocaleString('da-DK')}</div>
                          <div className="text-xs text-slate-500">units</div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            approveAllForSupplier(supplier);
                          }}
                        >
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
                        const currentVerdict = fb?.verdict;
                        const displayQty = fb?.verdict === 'adjusted' 
                          ? fb.adjusted_qty 
                          : style.suggested_qty;

                        return (
                          <div 
                            key={idx} 
                            className={`px-6 py-4 flex items-center gap-4 ${
                              currentVerdict === 'skipped' ? 'bg-red-50/50' : 
                              currentVerdict === 'approved' ? 'bg-emerald-50/50' : ''
                            }`}
                          >
                            <div className="flex-1">
                              <div className="font-medium text-slate-900">
                                {style.style_name || style.style_no}
                              </div>
                              <div className="text-sm text-slate-500">
                                {style.style_no} • {style.color}
                              </div>
                              {style.reasoning && (
                                <div className="text-xs text-slate-400 mt-1">{style.reasoning}</div>
                              )}
                            </div>

                            <div className="text-right">
                              <div className="text-lg font-bold text-slate-900">
                                {displayQty?.toLocaleString('da-DK')}
                              </div>
                              <div className="text-xs text-slate-500">
                                suggested: {style.suggested_qty}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <Button
                                variant={currentVerdict === 'approved' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => handleVerdict(supplier.supplier, style, 'approved')}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Input
                                type="number"
                                className="w-20 text-center"
                                placeholder="Qty"
                                value={fb?.verdict === 'adjusted' ? fb.adjusted_qty || '' : ''}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  handleVerdict(supplier.supplier, style, 'adjusted', val);
                                }}
                              />
                              <Button
                                variant={currentVerdict === 'skipped' ? 'destructive' : 'outline'}
                                size="sm"
                                onClick={() => handleVerdict(supplier.supplier, style, 'skipped')}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
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
                <strong>{suppliers.length}</strong> suppliers
              </div>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={saveFeedback} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Save Progress
                </Button>
                <Button onClick={createAppPOs} disabled={creatingPOs} className="bg-emerald-600 hover:bg-emerald-700">
                  {creatingPOs && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Create {suppliers.length} APP POs →
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
            <p className="text-slate-500 mb-4">
              Draft POs have been created and are ready for review.
            </p>
            <Link href="/purchase/app-pos">
              <Button>
                View APP Purchase Orders →
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
