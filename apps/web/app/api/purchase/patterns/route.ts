import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient({ cookies });
  const searchParams = request.nextUrl.searchParams;
  
  const seasonId = searchParams.get('seasonId');
  const days = parseInt(searchParams.get('days') || '90', 10);
  const promptKey = searchParams.get('promptKey') || 'purchase_decision_per_supplier_v1';
  
  try {
    // Build date filter
    const dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);
    
    // Query all completed rounds with feedback, including prompt metadata
    let query = supabase
      .from('purchase_ai_runs')
      .select(`
        id,
        season_id,
        purchase_stage,
        run_number,
        created_at,
        prompt_key,
        prompt_version,
        purchase_ai_line_feedback (
          style_no,
          color,
          supplier_name,
          suggested_qty,
          adjusted_qty,
          verdict
        )
      `)
      .eq('status', 'completed')
      .gte('created_at', dateFilter.toISOString())
      .order('created_at', { ascending: false });
    
    if (seasonId) {
      query = query.eq('season_id', seasonId);
    }
    
    if (promptKey) {
      query = query.eq('prompt_key', promptKey);
    }
    
    const { data: rounds, error } = await query;
    
    if (error) throw error;
    
    // Flatten data by prompt version
    type FeedbackRow = {
      round_id: string;
      season_id: string;
      purchase_stage: string;
      created_at: string;
      prompt_key: string | null;
      prompt_version: number | null;
      style_no: string;
      color: string;
      supplier_name: string;
      suggested_qty: number;
      adjusted_qty: number | null;
      verdict: string;
    };
    
    const allFeedback: FeedbackRow[] = [];
    
    for (const round of rounds || []) {
      const feedback = (round as any).purchase_ai_line_feedback || [];
      for (const fb of feedback) {
        allFeedback.push({
          round_id: round.id,
          season_id: round.season_id,
          purchase_stage: round.purchase_stage || 'unknown',
          created_at: round.created_at,
          prompt_key: (round as any).prompt_key || null,
          prompt_version: (round as any).prompt_version || null,
          style_no: fb.style_no,
          color: fb.color,
          supplier_name: fb.supplier_name,
          suggested_qty: fb.suggested_qty,
          adjusted_qty: fb.adjusted_qty,
          verdict: fb.verdict,
        });
      }
    }
    
    // Group by prompt version
    const byVersion = new Map<number | string, FeedbackRow[]>();
    
    for (const fb of allFeedback) {
      const versionKey = fb.prompt_version !== null ? fb.prompt_version : 'unknown';
      if (!byVersion.has(versionKey)) {
        byVersion.set(versionKey, []);
      }
      byVersion.get(versionKey)!.push(fb);
    }
    
    // Calculate metrics per version
    const versionMetrics = Array.from(byVersion.entries()).map(([version, feedbacks]) => {
      const totalSuggestions = feedbacks.length;
      const approvedCount = feedbacks.filter(f => f.verdict === 'approved').length;
      const adjustedCount = feedbacks.filter(f => f.verdict === 'adjusted').length;
      const skippedCount = feedbacks.filter(f => f.verdict === 'skipped').length;
      
      const adjustedEntries = feedbacks.filter(
        f => f.verdict === 'adjusted' && f.adjusted_qty !== null && f.suggested_qty > 0
      );
      
      const avgAdjustmentRatio = adjustedEntries.length > 0
        ? adjustedEntries.reduce((sum, f) => sum + (f.adjusted_qty! / f.suggested_qty), 0) / adjustedEntries.length
        : null;
      
      const approvalRate = totalSuggestions > 0 ? approvedCount / totalSuggestions : 0;
      const skipRate = totalSuggestions > 0 ? skippedCount / totalSuggestions : 0;
      
      // Count unique rounds
      const uniqueRounds = new Set(feedbacks.map(f => f.round_id)).size;
      
      // Get date range
      const dates = feedbacks.map(f => new Date(f.created_at).getTime());
      const firstUsed = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
      const lastUsed = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;
      
      return {
        version: version === 'unknown' ? 'Unknown' : `v${version}`,
        versionNumber: version === 'unknown' ? null : Number(version),
        roundCount: uniqueRounds,
        totalSuggestions,
        approvedCount,
        adjustedCount,
        skippedCount,
        approvalRate,
        skipRate,
        avgAdjustmentRatio,
        firstUsed,
        lastUsed,
      };
    }).sort((a, b) => {
      if (a.versionNumber === null) return 1;
      if (b.versionNumber === null) return -1;
      return b.versionNumber - a.versionNumber;
    });
    
    // Get current active prompt version from prompts table
    const { data: activePrompt } = await supabase
      .from('ai_prompts')
      .select('key, version, updated_at')
      .eq('key', promptKey)
      .eq('active', true)
      .single();
    
    // Calculate overall summary (latest version or all if no version)
    const latestVersion = versionMetrics[0];
    
    // Calculate improvement from previous version
    let approvalRateChange: number | undefined;
    let skipRateChange: number | undefined;
    
    if (versionMetrics.length >= 2) {
      const current = versionMetrics[0];
      const previous = versionMetrics[1];
      approvalRateChange = current.approvalRate - previous.approvalRate;
      skipRateChange = current.skipRate - previous.skipRate;
    }
    
    const summary = {
      currentPromptKey: promptKey,
      currentVersion: activePrompt?.version || null,
      currentVersionUpdated: activePrompt?.updated_at || null,
      totalRounds: rounds?.length || 0,
      totalSuggestions: allFeedback.length,
      latestApprovalRate: latestVersion?.approvalRate || 0,
      latestSkipRate: latestVersion?.skipRate || 0,
      latestAvgAdjustmentRatio: latestVersion?.avgAdjustmentRatio,
      approvalRateChange,
      skipRateChange,
    };
    
    // Context-specific performance (by stage)
    const byStage = new Map<string, FeedbackRow[]>();
    for (const fb of allFeedback) {
      if (!byStage.has(fb.purchase_stage)) {
        byStage.set(fb.purchase_stage, []);
      }
      byStage.get(fb.purchase_stage)!.push(fb);
    }
    
    const stageMetrics: Record<string, any> = {};
    for (const [stage, feedbacks] of byStage.entries()) {
      const byVersionForStage = new Map<number | string, FeedbackRow[]>();
      
      for (const fb of feedbacks) {
        const versionKey = fb.prompt_version !== null ? fb.prompt_version : 'unknown';
        if (!byVersionForStage.has(versionKey)) {
          byVersionForStage.set(versionKey, []);
        }
        byVersionForStage.get(versionKey)!.push(fb);
      }
      
      const versionStats = Array.from(byVersionForStage.entries()).map(([version, vfb]) => {
        const approved = vfb.filter(f => f.verdict === 'approved').length;
        const total = vfb.length;
        return {
          version: version === 'unknown' ? 'Unknown' : `v${version}`,
          versionNumber: version === 'unknown' ? null : Number(version),
          approvalRate: total > 0 ? approved / total : 0,
          count: total,
        };
      }).sort((a, b) => {
        if (a.versionNumber === null) return 1;
        if (b.versionNumber === null) return -1;
        return b.versionNumber - a.versionNumber;
      });
      
      stageMetrics[stage] = versionStats;
    }
    
    // Supplier-specific performance (top 10 suppliers)
    const bySupplier = new Map<string, FeedbackRow[]>();
    for (const fb of allFeedback) {
      if (!bySupplier.has(fb.supplier_name)) {
        bySupplier.set(fb.supplier_name, []);
      }
      bySupplier.get(fb.supplier_name)!.push(fb);
    }
    
    const supplierMetrics = Array.from(bySupplier.entries())
      .map(([supplier, feedbacks]) => {
        const byVersionForSupplier = new Map<number | string, FeedbackRow[]>();
        
        for (const fb of feedbacks) {
          const versionKey = fb.prompt_version !== null ? fb.prompt_version : 'unknown';
          if (!byVersionForSupplier.has(versionKey)) {
            byVersionForSupplier.set(versionKey, []);
          }
          byVersionForSupplier.get(versionKey)!.push(fb);
        }
        
        const versionStats = Array.from(byVersionForSupplier.entries()).map(([version, vfb]) => {
          const approved = vfb.filter(f => f.verdict === 'approved').length;
          const total = vfb.length;
          return {
            version: version === 'unknown' ? 'Unknown' : `v${version}`,
            versionNumber: version === 'unknown' ? null : Number(version),
            approvalRate: total > 0 ? approved / total : 0,
            count: total,
          };
        }).sort((a, b) => {
          if (a.versionNumber === null) return 1;
          if (b.versionNumber === null) return -1;
          return b.versionNumber - a.versionNumber;
        });
        
        return {
          supplier,
          totalSuggestions: feedbacks.length,
          versions: versionStats,
        };
      })
      .sort((a, b) => b.totalSuggestions - a.totalSuggestions)
      .slice(0, 10);
    
    return NextResponse.json({
      summary,
      versionMetrics,
      stageMetrics,
      supplierMetrics,
    });
    
  } catch (error: any) {
    console.error('Error fetching prompt performance:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch prompt performance' },
      { status: 500 }
    );
  }
}
