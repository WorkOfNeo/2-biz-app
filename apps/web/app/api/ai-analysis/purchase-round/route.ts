export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

    // Check for existing running analysis job
    const { data: existingJobs } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'run_ai_analysis')
      .in('status', ['queued', 'running'])
      .limit(1);

    if (existingJobs && existingJobs.length > 0) {
      return NextResponse.json({ 
        error: 'An AI analysis job is already running', 
        existingJobId: existingJobs[0].id 
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
