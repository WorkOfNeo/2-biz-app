'use client';

import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { 
  ArrowLeft, Brain, TrendingUp, Users, Package, Calendar, 
  ChevronDown, ChevronUp, User, Globe, BarChart3, Clock, Mail, FileDown
} from 'lucide-react';
import { useState, useMemo } from 'react';
import Image from 'next/image';

type Analysis = {
  id: string;
  season_id: string;
  comparison_season_id: string | null;
  analysis_type: 'daily' | 'purchase_round';
  analysis_date: string;
  executive_summary: string | null;
  metrics: any;
  salesperson_reports: Record<string, any>;
  style_insights: any;
  warnings: string[];
  recommendations: string[];
  comparison_note: string | null;
  purchase_round_number: number | null;
  purchase_recommendations: any;
  email_sent_at: string | null;
  email_recipients: string[];
  created_at: string;
  pdf_url: string | null;
  season?: { name: string; year: number | null };
  comparison_season?: { name: string; year: number | null };
};

function SalespersonCard({ report, expanded, onToggle }: { report: any; expanded: boolean; onToggle: () => void }) {
  const statusColors: Record<string, string> = {
    strong_start: 'bg-green-100 text-green-700',
    on_track: 'bg-blue-100 text-blue-700',
    behind: 'bg-amber-100 text-amber-700',
    not_started: 'bg-slate-100 text-slate-500',
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-full">
            <User className="h-4 w-4 text-indigo-600" />
          </div>
          <div className="text-left">
            <div className="font-medium text-slate-900">{report.name}</div>
            <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[report.status] || 'bg-slate-100 text-slate-500'}`}>
              {report.status?.replace('_', ' ')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {report.performance_score !== undefined && (
            <div className="text-right">
              <div className="text-lg font-bold text-slate-900">{report.performance_score}/10</div>
              <div className="text-xs text-slate-500">score</div>
            </div>
          )}
          {expanded ? <ChevronUp className="h-5 w-5 text-slate-400" /> : <ChevronDown className="h-5 w-5 text-slate-400" />}
        </div>
      </button>
      {expanded && (
        <div className="p-4 pt-0 space-y-3 border-t bg-slate-50">
          <p className="text-slate-700">{report.summary}</p>
          {report.recommendations && report.recommendations.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Recommendations:</div>
              <ul className="space-y-1">
                {report.recommendations.map((r: string, i: number) => (
                  <li key={i} className="text-sm text-slate-600 flex items-start gap-2">
                    <span className="text-indigo-500 mt-0.5">•</span>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AnalysisDetailPage() {
  const params = useParams();
  const router = useRouter();
  const analysisId = params.id as string;
  const [expandedSalespersons, setExpandedSalespersons] = useState<Set<string>>(new Set());

  const { data: analysis, error } = useSWR(
    analysisId ? ['ai-analysis', analysisId] : null,
    async () => {
      const { data, error } = await supabase
        .from('ai_season_analyses')
        .select(`
          *,
          season:seasons!ai_season_analyses_season_id_fkey(name, year),
          comparison_season:seasons!ai_season_analyses_comparison_season_id_fkey(name, year)
        `)
        .eq('id', analysisId)
        .single();
      if (error) throw new Error(error.message);
      return data as Analysis;
    }
  );

  // Extract style numbers from top_styles to fetch style info
  const topStyleNos = useMemo(() => {
    if (!analysis?.metrics?.top_styles) return [];
    return analysis.metrics.top_styles.slice(0, 15).map((s: any) => s.style_no).filter(Boolean);
  }, [analysis]);

  // Fetch style info (image, name) for top styles
  const { data: stylesInfo } = useSWR(
    topStyleNos.length > 0 ? ['styles-info', topStyleNos.join(',')] : null,
    async () => {
      const { data } = await supabase
        .from('styles')
        .select('style_no, name, image_url')
        .in('style_no', topStyleNos);
      // Build a lookup map
      const map: Record<string, { name: string | null; image_url: string | null }> = {};
      for (const s of (data || [])) {
        map[s.style_no] = { name: s.name, image_url: s.image_url };
      }
      return map;
    }
  );

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
          Failed to load analysis: {error.message}
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3"></div>
          <div className="h-32 bg-slate-200 rounded"></div>
          <div className="h-64 bg-slate-200 rounded"></div>
        </div>
      </div>
    );
  }

  const toggleSalesperson = (id: string) => {
    const next = new Set(expandedSalespersons);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedSalespersons(next);
  };

  const salespersonReports = Object.entries(analysis.salesperson_reports || {}).map(([id, report]) => ({
    id,
    ...(report as any)
  }));

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/ai-analysis"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              {analysis.analysis_type === 'purchase_round' ? (
                <>
                  <Package className="h-6 w-6 text-emerald-600" />
                  Purchase Round #{analysis.purchase_round_number || '?'}
                </>
              ) : (
                <>
                  <Brain className="h-6 w-6 text-indigo-600" />
                  Daily Analysis
                </>
              )}
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {new Date(analysis.analysis_date).toLocaleDateString('da-DK', { 
                  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' 
                })}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" />
                {new Date(analysis.created_at).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {analysis.email_sent_at && (
                <span className="flex items-center gap-1 text-green-600">
                  <Mail className="h-4 w-4" />
                  Email sent
                </span>
              )}
              {analysis.pdf_url && (
                <a 
                  href={analysis.pdf_url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700"
                >
                  <FileDown className="h-4 w-4" />
                  Download PDF
                </a>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-slate-500">Season</div>
            <div className="font-semibold text-slate-900">
              {(analysis.season as any)?.name} {(analysis.season as any)?.year}
            </div>
            {analysis.comparison_season && (
              <div className="text-xs text-slate-400 mt-1">
                vs {(analysis.comparison_season as any)?.name} {(analysis.comparison_season as any)?.year}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Executive Summary */}
      <div className="bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-100 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-medium text-indigo-600 mb-2">Executive Summary</h2>
        <p className="text-lg text-slate-900">{analysis.executive_summary || 'No summary available'}</p>
        {analysis.comparison_note && (
          <p className="mt-3 text-sm text-indigo-700 flex items-center gap-1">
            <TrendingUp className="h-4 w-4" />
            {analysis.comparison_note}
          </p>
        )}
      </div>

      {/* Key Metrics Grid */}
      {analysis.metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white border rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Total Sold</div>
            <div className="text-3xl font-bold text-slate-900 mt-1">
              {(analysis.metrics.totals?.qty_sold || 0).toLocaleString()}
            </div>
            <div className="text-sm text-slate-500">pieces</div>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Revenue</div>
            <div className="text-3xl font-bold text-slate-900 mt-1">
              {((analysis.metrics.totals?.revenue || 0) / 1000).toFixed(0)}K
            </div>
            <div className="text-sm text-slate-500">DKK</div>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Customer Visit Rate</div>
            <div className="text-3xl font-bold text-slate-900 mt-1">
              {analysis.metrics.customer_coverage?.visit_rate_percent || 0}%
            </div>
            <div className="text-sm text-slate-500">
              {analysis.metrics.customer_coverage?.visited_customers || 0} / {analysis.metrics.customer_coverage?.total_customers || 0}
            </div>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Daily Velocity</div>
            <div className="text-3xl font-bold text-slate-900 mt-1">
              {analysis.metrics.velocity?.avg_daily_qty || 0}
            </div>
            <div className="text-sm text-slate-500">pcs/day</div>
          </div>
        </div>
      )}

      {/* Salesperson Table */}
      {analysis.metrics?.salesperson_table && analysis.metrics.salesperson_table.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden mb-6">
          <div className="p-4 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <Users className="h-5 w-5 text-slate-400" />
              Salesperson Progress
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-medium text-slate-600">Salesperson</th>
                  <th className="text-right p-3 font-medium text-slate-600">Visited</th>
                  <th className="text-right p-3 font-medium text-slate-600">Qty</th>
                  <th className="text-right p-3 font-medium text-slate-600">Price</th>
                  <th className="text-right p-3 font-medium text-slate-600">Index</th>
                </tr>
              </thead>
              <tbody>
                {analysis.metrics.salesperson_table.map((sp: any, i: number) => (
                  <tr key={i} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-medium text-slate-900">{sp.salesperson}</td>
                    <td className="p-3 text-right text-slate-700">{sp.visited_customers}</td>
                    <td className="p-3 text-right text-slate-700">{sp.qty.toLocaleString()}</td>
                    <td className="p-3 text-right text-slate-700">{sp.price.toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                    <td className="p-3 text-right">
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
          <div className="p-3 bg-slate-50 border-t text-xs text-slate-500">
            Index = This season qty / Last season qty for visited customers (100% = same as last year)
          </div>
        </div>
      )}

      {/* Salesperson Reports */}
      {salespersonReports.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden mb-6">
          <div className="p-4 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <Users className="h-5 w-5 text-slate-400" />
              Salesperson Performance ({salespersonReports.length})
            </h2>
          </div>
          <div className="p-4 space-y-3">
            {salespersonReports.map((report) => (
              <SalespersonCard
                key={report.id}
                report={report}
                expanded={expandedSalespersons.has(report.id)}
                onToggle={() => toggleSalesperson(report.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Style Insights */}
      {analysis.style_insights && Object.keys(analysis.style_insights).length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden mb-6">
          <div className="p-4 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-slate-400" />
              Style Insights
            </h2>
          </div>
          <div className="p-4 grid md:grid-cols-3 gap-4">
            {analysis.style_insights.hot_styles && analysis.style_insights.hot_styles.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-green-700 mb-2">🔥 Hot Styles</h3>
                <ul className="space-y-1">
                  {analysis.style_insights.hot_styles.map((s: string, i: number) => (
                    <li key={i} className="text-sm text-slate-600 bg-green-50 px-2 py-1 rounded">{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {analysis.style_insights.concerns && analysis.style_insights.concerns.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-amber-700 mb-2">⚠️ Concerns</h3>
                <ul className="space-y-1">
                  {analysis.style_insights.concerns.map((s: string, i: number) => (
                    <li key={i} className="text-sm text-slate-600 bg-amber-50 px-2 py-1 rounded">{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {analysis.style_insights.watch_list && analysis.style_insights.watch_list.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-slate-700 mb-2">👀 Watch List</h3>
                <ul className="space-y-1">
                  {analysis.style_insights.watch_list.map((s: string, i: number) => (
                    <li key={i} className="text-sm text-slate-600 bg-slate-50 px-2 py-1 rounded">{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Country Breakdown */}
      {analysis.metrics?.by_country && analysis.metrics.by_country.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden mb-6">
          <div className="p-4 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <Globe className="h-5 w-5 text-slate-400" />
              Country Performance
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-medium text-slate-600">Country</th>
                  <th className="text-right p-3 font-medium text-slate-600">Qty Sold</th>
                  <th className="text-right p-3 font-medium text-slate-600">Revenue</th>
                  <th className="text-right p-3 font-medium text-slate-600">Customers</th>
                </tr>
              </thead>
              <tbody>
                {analysis.metrics.by_country.map((c: any, i: number) => (
                  <tr key={i} className="border-b">
                    <td className="p-3 font-medium">{c.country}</td>
                    <td className="p-3 text-right">{c.qty.toLocaleString()}</td>
                    <td className="p-3 text-right">{(c.revenue / 1000).toFixed(0)}K DKK</td>
                    <td className="p-3 text-right">{c.customer_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top Styles */}
      {analysis.metrics?.top_styles && analysis.metrics.top_styles.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden">
          <div className="p-4 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-slate-400" />
              Top Selling Styles
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-medium text-slate-600">Style</th>
                  <th className="text-right p-3 font-medium text-slate-600">Qty Sold</th>
                  <th className="text-right p-3 font-medium text-slate-600">Colors</th>
                  <th className="text-right p-3 font-medium text-slate-600">Customers</th>
                </tr>
              </thead>
              <tbody>
                {analysis.metrics.top_styles.slice(0, 15).map((s: any, i: number) => {
                  const styleInfo = stylesInfo?.[s.style_no];
                  return (
                    <tr key={i} className="border-b hover:bg-slate-50">
                      <td className="p-3">
                        <div className="flex items-center gap-3">
                          {styleInfo?.image_url ? (
                            <div className="relative w-12 h-12 rounded overflow-hidden bg-slate-100 shrink-0">
                              <Image
                                src={styleInfo.image_url}
                                alt={s.style_no}
                                fill
                                className="object-cover"
                                sizes="48px"
                              />
                            </div>
                          ) : (
                            <div className="w-12 h-12 rounded bg-slate-100 flex items-center justify-center text-slate-400 text-xs shrink-0">
                              No img
                            </div>
                          )}
                          <div>
                            <div className="font-medium text-slate-900">
                              {styleInfo?.name || s.style_no}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">{s.style_no}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-right font-semibold">{s.total_qty.toLocaleString()}</td>
                      <td className="p-3 text-right">{s.colors_count}</td>
                      <td className="p-3 text-right">{s.customer_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
