'use client';
import { useMemo } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

type StatsRow = { account_no: string | null; qty: number; price: number; season_id: string; salesperson_id: string | null };

export default function OverviewRecordsPage() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const sp = params.get('sp') || '';
  const mode = (params.get('mode') as 'nulled' | 'not_visited' | 'visited') || 'visited';
  const country = params.get('country') || 'All';

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const s1 = saved?.value?.s1 ?? '';
  const s2 = saved?.value?.s2 ?? '';

  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; year: number | null }[];
  });
  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  const { data: customers } = useSWR('overview:customers', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, country, salesperson_id, nulled, excluded, permanently_closed');
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  });

  const { data: stats } = useSWR(s1 && s2 ? ['overview:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('account_no, qty, price, season_id, salesperson_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  }, { refreshInterval: 20000 });

  const data = useMemo(() => {
    if (!customers || !stats) return [] as any[];
    const arr = (customers ?? []).filter((c: any) => c.salesperson_id === sp && (country === 'All' ? true : String(c.country ?? '').toUpperCase() === country.toUpperCase()));
    const nulledSet = new Set(arr.filter((c: any) => !!(c.nulled || c.excluded || c.permanently_closed)).map((c: any) => c.customer_id));
    const allSet = new Set(arr.map((c: any) => c.customer_id));
    const visitedSet = new Set((stats ?? []).filter(r => r.salesperson_id === sp && r.season_id === s1 && r.account_no && allSet.has(r.account_no)).map(r => r.account_no as string));
    const validSet = new Set(arr.filter((c: any) => !nulledSet.has(c.customer_id)).map((c: any) => c.customer_id));
    const notVisitedSet = new Set(Array.from(validSet).filter((id: string) => !visitedSet.has(id)));
    let targetIds: Set<string>;
    if (mode === 'nulled') targetIds = nulledSet;
    else if (mode === 'not_visited') targetIds = notVisitedSet;
    else targetIds = visitedSet;

    const byCustomer = new Map<string, { id: string; name: string; city: string; s1: StatsRow[]; s2: StatsRow[] }>();
    for (const id of targetIds) {
      const c = arr.find((x: any) => x.customer_id === id);
      byCustomer.set(id, { id, name: c?.company || id, city: c?.city || '-', s1: [], s2: [] });
    }
    for (const r of (stats ?? [])) {
      if (r.salesperson_id !== sp) continue;
      const acc = r.account_no as string | null;
      if (!acc || !byCustomer.has(acc)) continue;
      if (r.season_id === s1) byCustomer.get(acc)!.s1.push(r);
      if (r.season_id === s2) byCustomer.get(acc)!.s2.push(r);
    }
    return Array.from(byCustomer.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, stats, sp, country, mode, s1, s2]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-700">Overview · Records</h1>
        <div className="text-sm text-gray-600">Salesperson: {sp} · Filter: {mode} · Country: {country}</div>
      </div>
      <div className="overflow-auto rounded-lg border bg-white">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="bg-gray-50">
              <th className="p-2 text-left font-semibold">Customer</th>
              <th className="p-2 text-left font-semibold">City</th>
              <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s1) || 'Season 1'}</th>
              <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s2) || 'Season 2'}</th>
            </tr>
            <tr className="bg-gray-50">
              <th className="p-2 text-left"></th>
              <th className="p-2 text-left"></th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price (DKK)</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price (DKK)</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c: any) => {
              const s1sum = c.s1.reduce((a: any, r: any) => ({ qty: a.qty + Number(r.qty||0), price: a.price + Number(r.price||0) }), { qty: 0, price: 0 });
              const s2sum = c.s2.reduce((a: any, r: any) => ({ qty: a.qty + Number(r.qty||0), price: a.price + Number(r.price||0) }), { qty: 0, price: 0 });
              return (
                <tr key={c.id} className="border-t">
                  <td className="p-2">{c.name}</td>
                  <td className="p-2">{c.city}</td>
                  <td className="p-2 text-center">{s1sum.qty}</td>
                  <td className="p-2 text-center">{Math.round(s1sum.price).toLocaleString('da-DK')}</td>
                  <td className="p-2 text-center">{s2sum.qty}</td>
                  <td className="p-2 text-center">{Math.round(s2sum.price).toLocaleString('da-DK')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


