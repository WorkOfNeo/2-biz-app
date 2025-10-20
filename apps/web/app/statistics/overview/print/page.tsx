'use client';
import { Suspense, useMemo } from 'react';
import useSWR from 'swr';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';

type Person = { id: string; name: string; currency?: string | null };
type StatsRow = { account_no: string | null; qty: number; price: number; season_id: string; salesperson_id: string | null };
type Customer = { customer_id: string; country: string | null; salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null };

export default function OverviewPrintPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-600">Loading…</div>}>
      <OverviewPrintInner />
    </Suspense>
  );
}

function OverviewPrintInner() {
  const search = useSearchParams();
  const country = (search.get('country') || 'All') as string;
  const s1 = search.get('s1') || '';
  const s2 = search.get('s2') || '';

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

  const { data: people } = useSWR('overview:salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Person[];
  });
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const rates = useMemo(() => ({ DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>), [currencyRatesRow]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((people ?? []) as Person[]).map(p => [p.id, p.currency ?? 'DKK'])), [people]);

  const { data: customers } = useSWR('overview:customers', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, country, salesperson_id, nulled, excluded, permanently_closed');
    if (error) throw new Error(error.message);
    return (data ?? []) as Customer[];
  });
  const { data: stats } = useSWR(s1 && s2 ? ['overview:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('account_no, qty, price, season_id, salesperson_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  });

  const rows = useMemo(() => {
    if (!people || !customers || !stats) return [] as any[];
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    const bySpCustomers = new Map<string, Customer[]>();
    for (const c of customers) {
      if (!c.salesperson_id) continue;
      if (targetCountry && String(c.country ?? '').toUpperCase() !== targetCountry) continue;
      const arr = bySpCustomers.get(c.salesperson_id) || [];
      arr.push(c);
      bySpCustomers.set(c.salesperson_id, arr);
    }
    const targetsBySp = new Map<string, Set<string>>();
    for (const [spId, arr] of bySpCustomers.entries()) {
      const set = new Set<string>();
      for (const c of arr) if (c.customer_id) set.add(c.customer_id);
      targetsBySp.set(spId, set);
    }
    const agg = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number }>();
    for (const sp of people) agg.set(sp.id, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 });
    for (const r of stats) {
      const spId = r.salesperson_id ?? '';
      const set = targetsBySp.get(spId);
      if (!set) continue;
      const acc = r.account_no ?? '';
      if (!acc || !set.has(acc)) continue;
      const row = agg.get(spId)!;
      const currency = spCurrencyById[spId] ?? 'DKK';
      const rate = rates[currency] ?? 1;
      const priceDkk = Number(r.price || 0) * rate;
      if (r.season_id === s1) { row.s1Qty += Number(r.qty||0); row.s1Price += priceDkk; }
      else if (r.season_id === s2) { row.s2Qty += Number(r.qty||0); row.s2Price += priceDkk; }
    }
    const out = [] as any[];
    for (const sp of people) {
      const a = agg.get(sp.id)!;
      const s1Avg = a.s1Qty > 0 ? a.s1Price / a.s1Qty : 0;
      const s2Avg = a.s2Qty > 0 ? a.s2Price / a.s2Qty : 0;
      const qtyPct = a.s2Qty === 0 ? 0 : ((a.s1Qty - a.s2Qty) / a.s2Qty) * 100;
      const pricePct = a.s2Price === 0 ? 0 : ((a.s1Price - a.s2Price) / a.s2Price) * 100;
      out.push({ id: sp.id, name: sp.name, s1Qty: a.s1Qty, s1Price: a.s1Price, s1Avg, s2Qty: a.s2Qty, s2Price: a.s2Price, s2Avg, qtyPct, pricePct });
    }
    return out;
  }, [people, customers, stats, country, s1, s2, rates, spCurrencyById]);

  return (
    <div className="p-6">
      <div className="mb-3 text-sm">Overview · {country}</div>
      <div className="rounded-lg border border-blue-100">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-blue-700 text-white">
              <th className="p-2 text-left">Salesman</th>
              <th className="p-2 text-center" colSpan={3}>{getSeasonLabel(s1) || 'Season 1'}</th>
              <th className="p-2 text-center" colSpan={3}>{getSeasonLabel(s2) || 'Season 2'}</th>
              <th className="p-2 text-center" colSpan={2}>Diff vs S2</th>
            </tr>
            <tr className="bg-blue-50">
              <th className="p-2 text-left"></th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price (DKK)</th>
              <th className="p-2 text-center">Avg</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price (DKK)</th>
              <th className="p-2 text-center">Avg</th>
              <th className="p-2 text-center">Qty %</th>
              <th className="p-2 text-center">Price %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.id} className={(idx % 2 === 0 ? 'bg-white' : 'bg-blue-50') + ' border-t border-blue-100'}>
                <td className="p-2">{r.name}</td>
                <td className="p-2 text-center">{r.s1Qty.toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s1Price).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s1Avg).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{r.s2Qty.toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s2Price).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s2Avg).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{(r.qtyPct>=0?'+':'') + r.qtyPct.toFixed(2)}%</td>
                <td className="p-2 text-center">{(r.pricePct>=0?'+':'') + r.pricePct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


