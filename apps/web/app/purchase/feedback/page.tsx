'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';

type FeedbackItem = {
  id: string;
  purchase_run_id: string;
  supplier_name: string;
  style_no: string;
  color: string;
  suggested_qty: number;
  adjusted_qty: number | null;
  verdict: 'approved' | 'adjusted' | 'skipped';
  reason: string | null;
  created_at: string;
  run_label?: string;
  run_number?: number;
};

type FeedbackSummary = {
  total: number;
  approved: number;
  adjusted: number;
  skipped: number;
  avgAdjustmentPercent: number;
  topPatterns: Array<{ pattern: string; count: number }>;
};

export default function FeedbackPage() {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [seasons, setSeasons] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedSeason, setSelectedSeason] = useState<string>('');
  const [filterVerdict, setFilterVerdict] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch seasons
  useEffect(() => {
    async function fetchSeasons() {
      try {
        const res = await fetch('/api/seasons?active=true');
        const data = await res.json();
        if (data.seasons) {
          setSeasons(data.seasons);
          if (data.seasons.length > 0) {
            setSelectedSeason(data.seasons[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to fetch seasons:', err);
      }
    }
    fetchSeasons();
  }, []);

  // Fetch feedback when season changes
  useEffect(() => {
    if (!selectedSeason) return;
    
    async function fetchFeedback() {
      setLoading(true);
      try {
        const res = await fetch(`/api/purchase/ai-suggestions/feedback/list?seasonId=${selectedSeason}`);
        const data = await res.json();
        
        if (data.feedback) {
          setFeedback(data.feedback);
          
          // Calculate summary
          const items = data.feedback as FeedbackItem[];
          const approved = items.filter(f => f.verdict === 'approved').length;
          const adjusted = items.filter(f => f.verdict === 'adjusted').length;
          const skipped = items.filter(f => f.verdict === 'skipped').length;
          
          // Calculate average adjustment
          const adjustments = items
            .filter(f => f.verdict === 'adjusted' && f.adjusted_qty && f.suggested_qty > 0)
            .map(f => ((f.adjusted_qty! - f.suggested_qty) / f.suggested_qty) * 100);
          
          const avgAdj = adjustments.length > 0 
            ? adjustments.reduce((a, b) => a + b, 0) / adjustments.length 
            : 0;
          
          // Find patterns in reasons
          const reasonCounts: Record<string, number> = {};
          items.filter(f => f.reason).forEach(f => {
            const words = f.reason!.toLowerCase().split(/\s+/);
            words.forEach(w => {
              if (w.length > 4) {
                reasonCounts[w] = (reasonCounts[w] || 0) + 1;
              }
            });
          });
          
          const patterns = Object.entries(reasonCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pattern, count]) => ({ pattern, count }));
          
          setSummary({
            total: items.length,
            approved,
            adjusted,
            skipped,
            avgAdjustmentPercent: avgAdj,
            topPatterns: patterns,
          });
        }
      } catch (err) {
        console.error('Failed to fetch feedback:', err);
      } finally {
        setLoading(false);
      }
    }
    
    fetchFeedback();
  }, [selectedSeason]);

  // Filter feedback
  const filteredFeedback = feedback.filter(f => {
    if (filterVerdict !== 'all' && f.verdict !== filterVerdict) return false;
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      return (
        f.style_no.toLowerCase().includes(search) ||
        f.color.toLowerCase().includes(search) ||
        f.supplier_name.toLowerCase().includes(search) ||
        (f.reason?.toLowerCase().includes(search) ?? false)
      );
    }
    return true;
  });

  // Delete feedback
  const deleteFeedback = async (id: string) => {
    if (!confirm('Delete this feedback?')) return;
    
    try {
      await fetch(`/api/purchase/ai-suggestions/feedback/${id}`, {
        method: 'DELETE',
      });
      setFeedback(prev => prev.filter(f => f.id !== id));
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">AI Feedback & Learning</h1>
          <p className="text-slate-500">Review corrections made to AI suggestions</p>
        </div>
        <select 
          value={selectedSeason} 
          onChange={e => setSelectedSeason(e.target.value)}
          className="w-[200px] h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
        >
          <option value="">Select season</option>
          {seasons.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-slate-700">{summary.total}</div>
              <div className="text-xs text-slate-500">Total Ratings</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-600">{summary.approved}</div>
              <div className="text-xs text-slate-500">Correct</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-amber-600">{summary.adjusted}</div>
              <div className="text-xs text-slate-500">Incorrect</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-slate-500">{summary.skipped}</div>
              <div className="text-xs text-slate-500">Skipped</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className={`text-2xl font-bold ${summary.avgAdjustmentPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {summary.avgAdjustmentPercent >= 0 ? '+' : ''}{summary.avgAdjustmentPercent.toFixed(0)}%
              </div>
              <div className="text-xs text-slate-500">Avg Adjustment</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Insights */}
      {summary && summary.adjusted > 0 && (
        <Card className="mb-6 bg-[#F5F3F0] border-[#C5D5CA]">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">💡 Insights from Corrections</CardTitle>
            <CardDescription>Patterns detected in your feedback</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {summary.avgAdjustmentPercent > 20 && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-green-600">↑</span>
                  <span>AI tends to suggest <strong>too low</strong> - consider increasing base quantities in prompt</span>
                </div>
              )}
              {summary.avgAdjustmentPercent < -20 && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-red-600">↓</span>
                  <span>AI tends to suggest <strong>too high</strong> - consider being more conservative in prompt</span>
                </div>
              )}
              {summary.topPatterns.length > 0 && (
                <div className="text-sm">
                  <span className="text-slate-500">Common words in reasons: </span>
                  {summary.topPatterns.map((p, i) => (
                    <Badge key={p.pattern} variant="outline" className="ml-1">
                      {p.pattern} ({p.count})
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <Input
          placeholder="Search style, color, supplier, reason..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="max-w-sm"
        />
        <select 
          value={filterVerdict} 
          onChange={e => setFilterVerdict(e.target.value)}
          className="w-[150px] h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
        >
          <option value="all">All</option>
          <option value="approved">Correct</option>
          <option value="adjusted">Incorrect</option>
          <option value="skipped">Skipped</option>
        </select>
      </div>

      {/* Feedback Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-slate-500">Loading...</div>
          ) : filteredFeedback.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No feedback yet. Rate suggestions as "Correct" or "Incorrect" when reviewing.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-left p-3 font-medium">Style</th>
                  <th className="text-left p-3 font-medium">Color</th>
                  <th className="text-left p-3 font-medium">Supplier</th>
                  <th className="text-right p-3 font-medium">AI Said</th>
                  <th className="text-right p-3 font-medium">Should Be</th>
                  <th className="text-right p-3 font-medium">Diff</th>
                  <th className="text-left p-3 font-medium">Reason</th>
                  <th className="text-center p-3 font-medium">Verdict</th>
                  <th className="text-center p-3 font-medium w-16"></th>
                </tr>
              </thead>
              <tbody>
                {filteredFeedback.map(f => {
                  const diff = f.adjusted_qty !== null ? f.adjusted_qty - f.suggested_qty : 0;
                  const diffPercent = f.suggested_qty > 0 ? (diff / f.suggested_qty) * 100 : 0;
                  
                  return (
                    <tr key={f.id} className="border-t hover:bg-slate-50">
                      <td className="p-3 font-mono text-xs">{f.style_no}</td>
                      <td className="p-3">{f.color}</td>
                      <td className="p-3 text-xs text-slate-500">{f.supplier_name.substring(0, 20)}...</td>
                      <td className="p-3 text-right">{f.suggested_qty}</td>
                      <td className="p-3 text-right font-semibold">
                        {f.adjusted_qty ?? '-'}
                      </td>
                      <td className={`p-3 text-right text-xs ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {diff !== 0 ? `${diff > 0 ? '+' : ''}${diff} (${diffPercent.toFixed(0)}%)` : '-'}
                      </td>
                      <td className="p-3 text-xs text-slate-600 max-w-[200px] truncate" title={f.reason || ''}>
                        {f.reason || '-'}
                      </td>
                      <td className="p-3 text-center">
                        <Badge className={
                          f.verdict === 'approved' ? 'bg-green-100 text-green-700' :
                          f.verdict === 'adjusted' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-600'
                        }>
                          {f.verdict === 'approved' ? '✓' : f.verdict === 'adjusted' ? '✗' : '○'}
                        </Badge>
                      </td>
                      <td className="p-3 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteFeedback(f.id)}
                          className="h-6 w-6 p-0 text-slate-400 hover:text-red-500"
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Prompt Tips */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">🛠 Prompt Tuning Tips</CardTitle>
          <CardDescription>Based on your feedback patterns</CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <div>
            <strong>File:</strong> <code className="bg-slate-100 px-2 py-0.5 rounded">apps/web/lib/ai/prompts.ts</code>
          </div>
          <div>
            <strong>Key sections to edit:</strong>
            <ul className="list-disc list-inside mt-1 space-y-1 text-slate-600">
              <li><strong>Rule 1</strong>: Salesperson coverage → confidence</li>
              <li><strong>Rule 2</strong>: Season timing (early/mid/closing)</li>
              <li><strong>Rule 3</strong>: Customer potential per rep</li>
              <li><strong>Rule 4</strong>: When to suggest LESS than sold</li>
            </ul>
          </div>
          <div className="bg-slate-100 p-3 rounded-md">
            <strong>Example adjustment:</strong><br/>
            If you're always correcting +50% on early season runs, add to Rule 2:<br/>
            <code className="text-xs">"EARLY SEASON: Suggest 1.5-2x of CURRENT_SOLD_QTY as buffer"</code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

