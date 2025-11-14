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
    // Normalize, aggregate per account_no, and upsert; also collect season-nulled/permanent accounts
    let inserted = 0;
    const agg = new Map<string, any>();
    const nulledAccounts = new Set<string>();
    const permAccounts = new Set<string>();
    // Stats for detailed overview
    const stats: any = {
      totalRows: rows.length,
      resolvedAccounts: 0,
      resolvedByNameCity: 0,
      unresolved: 0,
      skippedZeroValues: 0,
      aggregatedAccounts: 0,
      upserted: 0,
      seasonalNulled: 0,
      permClosed: 0,
      unmatchedSamples: [] as Array<{ customer_name?: string; city?: string }>,
    };
    for (const r of rows) {
      let account_no = (r.account_no || '').toString().trim();
      const customer_name = (r.customer_name || '').toString().trim();
      const city = (r.city || '').toString().trim();
      if (!account_no && lookup === 'name_city') {
        const key = `${customer_name.toLowerCase()}||${city.toLowerCase()}`;
        account_no = byNameCity.get(key) || '';
        if (account_no) stats.resolvedByNameCity++;
      }
      if (!account_no) { stats.unresolved++; if (stats.unmatchedSamples.length < 25) stats.unmatchedSamples.push({ customer_name, city }); continue; } // cannot insert without account number due to NOT NULL + unique
      stats.resolvedAccounts++;
      const qty = Number(r.qty || 0) || 0;
      const price = Number(r.price || 0) || 0;
      const spId = account_no ? (spByAccount.get(account_no) ?? null) : null;
      const currency = spId ? (currencyBySp.get(spId) || 'DKK') : 'DKK';
      const nulledBool = typeof r.nulled === 'boolean' ? (r.nulled as boolean) : undefined;
      const permBool = typeof r.perm === 'boolean' ? (r.perm as boolean) : undefined;
      const rawNull = String((r.nulled ?? '') as any).toLowerCase();
      const rawPerm = String((r.perm ?? '') as any).toLowerCase();
      const isYes = rawNull === 'yes' || nulledBool === true;
      const perm = permBool === true || rawPerm === 'perm' || rawNull === 'perm' || rawNull === 'permanent' || rawNull === 'permanently';
      const nulled = isYes || perm; // ignore all other string values; 'no' -> not nulled
      if (nulled && account_no) nulledAccounts.add(account_no);
      if (perm && account_no) permAccounts.add(account_no);
      if (!qty && !price) { stats.skippedZeroValues++; continue; } // Skip empty contributions
      const existing = agg.get(account_no) as any | undefined;
      if (existing) {
        existing.qty = (Number(existing.qty||0) + qty);
        existing.price = (Number(existing.price||0) + price);
        if (!existing.customer_name && customer_name) existing.customer_name = customer_name;
        if (!existing.city && city) existing.city = city;
        if (!existing.salesperson_id && spId) existing.salesperson_id = spId;
        existing.currency = existing.currency || currency;
      } else {
        agg.set(account_no, {
          account_no,
          customer_name: customer_name || null,
          city: city || null,
          qty,
          price,
          currency,
          season_id: seasonId,
          salesperson_id: spId,
          frozen: false
        });
      }
    }
    // Upsert aggregated rows to avoid unique violations and overwrite prior imports for the season
    const aggregated = Array.from(agg.values());
    stats.aggregatedAccounts = aggregated.length;
    const chunkSize = 500;
    for (let i = 0; i < aggregated.length; i += chunkSize) {
      const part = aggregated.slice(i, i + chunkSize);
      const { error } = await supabase.from('sales_stats').upsert(part as any, { onConflict: 'season_id,account_no' as any });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      inserted += part.length;
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
      stats.seasonalNulled = nulledAccounts.size;
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
      stats.permClosed = permAccounts.size;
    }
    stats.upserted = inserted;
    return new Response(JSON.stringify({
      ok: true,
      ...stats
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Import error' }), { status: 500 });
  }
}

export async function POST(req: Request) { return handle(req); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }


