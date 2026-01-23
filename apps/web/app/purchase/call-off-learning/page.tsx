'use client';

import React, { useState, useEffect } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { 
  TrendingUp, 
  TrendingDown, 
  ThumbsUp, 
  ThumbsDown, 
  BarChart3, 
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Brain,
  Target
} from 'lucide-react';

interface FeedbackEntry {
  id: string;
  style_no: string;
  color: string;
  verdict: 'correct' | 'incorrect';
  notes: string | null;
  suggested_order: Record<string, number> | null;
  actual_order: Record<string, number> | null;
  created_at: string;
  created_by: string | null;
}

interface StyleStats {
  style_no: string;
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  lastFeedback: string;
  adjustments: Record<string, number>;
}

interface DailyStats {
  date: string;
  total: number;
  correct: number;
  incorrect: number;
}

export default function CallOffLearningPage() {
  const supabase = createClientComponentClient();
  
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [styleStats, setStyleStats] = useState<StyleStats[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [overallStats, setOverallStats] = useState({
    total: 0,
    correct: 0,
    incorrect: 0,
    accuracy: 0,
    stylesWithFeedback: 0,
    avgCorrectionsPerStyle: 0
  });
  const [expandedStyle, setExpandedStyle] = useState<string | null>(null);
  
  // Fetch all feedback data
  const fetchData = async () => {
    setLoading(true);
    
    try {
      const { data, error } = await supabase
        .from('call_off_feedback')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      
      if (error) throw error;
      
      const entries = (data || []) as FeedbackEntry[];
      setFeedback(entries);
      
      // Calculate overall stats
      const total = entries.length;
      const correct = entries.filter(e => e.verdict === 'correct').length;
      const incorrect = entries.filter(e => e.verdict === 'incorrect').length;
      const accuracy = total > 0 ? (correct / total) * 100 : 0;
      
      // Calculate per-style stats
      const byStyle = new Map<string, FeedbackEntry[]>();
      for (const entry of entries) {
        const key = entry.style_no;
        if (!byStyle.has(key)) byStyle.set(key, []);
        byStyle.get(key)!.push(entry);
      }
      
      const stats: StyleStats[] = [];
      for (const [style_no, styleEntries] of byStyle) {
        const styleTotal = styleEntries.length;
        const styleCorrect = styleEntries.filter(e => e.verdict === 'correct').length;
        const styleIncorrect = styleEntries.filter(e => e.verdict === 'incorrect').length;
        
        // Calculate learned adjustments from actual_order vs suggested_order
        const adjustments: Record<string, number> = {};
        const incorrectWithActual = styleEntries.filter(e => 
          e.verdict === 'incorrect' && e.suggested_order && e.actual_order
        );
        
        for (const entry of incorrectWithActual) {
          const suggested = entry.suggested_order!;
          const actual = entry.actual_order!;
          
          for (const size of Object.keys(suggested)) {
            const sugQty = suggested[size] || 0;
            const actQty = actual[size] || 0;
            
            if (sugQty > 0) {
              const ratio = actQty / sugQty;
              // Blend with existing
              const existing = adjustments[size] ?? 1.0;
              adjustments[size] = existing * 0.7 + ratio * 0.3;
            }
          }
        }
        
        stats.push({
          style_no,
          total: styleTotal,
          correct: styleCorrect,
          incorrect: styleIncorrect,
          accuracy: styleTotal > 0 ? (styleCorrect / styleTotal) * 100 : 0,
          lastFeedback: styleEntries[0]?.created_at || '',
          adjustments
        });
      }
      
      // Sort by most feedback
      stats.sort((a, b) => b.total - a.total);
      setStyleStats(stats);
      
      // Calculate daily stats (last 30 days)
      const dailyMap = new Map<string, { total: number; correct: number; incorrect: number }>();
      for (const entry of entries) {
        const date = entry.created_at.split('T')[0]!;
        if (!dailyMap.has(date)) {
          dailyMap.set(date, { total: 0, correct: 0, incorrect: 0 });
        }
        const day = dailyMap.get(date)!;
        day.total++;
        if (entry.verdict === 'correct') day.correct++;
        else day.incorrect++;
      }
      
      const daily = Array.from(dailyMap.entries())
        .map(([date, stats]) => ({ date, ...stats }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);
      
      setDailyStats(daily);
      
      setOverallStats({
        total,
        correct,
        incorrect,
        accuracy,
        stylesWithFeedback: byStyle.size,
        avgCorrectionsPerStyle: byStyle.size > 0 ? incorrect / byStyle.size : 0
      });
      
    } catch (err) {
      console.error('Failed to fetch feedback:', err);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchData();
  }, []);
  
  // Simple bar chart component
  const MiniChart = ({ data, height = 60 }: { data: DailyStats[]; height?: number }) => {
    if (data.length === 0) return <div className="text-slate-400 text-sm">No data yet</div>;
    
    const maxTotal = Math.max(...data.map(d => d.total), 1);
    
    return (
      <div className="flex items-end gap-0.5" style={{ height }}>
        {data.map((day, i) => {
          const correctHeight = (day.correct / maxTotal) * height;
          const incorrectHeight = (day.incorrect / maxTotal) * height;
          
          return (
            <div 
              key={day.date} 
              className="flex-1 flex flex-col justify-end"
              title={`${day.date}: ${day.correct} correct, ${day.incorrect} incorrect`}
            >
              <div 
                className="bg-red-400 w-full rounded-t-sm" 
                style={{ height: incorrectHeight }}
              />
              <div 
                className="bg-green-500 w-full" 
                style={{ height: correctHeight }}
              />
            </div>
          );
        })}
      </div>
    );
  };
  
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('da-DK', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Brain className="h-6 w-6 text-indigo-600" />
            Quick PO Learning Dashboard
          </h1>
          <p className="text-slate-500 mt-1">
            Track how the AI learns from your feedback to improve size distributions
          </p>
        </div>
        <Button 
          onClick={fetchData} 
          variant="outline" 
          disabled={loading}
          className="border-slate-300"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      
      {/* Overall Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Total Feedback</p>
                <p className="text-2xl font-bold">{overallStats.total}</p>
              </div>
              <BarChart3 className="h-8 w-8 text-slate-300" />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Accuracy</p>
                <p className={`text-2xl font-bold ${
                  overallStats.accuracy >= 80 ? 'text-green-600' :
                  overallStats.accuracy >= 60 ? 'text-amber-600' :
                  'text-red-600'
                }`}>
                  {overallStats.accuracy.toFixed(1)}%
                </p>
              </div>
              {overallStats.accuracy >= 70 ? (
                <TrendingUp className="h-8 w-8 text-green-400" />
              ) : (
                <TrendingDown className="h-8 w-8 text-red-400" />
              )}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Correct</p>
                <p className="text-2xl font-bold text-green-600">{overallStats.correct}</p>
              </div>
              <ThumbsUp className="h-8 w-8 text-green-300" />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Corrections</p>
                <p className="text-2xl font-bold text-red-600">{overallStats.incorrect}</p>
              </div>
              <ThumbsDown className="h-8 w-8 text-red-300" />
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Learning Curve Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" />
            Learning Curve (Last 30 Days)
          </CardTitle>
          <CardDescription>
            Green = correct suggestions, Red = corrections needed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MiniChart data={dailyStats} height={100} />
          {dailyStats.length > 0 && (
            <div className="flex justify-between text-xs text-slate-400 mt-1">
              <span>{dailyStats[0]?.date}</span>
              <span>{dailyStats[dailyStats.length - 1]?.date}</span>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Per-Style Breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Style-by-Style Learning</CardTitle>
          <CardDescription>
            Click to see learned adjustments for each style
          </CardDescription>
        </CardHeader>
        <CardContent>
          {styleStats.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              No feedback recorded yet. Use the Quick PO Flow and rate the suggestions!
            </div>
          ) : (
            <div className="space-y-2">
              {styleStats.map(style => (
                <div key={style.style_no} className="border rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedStyle(
                      expandedStyle === style.style_no ? null : style.style_no
                    )}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-medium">{style.style_no}</span>
                      <div className="flex items-center gap-1">
                        <Badge className="bg-green-100 text-green-700 text-xs">
                          {style.correct} ✓
                        </Badge>
                        <Badge className="bg-red-100 text-red-700 text-xs">
                          {style.incorrect} ✗
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-medium ${
                        style.accuracy >= 80 ? 'text-green-600' :
                        style.accuracy >= 60 ? 'text-amber-600' :
                        'text-red-600'
                      }`}>
                        {style.accuracy.toFixed(0)}% accuracy
                      </span>
                      {expandedStyle === style.style_no ? (
                        <ChevronUp className="h-4 w-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      )}
                    </div>
                  </button>
                  
                  {expandedStyle === style.style_no && (
                    <div className="px-4 py-3 bg-slate-50 border-t">
                      <div className="text-xs text-slate-500 mb-2">
                        Last feedback: {formatDate(style.lastFeedback)}
                      </div>
                      
                      {Object.keys(style.adjustments).length > 0 ? (
                        <div>
                          <div className="text-xs font-medium text-indigo-600 mb-1">
                            Learned Adjustments (multipliers)
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(style.adjustments)
                              .sort(([a], [b]) => {
                                const numA = parseInt(a);
                                const numB = parseInt(b);
                                if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                                return a.localeCompare(b);
                              })
                              .map(([size, mult]) => (
                                <span 
                                  key={size}
                                  className={`px-2 py-1 rounded text-xs font-mono ${
                                    mult > 1.1 ? 'bg-green-100 text-green-700' :
                                    mult < 0.9 ? 'bg-red-100 text-red-700' :
                                    'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {size}: {mult.toFixed(2)}×
                                </span>
                              ))
                            }
                          </div>
                          <div className="text-[10px] text-slate-400 mt-1">
                            {'>'}1.0 = increase order, {'<'}1.0 = decrease order for that size
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">
                          No adjustments learned yet. Mark suggestions as wrong and provide correct quantities to train.
                        </div>
                      )}
                      
                      {/* Recent feedback for this style */}
                      <div className="mt-3 pt-3 border-t">
                        <div className="text-xs font-medium text-slate-600 mb-2">Recent Feedback</div>
                        <div className="space-y-1">
                          {feedback
                            .filter(f => f.style_no === style.style_no)
                            .slice(0, 5)
                            .map(f => (
                              <div key={f.id} className="flex items-center gap-2 text-xs">
                                {f.verdict === 'correct' ? (
                                  <ThumbsUp className="h-3 w-3 text-green-500" />
                                ) : (
                                  <ThumbsDown className="h-3 w-3 text-red-500" />
                                )}
                                <span className="text-slate-500">{f.color}</span>
                                <span className="text-slate-400">{formatDate(f.created_at)}</span>
                                {f.notes && (
                                  <span className="text-slate-400 truncate max-w-[200px]">
                                    — {f.notes}
                                  </span>
                                )}
                              </div>
                            ))
                          }
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* How It Works */}
      <Card className="bg-indigo-50 border-indigo-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-indigo-800">How Learning Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-indigo-700 space-y-2">
          <p>
            <strong>1. You rate suggestions:</strong> Use 👍/👎 in Quick PO Flow to mark if the size distribution was good or wrong.
          </p>
          <p>
            <strong>2. Provide corrections:</strong> When marking as wrong, enter the correct quantities so the system can learn.
          </p>
          <p>
            <strong>3. AI adjusts:</strong> For styles with corrections, the system calculates adjustment multipliers (e.g., 1.2× for size 40 means order 20% more).
          </p>
          <p>
            <strong>4. Better over time:</strong> The hybrid formula (25% base + 45% historical + 30% need) is further adjusted by these learned multipliers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
