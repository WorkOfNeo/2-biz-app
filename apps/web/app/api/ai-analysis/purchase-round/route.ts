export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30; // Quick - just enqueues a job

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

interface PurchaseRoundRequest {
  seasonId?: string;
  comparisonSeasonId?: string;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: PurchaseRoundRequest = await req.json();

    // Get season IDs
    let seasonId = body.seasonId;
    let comparisonSeasonId = body.comparisonSeasonId;

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

    console.log('[Purchase Round] Starting for season:', seasonId);

    // Get next purchase round number
    const { data: lastRound } = await supabase
      .from('purchase_ai_runs')
      .select('run_number')
      .eq('season_id', seasonId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextRoundNumber = ((lastRound as any)?.run_number || 0) + 1;
    console.log('[Purchase Round] Round number:', nextRoundNumber);

    // Create a purchase_ai_runs record first (so we have an ID to redirect to)
    const { data: purchaseRun, error: purchaseRunError } = await supabase
      .from('purchase_ai_runs')
      .insert({
        season_id: seasonId,
        comparison_season_id: comparisonSeasonId || null,
        run_label: `Round_${nextRoundNumber}`,
        run_number: nextRoundNumber,
        status: 'pending',
        run_started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (purchaseRunError || !purchaseRun) {
      console.error('[Purchase Round] Failed to create purchase run:', purchaseRunError);
      return NextResponse.json({ error: 'Failed to create purchase run' }, { status: 500 });
    }

    console.log('[Purchase Round] Created purchase run:', purchaseRun.id);

    // Enqueue the worker job to run the AI analysis
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        type: 'run_ai_analysis',
        payload: {
          analysisType: 'purchase_round',
          seasonId,
          comparisonSeasonId: comparisonSeasonId || null,
          purchaseRoundNumber: nextRoundNumber,
          purchaseRunId: purchaseRun.id, // Link to the purchase run
          sendEmail: false,
        },
        status: 'queued',
        max_attempts: 2,
        queue: 'default',
        priority: 100,
      })
      .select('id')
      .single();

    if (jobError) {
      console.error('[Purchase Round] Failed to enqueue job:', jobError);
      // Update purchase run status to cancelled (valid enum value)
      await supabase.from('purchase_ai_runs').update({ status: 'cancelled' }).eq('id', purchaseRun.id);
      return NextResponse.json({ error: 'Failed to enqueue analysis job' }, { status: 500 });
    }

    console.log('[Purchase Round] Enqueued job:', job.id);

    // IMPORTANT: Update purchase_ai_runs with job_id so UI can poll job logs
    const { error: updateError } = await supabase
      .from('purchase_ai_runs')
      .update({ job_id: job.id })
      .eq('id', purchaseRun.id);

    if (updateError) {
      console.error('[Purchase Round] Failed to update job_id:', updateError);
      // Continue anyway - the job is enqueued
    }

    return NextResponse.json({
      success: true,
      message: 'Purchase round started. Redirecting to review page...',
      purchaseRunId: purchaseRun.id,
      jobId: job.id,
      purchaseRoundNumber: nextRoundNumber,
      seasonId,
      comparisonSeasonId,
    });

  } catch (e: any) {
    console.error('[Purchase Round] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed to start purchase round' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to start a purchase round' }, { status: 405 });
}
