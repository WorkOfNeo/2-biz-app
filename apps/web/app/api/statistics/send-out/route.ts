/**
 * API route to manually trigger a statistics/stock list send out
 * POST /api/statistics/send-out
 * 
 * Body: {
 *   scrapeFirst: boolean,
 *   salespersonIds: string[], // mutually exclusive with emails
 *   emails: string[],         // mutually exclusive with salespersonIds
 *   include: { countries, top15Salesmen, top15Overall, overview, generalCombined },
 *   stockLists: string[],
 * }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SendOutRequest {
  scrapeFirst?: boolean;
  salespersonIds?: string[];
  emails?: string[];
  include?: {
    countries?: boolean;
    top15Salesmen?: boolean;
    top15Overall?: boolean;
    overview?: boolean;
    generalCombined?: boolean;
  };
  stockLists?: string[];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SendOutRequest;
    
    const {
      scrapeFirst = false,
      salespersonIds = [],
      emails = [],
      include = {},
      stockLists = [],
    } = body;

    // Validate: at least one recipient
    if (salespersonIds.length === 0 && emails.length === 0) {
      return NextResponse.json(
        { error: 'At least one salesperson or email is required' },
        { status: 400 }
      );
    }
    // Enforce: recipient groups are mutually exclusive (attachments differ)
    if (salespersonIds.length > 0 && emails.length > 0) {
      return NextResponse.json(
        { error: 'Choose either salespersons OR email list recipients (not both)' },
        { status: 400 }
      );
    }

    // Validate: at least one thing to send
    const hasStatistics =
      include.countries ||
      include.top15Salesmen ||
      include.top15Overall ||
      include.overview ||
      include.generalCombined ||
      salespersonIds.length > 0; // salespersons get personal PDF
    const hasStockLists = stockLists.length > 0;

    if (!hasStatistics && !hasStockLists) {
      return NextResponse.json(
        { error: 'At least one statistics PDF or stock list must be selected' },
        { status: 400 }
      );
    }

    // Use service role to bypass RLS
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const serviceKey = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVER_ROLE_KEY ||
      ''
    ).trim();

    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Supabase env missing' }, { status: 500 });
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // If another send-out pipeline is currently running, we still allow queueing
    // (the DB lease_next_job function ensures these run serially).
    const { data: runningSendout } = await supabase
      .from('jobs')
      .select('id, status, started_at, lease_until, created_at')
      .eq('type', 'run_manual_sendout_pipeline')
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Normalize and dedupe extra emails
    const normalizedEmails = emails
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && e.includes('@'));
    const uniqueEmails = [...new Set(normalizedEmails)];

    // Validate salesperson IDs exist (optional, but helps catch typos)
    let validSalespersonIds = salespersonIds;
    if (salespersonIds.length > 0) {
      const { data: spRows } = await supabase
        .from('salespersons')
        .select('id')
        .in('id', salespersonIds);
      validSalespersonIds = ((spRows ?? []) as { id: string }[]).map((r) => r.id);
    }

    // Validate stock list names exist
    let validStockLists = stockLists;
    if (stockLists.length > 0) {
      const { data: listRows } = await supabase
        .from('stock_lists')
        .select('name')
        .in('name', stockLists);
      validStockLists = ((listRows ?? []) as { name: string }[]).map((r) => r.name);
    }

    // Enqueue the pipeline job
    const { data: job, error: insertErr } = await supabase
      .from('jobs')
      .insert({
        type: 'run_manual_sendout_pipeline',
        payload: {
          scrapeFirst,
          salespersonIds: validSalespersonIds,
          emails: uniqueEmails,
          include: {
            countries: include.countries ?? false,
            top15Salesmen: include.top15Salesmen ?? false,
            top15Overall: include.top15Overall ?? false,
            overview: include.overview ?? false,
            generalCombined: include.generalCombined ?? false,
          },
          stockLists: validStockLists,
          requestedBy: 'manual_sendout',
        },
        status: 'queued',
        max_attempts: scrapeFirst ? 180 : 3, // High retry for scrape+wait pattern
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
      msg: 'Manual send out pipeline enqueued',
      data: {
        scrapeFirst,
        salespersonCount: validSalespersonIds.length,
        extraEmailCount: uniqueEmails.length,
        stockListCount: validStockLists.length,
        include,
      },
    });

    return NextResponse.json({
      success: true,
      jobId,
      scrapeFirst,
      salespersonCount: validSalespersonIds.length,
      extraEmailCount: uniqueEmails.length,
      stockListCount: validStockLists.length,
      queuedBehindRunningSendout: Boolean(runningSendout?.id),
      runningSendoutJobId: (runningSendout as any)?.id ?? null,
    });
  } catch (err: any) {
    console.error('[send-out] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to enqueue send out' },
      { status: 500 }
    );
  }
}
