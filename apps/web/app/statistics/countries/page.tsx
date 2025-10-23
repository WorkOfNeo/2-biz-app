'use client';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { useMemo } from 'react';

type Row = { season_id: string; qty: number; price: number; customer_id?: string | null; account_no?: string | null };

function Donut({ pct, label }: { pct: number; label: string }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const size = 336; // 600% larger than 56px
  const progressColor = '#93c5fd'; // light blue
  const restColor = '#e5e7eb'; // light gray
  const bg = `conic-gradient(${progressColor} ${p}%, ${restColor} 0)`;
  const hue = Math.round((p / 100) * 120); // 0 (red) -> 120 (green)
  const reachColor = `hsl(${hue}, 70%, 40%)`;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="rounded-full" style={{ width: size, height: size, background: bg }} />
      <div className="text-sm">
        <div className="font-medium">{label}</div>
        <div style={{ color: reachColor }}>{p}% nået</div>
      </div>
    </div>
  );
}

export default function CountriesPage() {
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
  const { data: stats } = useSWR(s1 && s2 ? ['countries:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('season_id, qty, price, account_no, customer_id, customers(country)')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return data as any[];
  });
  const countries = useMemo(() => ['Denmark', 'Norway', 'Sweden', 'Finland'], []);
  const byCountry = useMemo(() => {
    const out: Record<string, { s1Qty: number; s2Qty: number; s1Price: number; s2Price: number }> = {};
    for (const c of countries) out[c] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
    for (const r of (stats ?? []) as any[]) {
      const ctry = String(r.customers?.country || '').trim();
      if (!countries.includes(ctry)) continue;
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 });
      if (r.season_id === s1) { bucket.s1Qty += Number(r.qty||0); bucket.s1Price += Number(r.price||0); }
      else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2Price += Number(r.price||0); }
    }
    return out;
  }, [stats, s1, s2]);
  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }
  return (
    <div className="space-y-6">
      {(countries).map((c) => {
        const row = byCountry[c] || { s1Qty: 0, s2Qty: 0, s1Price: 0, s2Price: 0 };
        const qtyPct = row.s2Qty === 0 ? 0 : (row.s1Qty / row.s2Qty) * 100;
        const pricePct = row.s2Price === 0 ? 0 : (row.s1Price / row.s2Price) * 100;
        return (
          <div key={c} className="rounded-lg border bg-white">
            <div className="border-b text-center bg-[#0f172a] text-white rounded-t-lg text-[2rem] leading-tight py-2">{c}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 text-center">
              <div className="space-y-3">
                <div className="font-medium">Antal stk</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{row.s1Qty.toLocaleString('da-DK')} vs {row.s2Qty.toLocaleString('da-DK')}</div>
                <Donut pct={qtyPct} label={`Stk`} />
              </div>
              <div className="space-y-3">
                <div className="font-medium">Omsætning</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{Math.round(row.s1Price).toLocaleString('da-DK')} vs {Math.round(row.s2Price).toLocaleString('da-DK')}</div>
                <Donut pct={pricePct} label={`Omsætning`} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

