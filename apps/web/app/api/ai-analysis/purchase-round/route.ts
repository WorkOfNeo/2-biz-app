export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180; // Allow up to 3 minutes for import + AI suggestions

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

interface PurchaseRoundRequest {
  seasonId?: string;
  comparisonSeasonId?: string;
  useDetailedAI?: boolean; // Set to true to use AI Suggestions flow instead of simple analysis
}

export async function POST(req: Request) {
  const startTime = Date.now();
  
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: PurchaseRoundRequest = await req.json();

    // Get season IDs
    let seasonId = body.seasonId;
    let comparisonSeasonId = body.comparisonSeasonId;
    const useDetailedAI = body.useDetailedAI !== false; // Default to true

    if (!seasonId) {
      const { data: setting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'season_compare')
        .maybeSingle();
      seasonId = (setting?.value as any)?.s1;
      comparisonSeasonId = (setting?.value as any)?.s2;
    }

    if (!seasonId) {
      return NextResponse.json({ error: 'No season configured' }, { status: 400 });
    }

    console.log('[Purchase Round] Starting for season:', seasonId, 'useDetailedAI:', useDetailedAI);

    // Get next purchase round number
    const { data: lastRound } = await supabase
      .from('ai_season_analyses')
      .select('purchase_round_number')
      .eq('season_id', seasonId)
      .eq('analysis_type', 'purchase_round')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextRoundNumber = ((lastRound as any)?.purchase_round_number || 0) + 1;
    console.log('[Purchase Round] Round number:', nextRoundNumber);

    // =========================================================================
    // DETAILED AI FLOW: Use AI Suggestions with auto-created import from season data
    // =========================================================================
    if (useDetailedAI) {
      // Step 1: Create import from season data
      console.log('[Purchase Round] Step 1: Creating import from season data...');
      
      // Construct base URL - use request origin for most reliable internal calls
      const requestUrl = new URL(req.url);
      const baseUrl = requestUrl.origin;
      console.log('[Purchase Round] Using base URL:', baseUrl);
      
      let importRes: Response;
      try {
        importRes = await fetch(`${baseUrl}/api/purchase/create-import-from-season`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Cookie': req.headers.get('cookie') || '', // Forward auth cookies
          },
          body: JSON.stringify({ seasonId }),
        });
      } catch (fetchError: any) {
        console.error('[Purchase Round] Fetch error for create-import:', fetchError);
        return NextResponse.json({ 
          error: 'Failed to connect to import service',
          detail: fetchError?.message || 'Network error',
        }, { status: 500 });
      }

      // Check if response is actually JSON before parsing
      const importContentType = importRes.headers.get('content-type') || '';
      if (!importContentType.includes('application/json')) {
        const text = await importRes.text();
        console.error('[Purchase Round] Import returned non-JSON:', importRes.status, text.slice(0, 200));
        return NextResponse.json({ 
          error: 'Import service returned invalid response',
          detail: `Status ${importRes.status}: ${text.slice(0, 100)}`,
        }, { status: 500 });
      }

      const importData = await importRes.json();
      
      if (!importRes.ok || !importData.importId) {
        console.error('[Purchase Round] Failed to create import:', importData);
        return NextResponse.json({ 
          error: 'Failed to create import from season data',
          detail: importData.error || 'Unknown error',
        }, { status: 500 });
      }

      const importId = importData.importId;
      console.log('[Purchase Round] Import created/reused:', importId, importData.reused ? '(reused)' : '(new)');

      // Step 2: Run AI Suggestions with the import
      console.log('[Purchase Round] Step 2: Running AI Suggestions...');
      
      let suggestionsRes: Response;
      try {
        suggestionsRes = await fetch(`${baseUrl}/api/purchase/ai-suggestions/run`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Cookie': req.headers.get('cookie') || '',
          },
          body: JSON.stringify({
            importId,
            seasonId,
            comparisonSeasonId: comparisonSeasonId || undefined,
            topNPerSupplier: 200,
            runNumber: nextRoundNumber,
          }),
        });
      } catch (fetchError: any) {
        console.error('[Purchase Round] Fetch error for ai-suggestions:', fetchError);
        return NextResponse.json({ 
          error: 'Failed to connect to AI suggestions service',
          detail: fetchError?.message || 'Network error',
        }, { status: 500 });
      }

      // Check if response is actually JSON before parsing
      const suggestionsContentType = suggestionsRes.headers.get('content-type') || '';
      if (!suggestionsContentType.includes('application/json')) {
        const text = await suggestionsRes.text();
        console.error('[Purchase Round] Suggestions returned non-JSON:', suggestionsRes.status, text.slice(0, 200));
        return NextResponse.json({ 
          error: 'AI suggestions service returned invalid response',
          detail: `Status ${suggestionsRes.status}: ${text.slice(0, 100)}`,
        }, { status: 500 });
      }

      const suggestionsData = await suggestionsRes.json();
      
      if (!suggestionsRes.ok) {
        console.error('[Purchase Round] AI Suggestions failed:', suggestionsData);
        return NextResponse.json({ 
          error: 'AI Suggestions analysis failed',
          detail: suggestionsData.error || 'Unknown error',
        }, { status: 500 });
      }

      console.log('[Purchase Round] AI Suggestions complete:', {
        purchaseRunId: suggestionsData.purchaseRunId,
        totalUnits: suggestionsData.suggestions?.total_units,
        suppliersCount: suggestionsData.suggestions?.suppliers?.length,
      });

      // Step 3: Save analysis record (for the AI Analysis history)
      const executiveSummary = suggestionsData.suggestions?.overall_summary || 
        `Purchase Round #${nextRoundNumber}: ${suggestionsData.suggestions?.total_units?.toLocaleString() || 0} units recommended across ${suggestionsData.suggestions?.suppliers?.length || 0} suppliers.`;

      const { data: analysis, error: analysisError } = await supabase
        .from('ai_season_analyses')
        .insert({
          season_id: seasonId,
          comparison_season_id: comparisonSeasonId || null,
          analysis_type: 'purchase_round',
          analysis_date: new Date().toISOString().split('T')[0],
          executive_summary: executiveSummary,
          metrics: {
            totals: {
              qty_sold: suggestionsData.analysisBackground?.computedFeatures?.overall?.totalQty || 0,
              revenue: suggestionsData.analysisBackground?.computedFeatures?.overall?.totalAmount || 0,
              unique_styles: suggestionsData.analysisBackground?.computedFeatures?.overall?.styleCount || 0,
            },
            customer_coverage: {
              visit_rate_percent: parseFloat(suggestionsData.analysisBackground?.visitRatePercent || '0'),
            },
            purchase_stage: suggestionsData.analysisBackground?.purchaseStage,
            total_recommended_units: suggestionsData.suggestions?.total_units || 0,
            suppliers_count: suggestionsData.suggestions?.suppliers?.length || 0,
            yoy_analysis: suggestionsData.yoyAnalysis || null,
          },
          purchase_round_number: nextRoundNumber,
          purchase_recommendations: suggestionsData.suggestions?.suppliers || null,
          warnings: suggestionsData.suggestions?.warnings || [],
        })
        .select('id')
        .single();

      if (analysisError) {
        console.error('[Purchase Round] Failed to save analysis record:', analysisError);
      }

      const durationMs = Date.now() - startTime;
      console.log('[Purchase Round] Complete in', durationMs, 'ms');

      return NextResponse.json({
        success: true,
        message: 'Purchase round analysis complete with detailed AI suggestions.',
        analysisId: analysis?.id,
        purchaseRunId: suggestionsData.purchaseRunId,
        aiRunId: suggestionsData.aiRunId,
        importId,
        purchaseRoundNumber: nextRoundNumber,
        seasonId,
        comparisonSeasonId,
        summary: {
          totalUnits: suggestionsData.suggestions?.total_units || 0,
          suppliersCount: suggestionsData.suggestions?.suppliers?.length || 0,
          purchaseStage: suggestionsData.analysisBackground?.purchaseStage,
          visitRatePercent: suggestionsData.analysisBackground?.visitRatePercent,
        },
        stats: {
          durationMs,
          tokensUsed: suggestionsData.stats?.tokensUsed || 0,
        },
      });
    }

    // =========================================================================
    // SIMPLE FLOW: Use existing worker-based analysis (legacy)
    // =========================================================================
    // Check for existing running analysis job
    const { data: existingJobs } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'run_ai_analysis')
      .in('status', ['queued', 'running'])
      .limit(1);

    const existingJob = existingJobs?.[0];
    if (existingJob) {
      return NextResponse.json({ 
        error: 'An AI analysis job is already running', 
        existingJobId: existingJob.id 
      }, { status: 409 });
    }

    // Enqueue the job to run on the worker
    const { data: job, error: insertError } = await supabase
      .from('jobs')
      .insert({
        type: 'run_ai_analysis',
        payload: {
          analysisType: 'purchase_round',
          seasonId,
          comparisonSeasonId: comparisonSeasonId || null,
          purchaseRoundNumber: nextRoundNumber,
          sendEmail: false
        },
        status: 'queued',
        max_attempts: 1
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('[Purchase Round] Failed to enqueue job:', insertError);
      return NextResponse.json({ error: 'Failed to start purchase round', detail: insertError.message }, { status: 500 });
    }

    // Log the job creation
    await supabase.from('job_logs').insert({
      job_id: job.id,
      level: 'info',
      msg: 'Purchase round job enqueued',
      data: { seasonId, comparisonSeasonId, roundNumber: nextRoundNumber }
    });

    console.log('[Purchase Round] Job enqueued:', job.id, 'Round #', nextRoundNumber);

    return NextResponse.json({
      success: true,
      message: 'Purchase round job started. Check job logs for progress.',
      jobId: job.id,
      purchaseRoundNumber: nextRoundNumber,
      seasonId,
      comparisonSeasonId
    });

  } catch (e: any) {
    console.error('[Purchase Round] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed to start purchase round' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to start a purchase round' }, { status: 405 });
}
