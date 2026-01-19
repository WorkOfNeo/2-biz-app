/**
 * API route to manually trigger the statistics email pipeline
 * POST /api/statistics/run-email-pipeline
 * Body: { scheduleId: string }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { scheduleId } = await req.json();
    
    if (!scheduleId || typeof scheduleId !== 'string') {
      return NextResponse.json({ error: 'Missing scheduleId' }, { status: 400 });
    }

    // Use service role to bypass RLS
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
    
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Supabase env missing' }, { status: 500 });
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Validate that the schedule exists
    const { data: settingsRow } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'statistic_schedules')
      .maybeSingle();

    const schedules = ((settingsRow?.value as any)?.schedules ?? []) as Array<{ id: string; name: string }>;
    const schedule = schedules.find((s) => s.id === scheduleId);

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    // Enqueue the pipeline job
    const { data: job, error: insertErr } = await supabase
      .from('jobs')
      .insert({
        type: 'run_statistics_email_pipeline',
        payload: {
          scheduleId,
          requestedBy: 'manual_dashboard',
        },
        status: 'queued',
        max_attempts: 180, // High retry count for waiter pattern (~3 hours at 1 min intervals)
        queue: 'default',
        priority: 100,
      })
      .select('id')
      .single();

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    const jobId = (job as any)?.id;

    // Log initial enqueue
    await supabase.from('job_logs').insert({
      job_id: jobId,
      level: 'info',
      msg: 'Pipeline enqueued via manual trigger',
      data: { scheduleId, scheduleName: schedule.name },
    });

    return NextResponse.json({
      success: true,
      jobId,
      scheduleName: schedule.name,
    });
  } catch (err: any) {
    console.error('[run-email-pipeline] Error:', err);
    return NextResponse.json({ error: err?.message || 'Failed to enqueue pipeline' }, { status: 500 });
  }
}
