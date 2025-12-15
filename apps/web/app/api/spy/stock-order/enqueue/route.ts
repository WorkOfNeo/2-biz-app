export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StockOrderItem = {
  style_no: string;
  color: string;
  sizes: string[];
  qtyBySize: Record<string, number>;
};

type StockOrderRun = {
  customer_id: string;
  spy_customer_id_override?: string | number;
  items: StockOrderItem[];
};

type EnqueuePayload = {
  season_id?: number;
  runs: StockOrderRun[];
  dryRun?: boolean;
};

export async function POST(req: Request) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    
    if (!url || !anonKey) {
      return new Response(JSON.stringify({ error: 'Supabase configuration missing' }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get auth header to verify signed-in user
    const auth = req.headers.get('authorization') || '';
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: auth } }
    });

    // Verify user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid authentication' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const payload: EnqueuePayload = await req.json();

    // Validate payload
    if (!payload.runs || !Array.isArray(payload.runs) || payload.runs.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or empty runs array' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate each run
    for (let i = 0; i < payload.runs.length; i++) {
      const run = payload.runs[i];
      if (!run) {
        return new Response(JSON.stringify({
          error: `Run ${i}: missing run payload`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (!run.customer_id || typeof run.customer_id !== 'string') {
        return new Response(JSON.stringify({ 
          error: `Run ${i}: customer_id is required and must be a string` 
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!run.items || !Array.isArray(run.items) || run.items.length === 0) {
        return new Response(JSON.stringify({ 
          error: `Run ${i}: items array is required and must not be empty` 
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate each item
      for (let j = 0; j < run.items.length; j++) {
        const item = run.items[j];
        if (!item) {
          return new Response(JSON.stringify({
            error: `Run ${i}, Item ${j}: missing item payload`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (!item.style_no || !item.color || !item.sizes || !item.qtyBySize) {
          return new Response(JSON.stringify({ 
            error: `Run ${i}, Item ${j}: Missing required fields (style_no, color, sizes, qtyBySize)` 
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (!Array.isArray(item.sizes)) {
          return new Response(JSON.stringify({ 
            error: `Run ${i}, Item ${j}: sizes must be an array` 
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (typeof item.qtyBySize !== 'object') {
          return new Response(JSON.stringify({ 
            error: `Run ${i}, Item ${j}: qtyBySize must be an object` 
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    const jobIds: string[] = [];

    // Enqueue one job per run
    for (const run of payload.runs) {
      const jobPayload = {
        season_id: payload.season_id ?? 0,
        customer_id: run.customer_id,
        spy_customer_id_override: run.spy_customer_id_override,
        items: run.items,
        dryRun: payload.dryRun ?? false
      };

      const insertBody = {
        type: 'create_spy_stock_order',
        payload: jobPayload,
        status: 'queued',
        max_attempts: 3,
        queue: 'default',
        priority: 100
      };

      const { data, error } = await supabase
        .from('jobs')
        .insert(insertBody)
        .select('id')
        .single();

      if (error) {
        console.error('Failed to enqueue job for customer', run.customer_id, error);
        return new Response(JSON.stringify({ 
          error: `Failed to enqueue job for customer ${run.customer_id}: ${error.message}` 
        }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      jobIds.push((data as any).id);
    }

    return new Response(JSON.stringify({ 
      success: true,
      jobIds,
      count: jobIds.length
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('Stock order enqueue error:', err);
    return new Response(JSON.stringify({ 
      error: err?.message || 'Failed to enqueue stock orders' 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

