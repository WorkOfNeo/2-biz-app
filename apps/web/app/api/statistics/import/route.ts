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
    // Build lookup maps for customers and salespersons
    const { data: customers } = await supabase.from('customers').select('customer_id, company, city, salesperson_id').limit(100000);
    const byNameCity = new Map<string, string>(); // "name||city" -> account_no
    const spByAccount = new Map<string, string | null>(); // account_no -> salesperson_id
    for (const c of (customers ?? []) as any[]) {
      if (c.customer_id) spByAccount.set(c.customer_id, c.salesperson_id ?? null);
      const key = `${(c.company || '').trim().toLowerCase()}||${(c.city || '').trim().toLowerCase()}`;
      if (!byNameCity.has(key) && c.customer_id) byNameCity.set(key, c.customer_id);
    }
    const { data: salespersons } = await supabase.from('salespersons').select('id, currency').limit(100000);
    const currencyBySp = new Map<string, string>();
    for (const sp of (salespersons ?? []) as any[]) {
      if (sp.id) currencyBySp.set(sp.id as string, (sp.currency as string | null) || 'DKK');
    }
    // Normalize and insert; also collect season-nulled accounts (by account_no)
    let inserted = 0;
    const batch: Array<any> = [];
    const nulledAccounts = new Set<string>();
    const permAccounts = new Set<string>();
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
      const spId = account_no ? (spByAccount.get(account_no) ?? null) : null;
      const currency = spId ? (currencyBySp.get(spId) || 'DKK') : 'DKK';
      const nulled = Boolean(r.nulled) || String(r.nulled || '').toLowerCase() === 'yes';
      const perm = Boolean(r.perm) || String(r.nulled || '').toLowerCase() === 'perm' || String(r.perm || '').toLowerCase() === 'perm';
      if (nulled && account_no) nulledAccounts.add(account_no);
      if (perm && account_no) permAccounts.add(account_no);
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
        salesperson_id: spId,
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
    // Apply permanent closures across customers
    if (permAccounts.size > 0) {
      // Update customers table: permanently_closed=true, nulled=true
      // Batch in chunks
      const ids = Array.from(permAccounts);
      const chunkSize = 500;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        await supabase.from('customers').update({ permanently_closed: true, nulled: true }).in('customer_id', chunk);
      }
    }
    return new Response(JSON.stringify({ inserted, nulled: nulledAccounts.size, perm: permAccounts.size }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Import error' }), { status: 500 });
  }
}

export async function POST(req: Request) { return handle(req); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


