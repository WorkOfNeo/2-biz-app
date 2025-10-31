'use client';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { useMemo, useRef } from 'react';

type Row = { season_id: string; qty: number; price: number; customer_id?: string | null; account_no?: string | null };

function Donut({ pct, label }: { pct: number; label: string }) {
  const visualPct = Math.max(0, Math.min(100, Math.round(pct))); // fill caps at 100
  const displayPct = Math.round(pct); // number can exceed 100
  const size = 336; // 600% larger than 56px
  const progressColor = '#93c5fd'; // light blue
  const restColor = '#e5e7eb'; // light gray
  const bg = `conic-gradient(${progressColor} ${visualPct}%, ${restColor} 0)`;
  const hue = Math.round((visualPct / 100) * 120); // 0 (red) -> 120 (green)
  const reachColor = `hsl(${hue}, 70%, 40%)`;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="rounded-full" style={{ width: size, height: size, background: bg }} />
      <div className="text-sm">
        <div className="font-medium">{label}</div>
        <div style={{ color: reachColor }}>{displayPct}% nået</div>
      </div>
    </div>
  );
}

export default function CountriesPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
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
      .select('season_id, qty, price, currency, account_no, customer_id, customers(country)')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return data as any[];
  });
  // Minimal customers map to resolve country for invoices
  const { data: customers } = useSWR('countries:customers', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, country');
    if (error) throw new Error(error.message);
    return (data ?? []) as { customer_id: string; country: string | null }[];
  });
  // Fetch invoices
  const { data: invoices } = useSWR(s1 && s2 ? ['countries:invoices', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_invoices')
      .select('account_no, qty, amount, currency, season_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as { account_no: string | null; qty: number | null; amount: number | null; currency: string | null; season_id: string }[];
  });
  // Currency rates (1 unit equals how many DKK), e.g. { EUR: 7.45, NOK: 0.67, SEK: 0.64 }
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const countries = useMemo(() => ['Denmark', 'Norway', 'Sweden', 'Finland'], []);
  const countryCurrency: Record<string, string> = useMemo(() => ({ Denmark: 'DKK', Norway: 'NOK', Sweden: 'SEK', Finland: 'EUR' }), []);
  const byCountry = useMemo(() => {
    const out: Record<string, { s1Qty: number; s2Qty: number; s1PriceDkk: number; s2PriceDkk: number }> = {};
    for (const c of countries) out[c] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 };
    const rates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    for (const r of (stats ?? []) as any[]) {
      const ctry = String(r.customers?.country || '').trim();
      if (!countries.includes(ctry)) continue;
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const rate = rates[(String(r.currency || 'DKK').toUpperCase())] ?? 1;
      const priceDkk = Number(r.price || 0) * rate;
      if (r.season_id === s1) { bucket.s1Qty += Number(r.qty||0); bucket.s1PriceDkk += priceDkk; }
      else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2PriceDkk += priceDkk; }
    }
    // Add invoices mapped to country via customers
    const customerCountryById = new Map<string, string | null>();
    for (const c of (customers ?? [])) { customerCountryById.set(c.customer_id, c.country ?? null); }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      const ctry = String(customerCountryById.get(acc) || '').trim();
      if (!countries.includes(ctry)) continue;
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const rate = rates[(String(inv.currency || 'DKK').toUpperCase())] ?? 1;
      const amountDkk = Number(inv.amount || 0) * rate;
      const qty = Number(inv.qty || 0) || 0;
      if (inv.season_id === s1) { bucket.s1Qty += qty; bucket.s1PriceDkk += amountDkk; }
      else if (inv.season_id === s2) { bucket.s2Qty += qty; bucket.s2PriceDkk += amountDkk; }
    }
    return out;
  }, [stats, invoices, customers, s1, s2, currencyRatesRow]);
  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-slate-700">Countries</h1>
        <a
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
          href="/statistics/countries/print"
          target="_blank"
          rel="noreferrer"
        >Export PDF</a>
      </div>
      <div ref={containerRef} className="space-y-6">
      {(countries).map((c) => {
        const row = byCountry[c] || { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 };
        const qtyPct = row.s2Qty === 0 ? 0 : (row.s1Qty / row.s2Qty) * 100;
        const pricePct = row.s2PriceDkk === 0 ? 0 : (row.s1PriceDkk / row.s2PriceDkk) * 100;
        const cur = countryCurrency[c] || 'DKK';
        const rates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
        const r = rates[cur] ?? 1;
        const s1Local = row.s1PriceDkk / (r || 1);
        const s2Local = row.s2PriceDkk / (r || 1);
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
                <div className="text-lg font-semibold">{Math.round(s1Local).toLocaleString('da-DK')} {cur} vs {Math.round(s2Local).toLocaleString('da-DK')} {cur}</div>
                <div className="text-sm text-gray-600">{Math.round(row.s1PriceDkk).toLocaleString('da-DK')} DKK vs {Math.round(row.s2PriceDkk).toLocaleString('da-DK')} DKK</div>
                <Donut pct={pricePct} label={`Omsætning`} />
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

