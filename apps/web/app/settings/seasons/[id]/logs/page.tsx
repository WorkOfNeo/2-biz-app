'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../../lib/supabaseClient';

export default function SeasonLogsPage() {
  const params = useParams<{ id: string }>();
  const seasonId = params.id;

  const { data, error, isLoading } = useSWR(seasonId ? ['season-stats', seasonId] : null, async () => {
    // sales stats for this season
    const { data: stats, error: stErr } = await supabase
      .from('sales_stats')
      .select('account_no, customer_name, city, qty, price, currency, salesperson_id, salesperson_name')
      .eq('season_id', seasonId)
      .order('salesperson_name', { ascending: true })
      .limit(100000);
    if (stErr) throw new Error(stErr.message);

    // customers flags
    const { data: customers } = await supabase
      .from('customers')
      .select('customer_id, city, nulled, permanently_closed, excluded');
    const flags = new Map<string, { nulled: boolean }>();
    for (const c of (customers ?? []) as any[]) {
      flags.set(c.customer_id as string, { nulled: Boolean(c.nulled || c.permanently_closed) });
    }

    // seasonal overrides for nulled (if any)
    const { data: overrides } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', `season_overrides:${seasonId}`)
      .maybeSingle();
    const nulledSet = new Set<string>(Array.isArray((overrides?.value as any)?.nulled) ? (overrides!.value as any).nulled : []);

    // group by salesperson
    const groups = new Map<string, any[]>();
    for (const r of (stats ?? []) as any[]) {
      const key = (r.salesperson_name || '—') as string;
      const list = groups.get(key) ?? [];
      const account = r.account_no as string;
      const isNulled = nulledSet.has(account) || Boolean(flags.get(account)?.nulled);
      list.push({
        account,
        customer: r.customer_name ?? '-',
        city: r.city ?? (flags.get(account) ? '' : '-'),
        qty: Number(r.qty ?? 0),
        price: Number(r.price ?? 0),
        currency: r.currency ?? 'DKK',
        nulled: isNulled
      });
      groups.set(key, list);
    }
    return { groups } as { groups: Map<string, any[]> };
  }, { refreshInterval: 15000 });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season data</h2>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}

      <div className="space-y-2">
        {Array.from((data?.groups ?? new Map()).entries()).map(([salesperson, rows]) => (
          <details key={salesperson} className="border rounded">
            <summary className="cursor-pointer select-none px-3 py-2 font-medium">{salesperson} <span className="ml-2 text-[11px] text-gray-500">{rows.length} rows</span></summary>
            <div className="overflow-auto px-2 pb-2">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">Customer</th>
                    <th className="text-left p-2 border-b">City</th>
                    <th className="text-right p-2 border-b">Qty</th>
                    <th className="text-right p-2 border-b">Amount</th>
                    <th className="text-left p-2 border-b">Nulled?</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any, i: number) => (
                    <tr key={i} className={r.nulled ? 'opacity-70' : ''}>
                      <td className="p-2 border-b">{r.customer}</td>
                      <td className="p-2 border-b">{r.city || '-'}</td>
                      <td className="p-2 border-b text-right">{r.qty}</td>
                      <td className="p-2 border-b text-right">{r.price.toLocaleString()} {r.currency}</td>
                      <td className="p-2 border-b">{r.nulled ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}


