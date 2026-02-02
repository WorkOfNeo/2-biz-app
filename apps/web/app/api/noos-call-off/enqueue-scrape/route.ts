export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  
  if (!url || !serviceKey) {
    return new Response(
      JSON.stringify({ error: 'Supabase env missing' }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  const supabase = createClient(url, serviceKey, { 
    auth: { persistSession: false, autoRefreshToken: false } 
  });
  
  const body = await req.json();
  const { styleColorPairs } = body as { styleColorPairs: Array<{ style_no: string; color: string }> };
  
  if (!Array.isArray(styleColorPairs) || styleColorPairs.length === 0) {
    return new Response(
      JSON.stringify({ error: 'styleColorPairs array is required' }), 
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // Enqueue the scrape job
  const insertBody = {
    type: 'scrape_noos_call_off_stock',
    payload: { 
      styleColorPairs,
      requestedBy: 'noos_call_off_ui'
    },
    status: 'queued' as const,
    max_attempts: 3,
    queue: 'stock',
    priority: 150,
  };
  
  const { data: job, error } = await supabase
    .from('jobs')
    .insert(insertBody)
    .select('id')
    .single();
  
  if (error) {
    return new Response(
      JSON.stringify({ error: 'job insert failed', detail: error.message }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  const jobId = (job as any)?.id as string;
  
  await supabase
    .from('job_logs')
    .insert({ 
      job_id: jobId, 
      level: 'info', 
      msg: 'Enqueued via NOOS Call Off UI', 
      data: { kind: 'scrape_noos_call_off_stock', pairs: styleColorPairs.length } 
    });
  
  return new Response(
    JSON.stringify({ jobId, pairsCount: styleColorPairs.length }), 
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Enqueue NOOS Call Off scrape error' }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
