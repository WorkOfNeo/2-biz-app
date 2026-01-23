import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET /api/learning/overview
 * Consolidated learning stats for the Learning Studio dashboard
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get('days') || '30');

    // Get all feedback for the period
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const { data: feedback, error: feedbackError } = await supabase
      .from('call_off_feedback')
      .select('*')
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (feedbackError) {
      return NextResponse.json({ error: feedbackError.message }, { status: 500 });
    }

    // Calculate overall stats
    const total = feedback?.length || 0;
    const correct = feedback?.filter(f => f.verdict === 'correct').length || 0;
    const incorrect = feedback?.filter(f => f.verdict === 'incorrect').length || 0;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    // Stats by flow
    const byFlow: Record<string, { total: number; correct: number; incorrect: number }> = {
      quick_po: { total: 0, correct: 0, incorrect: 0 },
      call_off: { total: 0, correct: 0, incorrect: 0 }
    };
    
    for (const f of feedback || []) {
      const flow = f.flow || 'quick_po'; // Default to quick_po for legacy data
      if (!byFlow[flow]) byFlow[flow] = { total: 0, correct: 0, incorrect: 0 };
      byFlow[flow].total++;
      if (f.verdict === 'correct') byFlow[flow].correct++;
      else byFlow[flow].incorrect++;
    }

    // Stats by prompt version
    const byPromptVersion: Record<string, { total: number; correct: number; incorrect: number }> = {};
    for (const f of feedback || []) {
      if (!f.prompt_key) continue;
      const key = `${f.prompt_key}_v${f.prompt_version || '?'}`;
      if (!byPromptVersion[key]) byPromptVersion[key] = { total: 0, correct: 0, incorrect: 0 };
      byPromptVersion[key].total++;
      if (f.verdict === 'correct') byPromptVersion[key].correct++;
      else byPromptVersion[key].incorrect++;
    }

    // Daily breakdown for chart
    const dailyMap = new Map<string, { total: number; correct: number; incorrect: number }>();
    for (const f of feedback || []) {
      const date = f.created_at.split('T')[0];
      if (!dailyMap.has(date)) dailyMap.set(date, { total: 0, correct: 0, incorrect: 0 });
      const day = dailyMap.get(date)!;
      day.total++;
      if (f.verdict === 'correct') day.correct++;
      else day.incorrect++;
    }
    
    const dailyStats = Array.from(dailyMap.entries())
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Per-style stats with learned adjustments
    const byStyle = new Map<string, typeof feedback>();
    for (const f of feedback || []) {
      const key = f.style_no;
      if (!byStyle.has(key)) byStyle.set(key, []);
      byStyle.get(key)!.push(f);
    }

    const styleStats = Array.from(byStyle.entries()).map(([style_no, entries]) => {
      const styleTotal = entries.length;
      const styleCorrect = entries.filter(e => e.verdict === 'correct').length;
      const styleIncorrect = entries.filter(e => e.verdict === 'incorrect').length;
      
      // Calculate learned multipliers
      const adjustments: Record<string, number> = {};
      const incorrectWithActual = entries.filter(e => 
        e.verdict === 'incorrect' && e.suggested_order && e.actual_order
      );
      
      for (const entry of incorrectWithActual) {
        const suggested = entry.suggested_order as Record<string, number>;
        const actual = entry.actual_order as Record<string, number>;
        
        for (const size of Object.keys(suggested)) {
          const sugQty = suggested[size] || 0;
          const actQty = actual[size] || 0;
          
          if (sugQty > 0) {
            const ratio = actQty / sugQty;
            const existing = adjustments[size] ?? 1.0;
            adjustments[size] = existing * 0.7 + ratio * 0.3;
          }
        }
      }

      return {
        style_no,
        total: styleTotal,
        correct: styleCorrect,
        incorrect: styleIncorrect,
        accuracy: styleTotal > 0 ? (styleCorrect / styleTotal) * 100 : 0,
        lastFeedback: entries[0]?.created_at || '',
        adjustments
      };
    }).sort((a, b) => b.total - a.total);

    // Get active prompts
    const { data: activePrompts } = await supabase
      .from('ai_prompts')
      .select('key, version, updated_at')
      .eq('active', true);

    // Get recent learning events
    const { data: recentEvents } = await supabase
      .from('ai_learning_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    // Get example counts by prompt key
    const { data: exampleCounts } = await supabase
      .from('ai_prompt_examples')
      .select('prompt_key, enabled')
      .eq('enabled', true);

    const examplesByKey: Record<string, number> = {};
    for (const ex of exampleCounts || []) {
      examplesByKey[ex.prompt_key] = (examplesByKey[ex.prompt_key] || 0) + 1;
    }

    return NextResponse.json({
      overview: {
        total,
        correct,
        incorrect,
        accuracy,
        days,
        stylesWithFeedback: byStyle.size,
        avgCorrectionsPerStyle: byStyle.size > 0 ? incorrect / byStyle.size : 0
      },
      byFlow,
      byPromptVersion,
      dailyStats,
      styleStats: styleStats.slice(0, 50), // Top 50
      activePrompts: activePrompts || [],
      recentEvents: recentEvents || [],
      exampleCounts: examplesByKey
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
