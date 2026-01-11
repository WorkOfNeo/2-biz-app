export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

type AnalysisType = 'daily' | 'purchase_round';

interface RunAnalysisRequest {
  analysisType?: AnalysisType;
  seasonId?: string;
  comparisonSeasonId?: string;
  purchaseRoundNumber?: number;
  sendEmail?: boolean;
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: RunAnalysisRequest = await req.json();
    const { analysisType = 'daily', purchaseRoundNumber, sendEmail = false } = body;

    // Get season IDs from request or from app_settings
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
      return NextResponse.json({ error: 'No season configured. Set season_compare in settings.' }, { status: 400 });
    }

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
          analysisType,
          seasonId,
          comparisonSeasonId: comparisonSeasonId || null,
          purchaseRoundNumber: purchaseRoundNumber || null,
          sendEmail
        },
        status: 'queued',
        max_attempts: 1 // AI analysis should not auto-retry
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('[AI Analysis] Failed to enqueue job:', insertError);
      return NextResponse.json({ error: 'Failed to start analysis', detail: insertError.message }, { status: 500 });
    }

    // Log the job creation
    await supabase.from('job_logs').insert({
      job_id: job.id,
      level: 'info',
      msg: 'AI analysis job enqueued',
      data: { analysisType, seasonId, comparisonSeasonId }
    });

    console.log('[AI Analysis] Job enqueued:', job.id, { analysisType, seasonId });

    return NextResponse.json({
      success: true,
      message: 'AI analysis job started. Check job logs for progress.',
      jobId: job.id,
      analysisType,
      seasonId,
      comparisonSeasonId
    });

  } catch (e: any) {
    console.error('[AI Analysis] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed to start analysis' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to run analysis' }, { status: 405 });
}
