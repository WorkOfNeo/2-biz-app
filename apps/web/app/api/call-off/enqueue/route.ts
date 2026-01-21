import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * NOOS Call-Off Analysis - Enqueue Job
 * 
 * This endpoint creates a job for the worker to process the analysis.
 * The analysis can take a long time for many style/colors, so we enqueue it.
 */

interface CallOffRequest {
  selections: Array<{ style_no: string; color: string }>;
  months: string[]; // YYYY-MM format
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body: CallOffRequest = await req.json();

    const { selections, months } = body;

    // Validate inputs
    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    if (!Array.isArray(months) || months.length === 0) {
      return NextResponse.json({ error: 'months array is required (format: YYYY-MM)' }, { status: 400 });
    }

    // Validate month format
    for (const month of months) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: `Invalid month format: ${month}. Use YYYY-MM` }, { status: 400 });
      }
    }

    console.log('[Call-Off Enqueue] Starting for', selections.length, 'selections,', months.length, 'months');

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();

    // Create a call_off_runs record to track the analysis
    const { data: callOffRun, error: runError } = await supabase
      .from('call_off_runs')
      .insert({
        status: 'pending',
        user_id: user?.id || null,
        selection_count: selections.length,
        months: months,
        prompt_version: 'v2', // Track prompt version
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (runError) {
      console.error('[Call-Off Enqueue] Failed to create run:', runError);
      // If table doesn't exist, continue without run tracking
      if (runError.code === '42P01') {
        console.warn('[Call-Off Enqueue] call_off_runs table does not exist, continuing without tracking');
      } else {
        return NextResponse.json({ error: 'Failed to create analysis run: ' + runError.message }, { status: 500 });
      }
    }

    const runId = callOffRun?.id;
    console.log('[Call-Off Enqueue] Created run:', runId);

    // Enqueue the worker job
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        type: 'call_off_analysis',
        payload: {
          runId,
          selections,
          months,
          promptVersion: 'v2',
        },
        status: 'queued',
        max_attempts: 2,
        queue: 'default',
        priority: 100,
      })
      .select('id')
      .single();

    if (jobError) {
      console.error('[Call-Off Enqueue] Failed to create job:', jobError);
      // Update run status if we have one
      if (runId) {
        await supabase.from('call_off_runs').update({ status: 'failed' }).eq('id', runId);
      }
      return NextResponse.json({ error: 'Failed to enqueue analysis job: ' + jobError.message }, { status: 500 });
    }

    console.log('[Call-Off Enqueue] Created job:', job.id);

    // Update run with job ID
    if (runId) {
      await supabase.from('call_off_runs').update({ job_id: job.id }).eq('id', runId);
    }

    return NextResponse.json({
      success: true,
      message: 'Analysis job enqueued. Processing will begin shortly.',
      runId,
      jobId: job.id,
      selectionsCount: selections.length,
      months,
    });

  } catch (error: any) {
    console.error('[Call-Off Enqueue] Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to enqueue analysis' }, { status: 500 });
  }
}
