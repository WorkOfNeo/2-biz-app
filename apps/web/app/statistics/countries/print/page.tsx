'use client';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { useMemo } from 'react';

export default function CountriesPrintPage() {
  const { data: seasons } = useSWR('seasons', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const s1 = saved?.value?.s1 ?? '';
  const s2 = saved?.value?.s2 ?? '';
  const { data: stats } = useSWR(s1 && s2 ? ['countries:stats:print', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('season_id, qty, price, currency, account_no, customer_id, customers(country)')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return data as any[];
  });
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const countries = useMemo(() => ['Denmark', 'Norway', 'Sweden', 'Finland'], []);
  const rates = useMemo(() => ({ DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>), [currencyRatesRow]);
  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }
  const byCountry = useMemo(() => {
    const out: Record<string, { s1Qty: number; s2Qty: number; s1Price: number; s2Price: number }> = {};
    for (const c of countries) out[c] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
    for (const r of (stats ?? []) as any[]) {
      const ctry = String(r.customers?.country || '').trim();
      if (!countries.includes(ctry)) continue;
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 });
      const rate = rates[(String(r.currency || 'DKK').toUpperCase())] ?? 1;
      const priceDkk = Number(r.price || 0) * rate;
      if (r.season_id === s1) { bucket.s1Qty += Number(r.qty||0); bucket.s1Price += priceDkk; }
      else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2Price += priceDkk; }
    }
    return out;
  }, [stats, s1, s2, rates, countries]);

  return (
    <div className="p-6 space-y-6">
      {countries.map((c) => {
        const row = byCountry[c] || { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
        return (
          <div key={c} className="rounded-lg border bg-white">
            <div className="border-b text-center bg-[#0f172a] text-white rounded-t-lg text-[2rem] leading-tight py-2">{c}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 text-center">
              <div className="space-y-3">
                <div className="font-medium">Antal stk</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{row.s1Qty.toLocaleString('da-DK')} vs {row.s2Qty.toLocaleString('da-DK')}</div>
              </div>
              <div className="space-y-3">
                <div className="font-medium">Omsætning (DKK)</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{Math.round(row.s1Price).toLocaleString('da-DK')} vs {Math.round(row.s2Price).toLocaleString('da-DK')}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


