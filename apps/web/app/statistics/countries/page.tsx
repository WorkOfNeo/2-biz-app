'use client';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { useMemo, useRef, useEffect, useState } from 'react';

type Row = { season_id: string; qty: number; price: number; customer_id?: string | null; account_no?: string | null };

function Donut({ pct, label }: { pct: number; label: string }) {
  const displayPct = Math.round(pct); // number can exceed 100
  const size = 336; // 600% larger than 56px
  
  // If at or above 100%, show full green circle; otherwise show partial progress
  let bg: string;
  let reachColor: string;
  
  if (pct >= 100) {
    // Full green circle
    bg = '#22c55e'; // green-500
    reachColor = '#15803d'; // green-700
  } else {
    // Partial fill with light blue
    const visualPct = Math.max(0, Math.min(100, Math.round(pct)));
    bg = `conic-gradient(#93c5fd ${visualPct}%, #e5e7eb 0)`;
    const hue = Math.round((visualPct / 100) * 120); // 0 (red) -> 120 (green)
    reachColor = `hsl(${hue}, 70%, 40%)`;
  }
  
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
    const { data, error } = await supabase.from('seasons').select('id, name, year, is_current').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  useEffect(() => {
    if (saved?.value) {
      if (saved.value.s1) setS1(saved.value.s1);
      if (saved.value.s2) setS2(saved.value.s2);
    }
    if ((!saved?.value?.s1 || !saved?.value?.s2) && (seasons ?? []).length) {
      const list = (seasons ?? []) as any[];
      const current = list.find((x) => x.is_current);
      const first = list[0];
      const second = list[1] || list.find((x) => x.id !== (current?.id || first?.id));
      if (!saved?.value?.s1) setS1((current?.id || first?.id) ?? '');
      if (!saved?.value?.s2) setS2((second?.id) ?? '');
    }
  }, [saved?.id, seasons?.length]);
  const { data: stats } = useSWR(s1 && s2 ? ['countries:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('season_id, qty, price, currency, account_no, customer_id, salesperson_id, customers(country)')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return data as any[];
  });
  // Seasonal overrides (use Season 1 for null/hidden filtering, consistent with @general/)
  const overridesKey = s1 ? `season_overrides:${s1}` : null;
  const { data: overrides } = useSWR(overridesKey, async () => {
    if (!overridesKey) return { nulled: [] as string[], hidden: [] as string[] };
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', overridesKey).maybeSingle();
    if (error) throw new Error(error.message);
    const val = (data?.value as any) || {};
    return {
      nulled: Array.isArray(val.nulled) ? (val.nulled as string[]) : [],
      hidden: Array.isArray(val.hidden) ? (val.hidden as string[]) : []
    };
  }, { refreshInterval: 0 });
  // Closed/excluded customers
  const { data: closedCustomers } = useSWR('countries:customers-closed', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, permanently_closed, excluded, nulled');
    if (error) throw new Error(error.message);
    const setClosed = new Set<string>();
    const setExcluded = new Set<string>();
    const setNulled = new Set<string>();
    for (const c of (data ?? []) as any[]) {
      if (c.permanently_closed) setClosed.add(c.customer_id);
      if (c.excluded) setExcluded.add(c.customer_id);
      if (c.nulled) setNulled.add(c.customer_id);
    }
    return { setClosed, setExcluded, setNulled };
  }, { refreshInterval: 0 });
  // Minimal customers map to resolve country for invoices
  const { data: customers } = useSWR('countries:customers', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, country, salesperson_id');
    if (error) throw new Error(error.message);
    return (data ?? []) as { customer_id: string; country: string | null; salesperson_id: string | null }[];
  });
  const { data: salespersons } = useSWR('countries:salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name');
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string }[];
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
  // Season-specific currency rates
  const { data: ratesS1 } = useSWR(s1 ? `season:${s1}:currency-rates` : null, async () => {
    const key = `currency_rates:${s1}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return ((data?.value as any) || {}) as Record<string, number>;
  });
  const { data: ratesS2 } = useSWR(s2 ? `season:${s2}:currency-rates` : null, async () => {
    const key = `currency_rates:${s2}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return ((data?.value as any) || {}) as Record<string, number>;
  });
  const byCountry = useMemo(() => {
    const out: Record<string, { s1Qty: number; s2Qty: number; s1PriceDkk: number; s2PriceDkk: number }> = {};
    for (const c of countries) out[c] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 };
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const seasonalNulled = new Set(overrides?.nulled ?? []);
    const seasonalHidden = new Set(overrides?.hidden ?? []);
    // Build customer -> country map once and use it as a fallback for stats rows too
    const customerCountryById = new Map<string, string | null>();
    for (const c of (customers ?? [])) { customerCountryById.set(c.customer_id, c.country ?? null); }
    for (const r of (stats ?? []) as any[]) {
      const acc = String(r.account_no || '');
      const ctry = String((r.customers?.country ?? customerCountryById.get(acc) ?? '')).trim();
      if (!countries.includes(ctry)) continue;
      if (acc) {
        // Exclude hidden/excluded entirely from UI
        if (seasonalHidden.has(acc)) continue;
        if (closedCustomers?.setExcluded.has(acc)) continue;
      }
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const cur = (String(r.currency || 'DKK').toUpperCase());
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const price = Number(r.price || 0);
      // Seasonal nulling (overrides) and permanent closures/nulled only affect Season 1 (current season)
      const isNullS1 = acc ? (seasonalNulled.has(acc) || closedCustomers?.setClosed.has(acc) || closedCustomers?.setNulled.has(acc)) : false;
      if (r.season_id === s1) { if (!isNullS1) { bucket.s1Qty += Number(r.qty||0); bucket.s1PriceDkk += price * rateS1; } }
      else if (r.season_id === s2) { bucket.s2Qty += Number(r.qty||0); bucket.s2PriceDkk += price * rateS2; }
    }
    // Add invoices mapped to country via customers
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      // Apply same filtering for invoices (by account)
      if (seasonalHidden.has(acc)) continue;
      if (closedCustomers?.setExcluded.has(acc)) continue;
      const ctry = String(customerCountryById.get(acc) || '').trim();
      if (!countries.includes(ctry)) continue;
      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const cur = (String(inv.currency || 'DKK').toUpperCase());
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const amount = Number(inv.amount || 0);
      const qty = Number(inv.qty || 0) || 0;
      const isNullS1 = seasonalNulled.has(acc) || closedCustomers?.setClosed.has(acc) || closedCustomers?.setNulled.has(acc);
      if (inv.season_id === s1) { if (!isNullS1) { bucket.s1Qty += qty; bucket.s1PriceDkk += amount * rateS1; } }
      else if (inv.season_id === s2) { bucket.s2Qty += qty; bucket.s2PriceDkk += amount * rateS2; }
    }
    return out;
  }, [stats, invoices, customers, s1, s2, currencyRatesRow, ratesS1, ratesS2, overrides?.nulled?.length, overrides?.hidden?.length, closedCustomers?.setClosed.size, closedCustomers?.setExcluded.size, closedCustomers?.setNulled.size]);
  const byCountrySalespersons = useMemo(() => {
    const out: Record<string, Map<string, { s1Qty: number; s1PriceDkk: number; s2Qty: number; s2PriceDkk: number }>> = {};
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const seasonalNulled = new Set(overrides?.nulled ?? []);
    const seasonalHidden = new Set(overrides?.hidden ?? []);
    const customerCountryById = new Map<string, string | null>();
    const customerSpById = new Map<string, string | null>();
    for (const c of (customers ?? [])) { customerCountryById.set(c.customer_id, c.country ?? null); customerSpById.set(c.customer_id, c.salesperson_id ?? null); }
    for (const r of (stats ?? []) as any[]) {
      const acc = String(r.account_no || '');
      const ctry = String((r.customers?.country ?? customerCountryById.get(acc) ?? '')).trim();
      if (!countries.includes(ctry)) continue;
      if (acc) {
        if (seasonalHidden.has(acc)) continue;
        if (closedCustomers?.setExcluded.has(acc)) continue;
      }
      const spId = ((r.salesperson_id as string | null) ?? (customerSpById.get(acc) ?? null)) || '__unknown__';
      const cur = (String(r.currency || 'DKK').toUpperCase());
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const price = Number(r.price || 0);
      const m = (out[ctry] ||= new Map());
      const row = m.get(spId) || { s1Qty: 0, s1PriceDkk: 0, s2Qty: 0, s2PriceDkk: 0 };
      const isNullS1 = acc ? (seasonalNulled.has(acc) || closedCustomers?.setClosed.has(acc) || closedCustomers?.setNulled.has(acc)) : false;
      if (r.season_id === s1) { if (!isNullS1) { row.s1Qty += Number(r.qty||0); row.s1PriceDkk += price * rateS1; } }
      else if (r.season_id === s2) { row.s2Qty += Number(r.qty||0); row.s2PriceDkk += price * rateS2; }
      m.set(spId, row);
    }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      if (seasonalHidden.has(acc)) continue;
      if (closedCustomers?.setExcluded.has(acc)) continue;
      const ctry = String(customerCountryById.get(acc) || '').trim();
      if (!countries.includes(ctry)) continue;
      const spId = (customerSpById.get(acc) ?? null) || '__unknown__';
      const cur = (String(inv.currency || 'DKK').toUpperCase());
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const amount = Number(inv.amount || 0);
      const qty = Number(inv.qty || 0) || 0;
      const m = (out[ctry] ||= new Map());
      const row = m.get(spId) || { s1Qty: 0, s1PriceDkk: 0, s2Qty: 0, s2PriceDkk: 0 };
      const isNullS1 = seasonalNulled.has(acc) || closedCustomers?.setClosed.has(acc) || closedCustomers?.setNulled.has(acc);
      if (inv.season_id === s1) { if (!isNullS1) { row.s1Qty += qty; row.s1PriceDkk += amount * rateS1; } }
      else if (inv.season_id === s2) { row.s2Qty += qty; row.s2PriceDkk += amount * rateS2; }
      m.set(spId, row);
    }
    return out;
  }, [stats, invoices, customers, s1, s2, currencyRatesRow, ratesS1, ratesS2, overrides?.nulled?.length, overrides?.hidden?.length, closedCustomers?.setClosed.size, closedCustomers?.setExcluded.size, closedCustomers?.setNulled.size]);
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Season 1</label>
          <select
            className="rounded border px-2 py-1 text-sm"
            value={s1}
            onChange={(e) => setS1(e.target.value)}
          >
            <option value="">Select…</option>
            {(seasons ?? []).map((s:any) => (
              <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
            ))}
          </select>
          <label className="text-xs text-gray-600">Season 2</label>
          <select
            className="rounded border px-2 py-1 text-sm"
            value={s2}
            onChange={(e) => setS2(e.target.value)}
          >
            <option value="">Select…</option>
            {(seasons ?? []).map((s:any) => (
              <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
            ))}
          </select>
        </div>
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
        const spMap = byCountrySalespersons[c] || new Map<string, { s1Qty: number; s1PriceDkk: number; s2Qty: number; s2PriceDkk: number }>();
        const spNameById = new Map((salespersons ?? []).map((x) => [x.id, x.name]));
        const spRows = Array.from(spMap.entries()).map(([id, v]) => ({
          id, name: spNameById.get(id) || '—', ...v
        })).sort((a, b) => (b.s1PriceDkk + b.s2PriceDkk) - (a.s1PriceDkk + a.s2PriceDkk));
        const s1Label = getSeasonLabel(s1) || 'Season 1';
        const s2Label = getSeasonLabel(s2) || 'Season 2';
        return (
          <div key={c} className="rounded-lg border bg-white">
            <div className="border-b text-center bg-[#0f172a] text-white rounded-t-lg text-[2rem] leading-tight py-2">{c}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
              <div className="space-y-3 text-center">
                <div className="font-medium">Antal stk</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{row.s1Qty.toLocaleString('da-DK')} vs {row.s2Qty.toLocaleString('da-DK')}</div>
                <Donut pct={qtyPct} label={`Stk`} />
              </div>
              <div className="space-y-3 text-center">
                <div className="font-medium">Omsætning</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{Math.round(s1Local).toLocaleString('da-DK')} {cur} vs {Math.round(s2Local).toLocaleString('da-DK')} {cur}</div>
                <div className="text-sm text-gray-600">{Math.round(row.s1PriceDkk).toLocaleString('da-DK')} DKK vs {Math.round(row.s2PriceDkk).toLocaleString('da-DK')} DKK</div>
                <Donut pct={pricePct} label={`Omsætning`} />
              </div>
            </div>
            {/* Per-salesperson section (split into two, borderless tables, equal heights) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 px-6 pb-6">
              <div className="flex flex-col min-h-[280px]">
                <div className="text-sm font-semibold text-left mb-2">Per sælger - stk</div>
                <div className="flex-1 overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr>
                        <th className="p-2 text-left font-semibold">Name</th>
                        <th className="p-2 text-right font-semibold">{s1Label}</th>
                        <th className="p-2 text-right font-semibold">{s2Label}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spRows.map((r) => (
                        <tr key={r.id}>
                          <td className="p-2 text-left">{r.name}</td>
                          <td className="p-2 text-right">{r.s1Qty.toLocaleString('da-DK')}</td>
                          <td className="p-2 text-right">{r.s2Qty.toLocaleString('da-DK')}</td>
                        </tr>
                      ))}
                      {spRows.length === 0 && (
                        <tr><td className="p-2 text-left text-xs text-gray-500" colSpan={3}>No data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex flex-col min-h-[280px]">
                <div className="text-sm font-semibold text-left mb-2">Per sælger - omsætning (DKK)</div>
                <div className="flex-1 overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr>
                        <th className="p-2 text-left font-semibold">Name</th>
                        <th className="p-2 text-right font-semibold">{s1Label}</th>
                        <th className="p-2 text-right font-semibold">{s2Label}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spRows.map((r) => (
                        <tr key={r.id}>
                          <td className="p-2 text-left">{r.name}</td>
                          <td className="p-2 text-right">{Math.round(r.s1PriceDkk).toLocaleString('da-DK')}</td>
                          <td className="p-2 text-right">{Math.round(r.s2PriceDkk).toLocaleString('da-DK')}</td>
                        </tr>
                      ))}
                      {spRows.length === 0 && (
                        <tr><td className="p-2 text-left text-xs text-gray-500" colSpan={3}>No data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

