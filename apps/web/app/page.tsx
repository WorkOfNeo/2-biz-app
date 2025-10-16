'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { supabase } from '../lib/supabaseClient';

type SeasonTotals = { qty: number; price: number };
type PersonRow = { salesperson: string; qty: number; price: number; customersLeft: number };

export default function HomePage() {
  const { data: seasonCompare } = useSWR('app-settings:season-compare', async () => {
    const { data } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    return (data?.value as any) ?? { s1: null, s2: null };
  });
  const s1 = seasonCompare?.s1 as string | null;
  const s2 = seasonCompare?.s2 as string | null;

  const { data: totals } = useSWR(s1 && s2 ? ['home:totals', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('season_id, qty, price');
    if (error) throw new Error(error.message);
    const k1 = s1 as string; const k2 = s2 as string;
    const out: { [key: string]: SeasonTotals } = { [k1]: { qty: 0, price: 0 }, [k2]: { qty: 0, price: 0 } };
    for (const r of (data ?? []) as any[]) {
      if (r.season_id === k1) { const t = out[k1]!; t.qty += Number(r.qty||0); t.price += Number(r.price||0); }
      if (r.season_id === k2) { const t = out[k2]!; t.qty += Number(r.qty||0); t.price += Number(r.price||0); }
    }
    return out;
  });

  const { data: tops } = useSWR(s1 && s2 ? ['home:tops', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('salesperson_name, salesperson_id, qty, price, season_id, account_no')
      .in('season_id', [s1, s2]);
    if (error) throw new Error(error.message);
    const map = new Map<string, PersonRow>();
    const seenAccountsBySp = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const key = r.salesperson_name || '—';
      const row = map.get(key) || { salesperson: key, qty: 0, price: 0, customersLeft: 0 };
      row.qty += Number(r.qty || 0);
      row.price += Number(r.price || 0);
      // customers left: count unique accounts (placeholder: treated as total; subtract visited if you have that flag)
      const s = seenAccountsBySp.get(key) || new Set<string>();
      if (r.account_no) s.add(r.account_no);
      seenAccountsBySp.set(key, s);
      row.customersLeft = s.size; // adjust when we have visited/null flags joined here
      map.set(key, row);
    }
    return Array.from(map.values()).sort((a,b)=> b.price - a.price).slice(0, 20);
  });

  const { data: recent } = useSWR('home:runs', async () => {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, status, created_at, started_at, finished_at, error')
      .eq('type', 'scrape_statistics')
      .order('created_at', { ascending: false })
      .limit(5);
    return jobs ?? [];
  }, { refreshInterval: 10000 });

  const s1Tot: SeasonTotals = s1 && totals ? (totals[s1] ?? { qty: 0, price: 0 }) : { qty: 0, price: 0 };
  const s2Tot: SeasonTotals = s2 && totals ? (totals[s2] ?? { qty: 0, price: 0 }) : { qty: 0, price: 0 };
  const diff = { qty: (s1Tot.qty - s2Tot.qty), price: (s1Tot.price - s2Tot.price) };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-md border bg-white p-4">
          <div className="text-xs text-gray-500">Season 1 total</div>
          <div className="mt-1 text-xl font-semibold">Qty: {s1Tot.qty}</div>
          <div className="text-xl font-semibold">Price: {s1Tot.price.toLocaleString()} DKK</div>
        </div>
        <div className="rounded-md border bg-white p-4">
          <div className="text-xs text-gray-500">Season 2 total</div>
          <div className="mt-1 text-xl font-semibold">Qty: {s2Tot.qty}</div>
          <div className="text-xl font-semibold">Price: {s2Tot.price.toLocaleString()} DKK</div>
        </div>
        <div className="rounded-md border bg-white p-4">
          <div className="text-xs text-gray-500">Difference</div>
          <div className={"mt-1 text-xl font-semibold " + (diff.qty>=0?'text-green-700':'text-red-700')}>Qty: {diff.qty}</div>
          <div className={"text-xl font-semibold " + (diff.price>=0?'text-green-700':'text-red-700')}>Price: {diff.price.toLocaleString()} DKK</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-md border bg-white">
          <div className="p-3 text-sm font-medium">Topsellers</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2 border-b">Salesperson</th>
                  <th className="text-right p-2 border-b">Qty</th>
                  <th className="text-right p-2 border-b">Price</th>
                  <th className="text-right p-2 border-b">Customers Left</th>
                </tr>
              </thead>
              <tbody>
                {(tops ?? []).map((r: PersonRow) => (
                  <tr key={r.salesperson}>
                    <td className="p-2 border-b">{r.salesperson}</td>
                    <td className="p-2 border-b text-right">{r.qty}</td>
                    <td className="p-2 border-b text-right">{r.price.toLocaleString()} DKK</td>
                    <td className="p-2 border-b text-right">{r.customersLeft}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-md border bg-white">
          <div className="p-3 text-sm font-medium">Recent runs</div>
          <div className="divide-y">
            {(recent ?? []).map((j: any) => (
              <div key={j.id} className="flex items-center justify-between p-3 text-sm">
                <Link className="underline" href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link>
                <div className="text-gray-600">{j.status}</div>
                <div className="text-gray-500">{j.started_at ? new Date(j.started_at).toLocaleString() : new Date(j.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

