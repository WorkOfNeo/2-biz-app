export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env' }), { status: 500 });
    }
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const seasonId = String(body?.seasonId || '');
    const lookup = (body?.lookup || 'account') as 'account' | 'name_city';
    const rows = Array.isArray(body?.rows) ? body.rows as Array<any> : [];
    if (!seasonId || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'seasonId and rows are required' }), { status: 400 });
    }
    // Optionally build a lookup map for customers by (name, city)
    let customers: Array<{ customer_id: string; company: string | null; city: string | null }> = [];
    if (lookup === 'name_city') {
      const { data } = await supabase.from('customers').select('customer_id, company, city').limit(100000);
      customers = (data ?? []) as any[];
    }
    const byNameCity = new Map<string, string>(); // "name||city" -> account_no
    if (lookup === 'name_city') {
      for (const c of customers) {
        const key = `${(c.company || '').trim().toLowerCase()}||${(c.city || '').trim().toLowerCase()}`;
        if (!byNameCity.has(key) && c.customer_id) byNameCity.set(key, c.customer_id);
      }
    }
    // Normalize and insert; also collect season-nulled accounts (by account_no)
    let inserted = 0;
    const batch: Array<any> = [];
    const nulledAccounts = new Set<string>();
    for (const r of rows) {
      let account_no = (r.account_no || '').toString().trim();
      const customer_name = (r.customer_name || '').toString().trim();
      const city = (r.city || '').toString().trim();
      if (!account_no && lookup === 'name_city') {
        const key = `${customer_name.toLowerCase()}||${city.toLowerCase()}`;
        account_no = byNameCity.get(key) || '';
      }
      const qty = Number(r.qty || 0) || 0;
      const price = Number(r.price || 0) || 0;
      const currency = (r.currency || 'DKK').toString().trim().toUpperCase() || 'DKK';
      const nulled = Boolean(r.nulled);
      if (nulled && account_no) nulledAccounts.add(account_no);
      // Skip empty rows
      if (!qty && !price) continue;
      batch.push({
        account_no: account_no || null,
        customer_name: customer_name || null,
        city: city || null,
        qty,
        price,
        currency,
        season_id: seasonId,
        salesperson_id: null,
        frozen: false
      });
      if (batch.length >= 500) {
        const { error } = await supabase.from('sales_stats').insert(batch as any);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        inserted += batch.length;
        batch.length = 0;
      }
    }
    if (batch.length) {
      const { error } = await supabase.from('sales_stats').insert(batch as any);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      inserted += batch.length;
    }
    // Update season overrides (nulled) for this season
    if (nulledAccounts.size > 0) {
      const key = `season_overrides:${seasonId}`;
      const { data: exist } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
      const val = (exist?.value as any) || {};
      const existingNulled: string[] = Array.isArray(val.nulled) ? val.nulled : [];
      const hidden: string[] = Array.isArray(val.hidden) ? val.hidden : [];
      const next = { nulled: Array.from(new Set([...existingNulled, ...Array.from(nulledAccounts)])), hidden };
      if (exist?.id) {
        await supabase.from('app_settings').update({ value: next }).eq('id', exist.id as any);
      } else {
        await supabase.from('app_settings').insert({ key, value: next } as any);
      }
    }
    return new Response(JSON.stringify({ inserted, nulled: nulledAccounts.size }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Import error' }), { status: 500 });
  }
}

export async function POST(req: Request) { return handle(req); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


