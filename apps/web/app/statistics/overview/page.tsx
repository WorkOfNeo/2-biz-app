'use client';
import { useMemo, useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

type Person = { id: string; name: string; currency?: string | null };
type StatsRow = { account_no: string | null; qty: number; price: number; season_id: string; salesperson_id: string | null };
type Customer = { customer_id: string; company?: string | null; city?: string | null; country: string | null; salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null };

const COUNTRIES = ['All', 'Denmark', 'Norway', 'Sweden', 'Finland'] as const;

function Donut({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const bg = `conic-gradient(#0f172a ${p}%, #e5e7eb 0)`; // slate-900, gray-200
  return (
    <div className="inline-flex items-center gap-2">
      <div className="relative" style={{ width: 28, height: 28 }}>
        <div className="rounded-full" style={{ width: 28, height: 28, background: bg }} />
        <div className="absolute inset-1 rounded-full bg-white" />
      </div>
      <span className="text-xs text-gray-700">{p}%</span>
    </div>
  );
}

export default function OverviewPage() {
  const [country, setCountry] = useState<typeof COUNTRIES[number]>('All');

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');

  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, is_current').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; year: number | null }[];
  });
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
  const rates = useMemo(() => ({ DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>), [currencyRatesRow]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((people ?? []) as Person[]).map(p => [p.id, p.currency ?? 'DKK'])), [people]);

  const { data: customers } = useSWR('overview:customers-main', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, country, salesperson_id, nulled, excluded, permanently_closed');
    if (error) throw new Error(error.message);
    return (data ?? []) as Customer[];
  }, { refreshInterval: 10000 });

  const { data: stats } = useSWR(s1 && s2 ? ['overview:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('account_no, qty, price, season_id, salesperson_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  }, { refreshInterval: 20000 });

  // Fetch invoices and combine with stats for aligned totals
  const { data: invoices } = useSWR(s1 && s2 ? ['overview:invoices', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_invoices')
      .select('account_no, qty, amount, currency, season_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as { account_no: string | null; qty: number | null; amount: number | null; currency: string | null; season_id: string }[];
  }, { refreshInterval: 20000 });

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
    // Build quick lookup sets of target accounts (all) and valid accounts (excluding nulled/excluded/closed)
    const targetsBySp = new Map<string, Set<string>>();
    const validTargetsBySp = new Map<string, Set<string>>();
    for (const [spId, arr] of bySpCustomers.entries()) {
      const allSet = new Set<string>();
      const validSet = new Set<string>();
      for (const c of arr) {
        if (c.customer_id) {
          allSet.add(c.customer_id);
          if (!(c.nulled || c.permanently_closed || c.excluded)) validSet.add(c.customer_id);
        }
      }
      targetsBySp.set(spId, allSet);
      validTargetsBySp.set(spId, validSet);
    }
    // Aggregate stats per salesperson, filtered to target accounts
    const agg = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; visited: Set<string>; visitedValid: Set<string> }>();
    for (const sp of people) agg.set(sp.id, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, visited: new Set<string>(), visitedValid: new Set<string>() });
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    for (const r of stats) {
      const spId = r.salesperson_id ?? '';
      const set = targetsBySp.get(spId);
      if (!set) continue; // salesperson may have no customers in this country
      const acc = r.account_no ?? '';
      if (!acc || !set.has(acc)) continue;
      const row = agg.get(spId)!;
      const currency = spCurrencyById[spId] ?? 'DKK';
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const price = Number(r.price || 0);
      if (r.season_id === s1) { row.s1Qty += Number(r.qty||0); row.s1Price += price * rateS1; row.visited.add(acc); if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc); }
      else if (r.season_id === s2) { row.s2Qty += Number(r.qty||0); row.s2Price += price * rateS2; }
    }
    // Aggregate invoices mapped to salesperson via customers
    const customerById = new Map<string, Customer>();
    for (const c of customers) { if (c.customer_id) customerById.set(c.customer_id, c); }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      const c = customerById.get(acc);
      const spId = c?.salesperson_id ?? '';
      if (!spId) continue;
      const set = targetsBySp.get(spId);
      if (!set || !set.has(acc)) continue;
      const row = agg.get(spId)!;
      // Use salesperson's currency for consistency with sales_stats, fall back to invoice currency
      const currency = spCurrencyById[spId] ?? (inv.currency || 'DKK').toUpperCase();
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const amount = Number(inv.amount || 0);
      const qty = Number(inv.qty || 0) || 0;
      if (inv.season_id === s1) { row.s1Qty += qty; row.s1Price += amount * rateS1; }
      else if (inv.season_id === s2) { row.s2Qty += qty; row.s2Price += amount * rateS2; }
    }
    // Build output rows
    const out = [] as any[];
    for (const sp of people) {
      const spCustomers = bySpCustomers.get(sp.id) ?? [];
      const totalCustomers = spCustomers.length;
      const nulledCustomers = spCustomers.filter(c => !!(c.nulled || c.permanently_closed || c.excluded));
      const nulledCount = nulledCustomers.length;
      
      // Debug logging for nulled customers
      if (nulledCount > 0) {
        console.log(`[OVERVIEW] ${sp.name} - Nulled customers (${nulledCount}):`, 
          nulledCustomers.map(c => ({
            id: c.customer_id,
            company: c.company,
            nulled: c.nulled,
            excluded: c.excluded,
            permanently_closed: c.permanently_closed
          }))
        );
      }
      
      const a = agg.get(sp.id)!;
      // Use the exact set size of valid, non-nulled/non-closed/non-excluded accounts to determine denominator
      const validTotal = validTargetsBySp.get(sp.id)?.size ?? Math.max(0, totalCustomers - nulledCount);
      const s1Avg = a.s1Qty > 0 ? a.s1Price / a.s1Qty : 0;
      const s2Avg = a.s2Qty > 0 ? a.s2Price / a.s2Qty : 0;
      const diffQty = a.s1Qty - a.s2Qty;
      const diffPrice = a.s1Price - a.s2Price;
      const diffPct = a.s2Price === 0 ? 0 : ((a.s1Price - a.s2Price) / a.s2Price) * 100;
      const needQty = a.s1Qty >= a.s2Qty ? 0 : (a.s2Qty - a.s1Qty);
      const needPrice = a.s1Price >= a.s2Price ? 0 : (a.s2Price - a.s1Price);
      const needQtyPct = a.s2Qty === 0 ? 0 : Math.max(0, (needQty / a.s2Qty) * 100);
      const needPricePct = a.s2Price === 0 ? 0 : Math.max(0, (needPrice / a.s2Price) * 100);
      const notVisitedCount = Math.max(0, validTotal - a.visitedValid.size);
      
      // Debug logging for not visited
      if (notVisitedCount > 0) {
        const validIds = validTargetsBySp.get(sp.id) || new Set();
        const notVisitedIds = Array.from(validIds).filter(id => !a.visitedValid.has(id));
        const notVisitedCustomers = spCustomers.filter(c => notVisitedIds.includes(c.customer_id));
        console.log(`[OVERVIEW] ${sp.name} - Not visited (${notVisitedCount}):`,
          notVisitedCustomers.map(c => ({
            id: c.customer_id,
            company: c.company,
            nulled: c.nulled,
            excluded: c.excluded,
            permanently_closed: c.permanently_closed
          }))
        );
      }
      
      out.push({
        id: sp.id,
        name: sp.name,
        totalCustomers,
        nulledCount,
        visited: a.visitedValid.size,
        effectiveTotal: validTotal,
        visitedPct: validTotal > 0 ? (a.visitedValid.size / validTotal) * 100 : 0,
        notVisited: notVisitedCount,
        s1Qty: a.s1Qty, s1Price: a.s1Price, s1Avg,
        s2Qty: a.s2Qty, s2Price: a.s2Price, s2Avg,
        diffPct,
        needQty,
        needPrice,
        needQtyPct,
        needPricePct,
        diffQty,
        diffPrice,
      });
    }
    return out;
  }, [people, customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById]);

  // Totals across all salespersons for selected country, converted to DKK
  const totals = useMemo(() => {
    if (!customers || !stats) return { s1Qty: 0, s1PriceDkk: 0, s2Qty: 0, s2PriceDkk: 0 };
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    const targetAccounts = new Set<string>();
    for (const c of (customers ?? []) as Customer[]) {
      if (targetCountry && String(c.country ?? '').toUpperCase() !== targetCountry) continue;
      if (c.customer_id) targetAccounts.add(c.customer_id);
    }
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const out = { s1Qty: 0, s1PriceDkk: 0, s2Qty: 0, s2PriceDkk: 0 };
    for (const r of (stats ?? []) as StatsRow[]) {
      const acc = r.account_no ?? '';
      if (!acc || !targetAccounts.has(acc)) continue;
      const currency = r.salesperson_id ? (spCurrencyById[r.salesperson_id] ?? 'DKK') : 'DKK';
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const qty = Number(r.qty || 0);
      const price = Number(r.price || 0);
      if (r.season_id === s1) { out.s1Qty += qty; out.s1PriceDkk += price * rateS1; }
      else if (r.season_id === s2) { out.s2Qty += qty; out.s2PriceDkk += price * rateS2; }
    }
    // Build customer lookup for invoice currency resolution
    const customerByIdForInv = new Map<string, Customer>();
    for (const c of (customers ?? [])) { if (c.customer_id) customerByIdForInv.set(c.customer_id, c); }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc || !targetAccounts.has(acc)) continue;
      // Use salesperson's currency for consistency with sales_stats, fall back to invoice currency
      const c = customerByIdForInv.get(acc);
      const spId = c?.salesperson_id ?? null;
      const currency = spId ? (spCurrencyById[spId] ?? (String(inv.currency || 'DKK').toUpperCase())) : (String(inv.currency || 'DKK').toUpperCase());
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const qty = Number(inv.qty || 0) || 0;
      const amount = Number(inv.amount || 0);
      if (inv.season_id === s1) { out.s1Qty += qty; out.s1PriceDkk += amount * rateS1; }
      else if (inv.season_id === s2) { out.s2Qty += qty; out.s2PriceDkk += amount * rateS2; }
    }
    return out;
  }, [customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById]);

  // navigation helper
  function buildDetailsHref(spId: string, mode: 'nulled' | 'not_visited' | 'visited') {
    return {
      pathname: '/statistics/overview/records' as const,
      query: { sp: spId, mode, country }
    };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-slate-700">Overview</h1>
        <div className="flex gap-2">
          {COUNTRIES.map((c) => (
            <button
              key={c}
              onClick={() => setCountry(c)}
              className={
                'rounded-md border px-3 py-1.5 text-sm ' + (country === c ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50')
              }
            >{c}</button>
          ))}
          <div className="ml-2 flex items-center gap-2">
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
          {/* Print preview removed */}
          {/* Export PDF removed */}
        </div>
      </div>

      <div className="overflow-auto rounded-lg border bg-white">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2 text-left font-semibold">Salesman</th>
              <th className="p-2 text-left font-semibold">Nulled</th>
              <th className="p-2 text-left font-semibold">Visited / Total</th>
              <th className="p-2 text-left font-semibold">Not visited</th>
              <th className="p-2 text-left font-semibold">Progress</th>
              <th className="p-2 text-center font-semibold" colSpan={3}>{getSeasonLabel(s1) || 'Season 1'}</th>
              <th className="p-2 text-center font-semibold" colSpan={3}>{getSeasonLabel(s2) || 'Season 2'}</th>
              <th className="p-2 text-center font-semibold" colSpan={2}>Need to meet S2</th>
            </tr>
            <tr className="bg-gray-50">
              <th className="p-2 text-left"></th>
              <th className="p-2 text-left"></th>
              <th className="p-2 text-left"></th>
              <th className="p-2 text-left"></th>
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
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-medium">{r.name}</td>
                <td className="p-2"><Link className="underline underline-offset-2" href={buildDetailsHref(r.id, 'nulled')}>{r.nulledCount}</Link></td>
                <td className="p-2"><Link className="underline underline-offset-2" href={buildDetailsHref(r.id, 'visited')}>{r.visited}/{r.effectiveTotal}</Link></td>
                <td className="p-2"><Link className="underline underline-offset-2" href={buildDetailsHref(r.id, 'not_visited')}>{r.notVisited}</Link></td>
                <td className="p-2"><Donut pct={r.visitedPct} /></td>
                <td className="p-2 text-center">{r.s1Qty}</td>
                <td className="p-2 text-center">{Math.round(r.s1Price).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s1Avg).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{r.s2Qty}</td>
                <td className="p-2 text-center">{Math.round(r.s2Price).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">{Math.round(r.s2Avg).toLocaleString('da-DK')}</td>
                {(() => {
                  const qtyPct = r.s2Qty === 0 ? 0 : ((r.s1Qty - r.s2Qty) / r.s2Qty) * 100;
                  const qtyCls = qtyPct > 0 ? 'text-green-700' : qtyPct < 0 ? 'text-red-700' : '';
                  return (
                    <td className="p-2 text-center"><span className={qtyCls}>{(qtyPct>=0?'+':'') + qtyPct.toFixed(2)}%</span></td>
                  );
                })()}
                {(() => {
                  const pricePct = typeof r.diffPct === 'number' ? r.diffPct : (r.s2Price === 0 ? 0 : ((r.s1Price - r.s2Price) / r.s2Price) * 100);
                  const priceCls = pricePct > 0 ? 'text-green-700' : pricePct < 0 ? 'text-red-700' : '';
                  return (
                    <td className="p-2 text-center"><span className={priceCls}>{(pricePct>=0?'+':'') + pricePct.toFixed(2)}%</span></td>
                  );
                })()}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Separate TOTALS section */}
      <div className="rounded-lg border bg-white">
        <div className="p-3 text-sm font-semibold">TOTALS (All salespersons)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left"></th>
                <th className="p-2 text-center" colSpan={2}>{getSeasonLabel(s1) || 'Season 1'}</th>
                <th className="p-2 text-center" colSpan={2}>{getSeasonLabel(s2) || 'Season 2'}</th>
                <th className="p-2 text-center" colSpan={2}>Progress vs last year</th>
              </tr>
              <tr className="bg-gray-50">
                <th className="p-2 text-center"></th>
                <th className="p-2 text-center">Qty</th>
                <th className="p-2 text-center">Price (DKK)</th>
                <th className="p-2 text-center">Qty</th>
                <th className="p-2 text-center">Price (DKK)</th>
                <th className="p-2 text-center">Qty %</th>
                <th className="p-2 text-center">Price %</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const s1Qty = Math.round(totals.s1Qty);
                const s1Price = Math.round(totals.s1PriceDkk);
                const s2Qty = Math.round(totals.s2Qty);
                const s2Price = Math.round(totals.s2PriceDkk);
                const achievedQtyPct = s2Qty === 0 ? 0 : (s1Qty / s2Qty) * 100;
                const achievedPricePct = s2Price === 0 ? 0 : (s1Price / s2Price) * 100;
                const diffQtyPct = s2Qty === 0 ? 0 : ((s1Qty - s2Qty) / s2Qty) * 100;
                const diffPricePct = s2Price === 0 ? 0 : ((s1Price - s2Price) / s2Price) * 100;
                const qtyCls = diffQtyPct > 0 ? 'text-green-700' : diffQtyPct < 0 ? 'text-red-700' : '';
                const priceCls = diffPricePct > 0 ? 'text-green-700' : diffPricePct < 0 ? 'text-red-700' : '';
                return (
                  <>
                    <tr>
                      <td className="p-2 font-medium">TOTAL</td>
                      <td className="p-2 text-center">{s1Qty.toLocaleString('da-DK')}</td>
                      <td className="p-2 text-center">{s1Price.toLocaleString('da-DK')} DKK</td>
                      <td className="p-2 text-center">{s2Qty.toLocaleString('da-DK')}</td>
                      <td className="p-2 text-center">{s2Price.toLocaleString('da-DK')} DKK</td>
                      <td className="p-2 text-center"><span className={qtyCls}>{(diffQtyPct>=0?'+':'') + diffQtyPct.toFixed(2)}%</span></td>
                      <td className="p-2 text-center"><span className={priceCls}>{(diffPricePct>=0?'+':'') + diffPricePct.toFixed(2)}%</span></td>
                    </tr>
                    <tr className="bg-gray-50">
                      <td className="p-2 font-medium">Andel ift. sidste år</td>
                      <td className="p-2 text-center">—</td>
                      <td className="p-2 text-center">—</td>
                      <td className="p-2 text-center">—</td>
                      <td className="p-2 text-center">—</td>
                      <td className="p-2 text-center">{achievedQtyPct.toFixed(2)}%</td>
                      <td className="p-2 text-center">{achievedPricePct.toFixed(2)}%</td>
                    </tr>
                  </>
                );
              })()}
            </tbody>
          </table>
        </div>
      </div>

      {/* Currency Conversion Rates */}
      <div className="rounded-lg border bg-white">
        <div className="p-3 text-sm font-semibold border-b">Currency Conversion Rates (to DKK)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left font-semibold">Currency</th>
                <th className="p-2 text-center font-semibold">{getSeasonLabel(s1) || 'Season 1'}</th>
                <th className="p-2 text-center font-semibold">{getSeasonLabel(s2) || 'Season 2'}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="p-2 font-medium">EUR</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS1 ?? {}) }.EUR ?? 0) || 0).toFixed(4)}</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS2 ?? {}) }.EUR ?? 0) || 0).toFixed(4)}</td>
              </tr>
              <tr className="border-t">
                <td className="p-2 font-medium">NOK</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS1 ?? {}) }.NOK ?? 0) || 0).toFixed(4)}</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS2 ?? {}) }.NOK ?? 0) || 0).toFixed(4)}</td>
              </tr>
              <tr className="border-t">
                <td className="p-2 font-medium">SEK</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS1 ?? {}) }.SEK ?? 0) || 0).toFixed(4)}</td>
                <td className="p-2 text-center">{(({ ...rates, ...(ratesS2 ?? {}) }.SEK ?? 0) || 0).toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

