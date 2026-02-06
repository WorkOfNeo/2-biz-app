import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient({ cookies });
  const searchParams = request.nextUrl.searchParams;
  
  const seasonId = searchParams.get('seasonId');
  const days = parseInt(searchParams.get('days') || '90', 10);
  
  try {
    // Build date filter
    const dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);
    
    // Query all completed rounds with feedback
    let query = supabase
      .from('purchase_ai_runs')
      .select(`
        id,
        season_id,
        purchase_stage,
        run_number,
        created_at,
        purchase_ai_line_feedback (
          style_no,
          color,
          supplier_name,
          suggested_qty,
          adjusted_qty,
          verdict,
          sizes,
          suggested_breakdown,
          adjusted_breakdown
        )
      `)
      .eq('status', 'completed')
      .gte('created_at', dateFilter.toISOString())
      .order('created_at', { ascending: false });
    
    if (seasonId) {
      query = query.eq('season_id', seasonId);
    }
    
    const { data: rounds, error } = await query;
    
    if (error) throw error;
    
    // Flatten feedback data
    type FeedbackRow = {
      round_id: string;
      season_id: string;
      purchase_stage: string;
      run_number: number;
      created_at: string;
      style_no: string;
      color: string;
      supplier_name: string;
      suggested_qty: number;
      adjusted_qty: number | null;
      verdict: string;
      sizes: string[];
      suggested_breakdown: number[];
      adjusted_breakdown: number[] | null;
    };
    
    const allFeedback: FeedbackRow[] = [];
    
    for (const round of rounds || []) {
      const feedback = (round as any).purchase_ai_line_feedback || [];
      for (const fb of feedback) {
        allFeedback.push({
          round_id: round.id,
          season_id: round.season_id,
          purchase_stage: round.purchase_stage || 'unknown',
          run_number: round.run_number || 0,
          created_at: round.created_at,
          style_no: fb.style_no,
          color: fb.color,
          supplier_name: fb.supplier_name,
          suggested_qty: fb.suggested_qty,
          adjusted_qty: fb.adjusted_qty,
          verdict: fb.verdict,
          sizes: fb.sizes || [],
          suggested_breakdown: fb.suggested_breakdown || [],
          adjusted_breakdown: fb.adjusted_breakdown || null,
        });
      }
    }
    
    // Calculate patterns
    
    // 1. Summary metrics
    const totalSuggestions = allFeedback.length;
    const approvedCount = allFeedback.filter(f => f.verdict === 'approved').length;
    const adjustedCount = allFeedback.filter(f => f.verdict === 'adjusted').length;
    const skippedCount = allFeedback.filter(f => f.verdict === 'skipped').length;
    
    const adjustedEntries = allFeedback.filter(
      f => f.verdict === 'adjusted' && f.adjusted_qty !== null && f.suggested_qty > 0
    );
    
    const avgAdjustmentRatio = adjustedEntries.length > 0
      ? adjustedEntries.reduce((sum, f) => sum + (f.adjusted_qty! / f.suggested_qty), 0) / adjustedEntries.length
      : null;
    
    const approvalRate = totalSuggestions > 0 ? approvedCount / totalSuggestions : 0;
    
    // 2. Trends by week
    const weeklyData = new Map<string, { ratios: number[]; count: number }>();
    
    for (const fb of adjustedEntries) {
      const date = new Date(fb.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay()); // Start of week (Sunday)
      const weekKey = weekStart.toISOString().split('T')[0] || '';
      
      if (weekKey && !weeklyData.has(weekKey)) {
        weeklyData.set(weekKey, { ratios: [], count: 0 });
      }
      
      if (weekKey) {
        const week = weeklyData.get(weekKey)!;
        week.ratios.push(fb.adjusted_qty! / fb.suggested_qty);
        week.count++;
      }
    }
    
    const trendsByWeek = Array.from(weeklyData.entries())
      .map(([week, data]) => ({
        week,
        avgRatio: data.ratios.reduce((a, b) => a + b, 0) / data.ratios.length,
        count: data.count,
      }))
      .sort((a, b) => a.week.localeCompare(b.week));
    
    // 3. Supplier patterns
    const supplierData = new Map<string, {
      suggestions: FeedbackRow[];
      adjusted: FeedbackRow[];
      skipped: FeedbackRow[];
    }>();
    
    for (const fb of allFeedback) {
      if (!supplierData.has(fb.supplier_name)) {
        supplierData.set(fb.supplier_name, { suggestions: [], adjusted: [], skipped: [] });
      }
      
      const supplier = supplierData.get(fb.supplier_name)!;
      supplier.suggestions.push(fb);
      
      if (fb.verdict === 'adjusted') supplier.adjusted.push(fb);
      if (fb.verdict === 'skipped') supplier.skipped.push(fb);
    }
    
    const supplierPatterns = Array.from(supplierData.entries())
      .map(([supplier, data]) => {
        const totalSuggestions = data.suggestions.length;
        const adjustedCount = data.adjusted.length;
        const skippedCount = data.skipped.length;
        const skipRate = totalSuggestions > 0 ? skippedCount / totalSuggestions : 0;
        
        const validAdjustments = data.adjusted.filter(
          f => f.adjusted_qty !== null && f.suggested_qty > 0
        );
        
        const avgAdjustmentRatio = validAdjustments.length > 0
          ? validAdjustments.reduce((sum, f) => sum + (f.adjusted_qty! / f.suggested_qty), 0) / validAdjustments.length
          : null;
        
        return {
          supplier,
          totalSuggestions,
          adjustedCount,
          skippedCount,
          avgAdjustmentRatio,
          skipRate,
        };
      })
      .sort((a, b) => b.totalSuggestions - a.totalSuggestions);
    
    // 4. Stage patterns
    const stageData = new Map<string, {
      suggestions: FeedbackRow[];
      approved: FeedbackRow[];
      adjusted: FeedbackRow[];
    }>();
    
    for (const fb of allFeedback) {
      const stage = fb.purchase_stage;
      if (!stageData.has(stage)) {
        stageData.set(stage, { suggestions: [], approved: [], adjusted: [] });
      }
      
      const stageInfo = stageData.get(stage)!;
      stageInfo.suggestions.push(fb);
      
      if (fb.verdict === 'approved') stageInfo.approved.push(fb);
      if (fb.verdict === 'adjusted') stageInfo.adjusted.push(fb);
    }
    
    const stagePatterns: Record<string, any> = {};
    
    for (const [stage, data] of stageData.entries()) {
      const totalSuggestions = data.suggestions.length;
      const approvalRate = totalSuggestions > 0 ? data.approved.length / totalSuggestions : 0;
      
      const validAdjustments = data.adjusted.filter(
        f => f.adjusted_qty !== null && f.suggested_qty > 0
      );
      
      const avgRatio = validAdjustments.length > 0
        ? validAdjustments.reduce((sum, f) => sum + (f.adjusted_qty! / f.suggested_qty), 0) / validAdjustments.length
        : null;
      
      stagePatterns[stage] = {
        avgRatio,
        count: totalSuggestions,
        approvalRate,
        adjustedCount: data.adjusted.length,
      };
    }
    
    // 5. Top adjusted styles (most frequently adjusted)
    const styleAdjustments = new Map<string, {
      style_no: string;
      color: string;
      suggested_total: number;
      adjusted_total: number;
      count: number;
    }>();
    
    for (const fb of adjustedEntries) {
      const key = `${fb.style_no}|${fb.color}`;
      
      if (!styleAdjustments.has(key)) {
        styleAdjustments.set(key, {
          style_no: fb.style_no,
          color: fb.color,
          suggested_total: 0,
          adjusted_total: 0,
          count: 0,
        });
      }
      
      const style = styleAdjustments.get(key)!;
      style.suggested_total += fb.suggested_qty;
      style.adjusted_total += fb.adjusted_qty!;
      style.count++;
    }
    
    const topAdjustedStyles = Array.from(styleAdjustments.values())
      .map(s => ({
        ...s,
        avgSuggested: Math.round(s.suggested_total / s.count),
        avgAdjusted: Math.round(s.adjusted_total / s.count),
        avgRatio: s.adjusted_total / s.suggested_total,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    
    // 6. Adjustment distribution (histogram buckets)
    const distributionBuckets = {
      'decrease_50plus': 0, // < 0.5
      'decrease_25_50': 0,  // 0.5 - 0.75
      'decrease_0_25': 0,   // 0.75 - 1.0
      'no_change': 0,       // 1.0
      'increase_0_25': 0,   // 1.0 - 1.25
      'increase_25_50': 0,  // 1.25 - 1.5
      'increase_50plus': 0, // > 1.5
    };
    
    for (const fb of adjustedEntries) {
      const ratio = fb.adjusted_qty! / fb.suggested_qty;
      
      if (ratio < 0.5) distributionBuckets.decrease_50plus++;
      else if (ratio < 0.75) distributionBuckets.decrease_25_50++;
      else if (ratio < 1.0) distributionBuckets.decrease_0_25++;
      else if (ratio === 1.0) distributionBuckets.no_change++;
      else if (ratio < 1.25) distributionBuckets.increase_0_25++;
      else if (ratio < 1.5) distributionBuckets.increase_25_50++;
      else distributionBuckets.increase_50plus++;
    }
    
    return NextResponse.json({
      summary: {
        totalRounds: rounds?.length || 0,
        totalSuggestions,
        approvedCount,
        adjustedCount,
        skippedCount,
        avgAdjustmentRatio,
        approvalRate,
      },
      trendsByWeek,
      supplierPatterns,
      stagePatterns,
      topAdjustedStyles,
      adjustmentDistribution: distributionBuckets,
    });
    
  } catch (error: any) {
    console.error('Error fetching purchase patterns:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch patterns' },
      { status: 500 }
    );
  }
}
