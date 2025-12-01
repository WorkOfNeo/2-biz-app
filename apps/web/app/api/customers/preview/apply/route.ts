import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { previewId } = body;
    
    if (!previewId) {
      return NextResponse.json({ error: 'Missing preview ID' }, { status: 400 });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Verify preview exists and hasn't been applied
    const { data: preview } = await supabase
      .from('customer_scrape_previews')
      .select('id, applied_at')
      .eq('id', previewId)
      .single();
    
    if (!preview) {
      return NextResponse.json({ error: 'Preview not found' }, { status: 404 });
    }
    
    if (preview.applied_at) {
      return NextResponse.json({ error: 'Preview already applied' }, { status: 400 });
    }
    
    // Enqueue apply job
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        type: 'apply_customer_preview',
        payload: { previewId }
      })
      .select('id')
      .single();
    
    if (jobError || !job) {
      return NextResponse.json({ error: 'Failed to enqueue job' }, { status: 500 });
    }
    
    return NextResponse.json({ jobId: job.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

