'use client';
import * as React from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../lib/supabaseClient';

// Reuse Donut component from overview (smaller for dense layout)
function Donut({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const isGreen = p === 100;
  const bg = isGreen 
    ? `conic-gradient(#10b981 ${p}%, #e5e7eb 0)` // green-500
    : `conic-gradient(#0f172a ${p}%, #e5e7eb 0)`; // slate-900
  return (
    <div className="inline-flex items-center gap-1">
      <div className="relative" style={{ width: 20, height: 20 }}>
        <div className="rounded-full" style={{ width: 20, height: 20, background: bg }} />
        <div className="absolute inset-0.5 rounded-full bg-white" />
      </div>
      <span className="text-[10px] text-gray-700">{p}%</span>
    </div>
  );
}

type Person = { id: string; name: string; currency?: string | null };
type StatsRow = { account_no: string | null; qty: number; price: number; season_id: string; salesperson_id: string | null };
type Customer = { customer_id: string; company?: string | null; city?: string | null; country: string | null; salesperson_id: string | null; nulled?: boolean | null; excluded?: boolean | null; permanently_closed?: boolean | null };
type InvoiceRow = { account_no: string | null; qty: number | null; amount: number | null; currency: string | null; season_id: string };

const COUNTRIES = ['Denmark', 'Norway', 'Sweden', 'Finland'] as const;

export default function HomePage() {
  const supabaseClient = createClientComponentClient();
  const [name, setName] = React.useState<string>('');

  React.useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        const nm = (user?.user_metadata as any)?.name || user?.email || '';
        setName(String(nm || ''));
      } catch {}
    })();
  }, []);

  // Get seasons
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, is_current').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; year: number | null }[];
  });

  // Get saved season comparison
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });

  const [s1, setS1] = React.useState<string>('');
  const [s2, setS2] = React.useState<string>('');

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  React.useEffect(() => {
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

  // Get salespersons
  const { data: people } = useSWR('overview:salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, currency').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Person[];
  });

  // Get currency rates
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });

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

  const spCurrencyById = React.useMemo(() => Object.fromEntries(((people ?? []) as Person[]).map(p => [p.id, p.currency ?? 'DKK'])), [people]);

  // Get customers
  const { data: customers } = useSWR('overview:customers-main', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, country, salesperson_id, nulled, excluded, permanently_closed');
    if (error) throw new Error(error.message);
    return (data ?? []) as Customer[];
  }, { refreshInterval: 10000 });

  // Get stats
  const { data: stats } = useSWR(s1 && s2 ? ['overview:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('account_no, qty, price, season_id, salesperson_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  });

  // Get invoices
  const { data: invoices } = useSWR(s1 && s2 ? ['overview:invoices', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_invoices')
      .select('account_no, qty, amount, season_id, currency')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as InvoiceRow[];
  });

  // Get seasonal overrides (same structure as overview)
  const { data: overrides } = useSWR(s1 ? `season:${s1}:overrides` : null, async () => {
    const key = `season_overrides:${s1}`;
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', key).maybeSingle();
    if (error) throw new Error(error.message);
    return { id: data?.id || null, value: ((data?.value as any) || { nulled: [], hidden: [] }) as { nulled: string[]; hidden: string[] } };
  }, { refreshInterval: 0 });

  // Get closed customers (same structure as overview)
  const { data: closedCustomers } = useSWR('overview:customers-closed', async () => {
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
  });

  // Helper functions to check if customer is hidden or nulled (same logic as Overview page)
  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }

  function isNulled(account: string): boolean {
    return Boolean(overrides?.value.nulled.includes(account)) || Boolean(closedCustomers?.setNulled.has(account)) || Boolean(closedCustomers?.setClosed.has(account));
  }

  // Calculate data per country and salesperson (reuse overview logic)
  const countryData = React.useMemo(() => {
    if (!people || !customers || !stats || !invoices || !s1 || !s2) return {} as Record<string, { rows: any[]; totals: any }>;

    const result: Record<string, { rows: any[]; totals: { s1Qty: number; s1PriceDkk: number; s2Qty: number; s2PriceDkk: number } }> = {};

    for (const countryName of COUNTRIES) {
      const targetCountry = countryName.toUpperCase();
      const bySpCustomers = new Map<string, Customer[]>();
      for (const c of customers) {
        if (!c.salesperson_id) continue;
        if (String(c.country ?? '').toUpperCase() !== targetCountry) continue;
        const arr = bySpCustomers.get(c.salesperson_id) || [];
        arr.push(c);
        bySpCustomers.set(c.salesperson_id, arr);
      }

      const targetsBySp = new Map<string, Set<string>>();
      const validTargetsBySp = new Map<string, Set<string>>();
      for (const [spId, arr] of bySpCustomers.entries()) {
        const allSet = new Set<string>();
        const validSet = new Set<string>();
        for (const c of arr) {
          if (c.customer_id) {
            allSet.add(c.customer_id);
            if (!isHidden(c.customer_id) && !isNulled(c.customer_id)) {
              validSet.add(c.customer_id);
            }
          }
        }
        targetsBySp.set(spId, allSet);
        validTargetsBySp.set(spId, validSet);
      }

      const agg = new Map<string, { s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; visitedValid: Set<string>; visitedNoS2: number }>();
      for (const sp of people) agg.set(sp.id, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, visitedValid: new Set<string>(), visitedNoS2: 0 });

      const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
      const seasonRatesS1 = { ...baseRates, ...(ratesS1 ?? {}) };
      const seasonRatesS2 = { ...baseRates, ...(ratesS2 ?? {}) };

      // Process stats
      for (const r of stats) {
        const spId = r.salesperson_id ?? '';
        const set = targetsBySp.get(spId);
        if (!set) continue;
        const acc = r.account_no ?? '';
        if (!acc || !set.has(acc)) continue;
        if (isHidden(acc)) continue;
        const row = agg.get(spId)!;
        const currency = spCurrencyById[spId] ?? 'DKK';
        const rateS1 = seasonRatesS1[currency] ?? 1;
        const rateS2 = seasonRatesS2[currency] ?? 1;
        const price = Number(r.price || 0);
        if (r.season_id === s1) {
          const isNullS1 = isNulled(acc);
          if (!isNullS1) {
            row.s1Qty += Number(r.qty || 0);
            row.s1Price += price * rateS1;
          }
          if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc);
        } else if (r.season_id === s2) {
          row.s2Qty += Number(r.qty || 0);
          row.s2Price += price * rateS2;
        }
      }

      // Process invoices
      const customerById = new Map<string, Customer>();
      for (const c of customers) { if (c.customer_id) customerById.set(c.customer_id, c); }

      for (const inv of invoices) {
        const acc = inv.account_no ?? '';
        if (!acc) continue;
        if (isHidden(acc)) continue;
        const c = customerById.get(acc);
        const spId = c?.salesperson_id ?? '';
        if (!spId) continue;
        const set = targetsBySp.get(spId);
        if (!set || !set.has(acc)) continue;
        const row = agg.get(spId)!;
        const currency = spCurrencyById[spId] ?? 'DKK';
        const rateS1 = seasonRatesS1[currency] ?? 1;
        const rateS2 = seasonRatesS2[currency] ?? 1;
        const amount = Number(inv.amount || 0);
        const qty = Number(inv.qty || 0) || 0;
        if (inv.season_id === s1) {
          const isNullS1 = isNulled(acc);
          if (!isNullS1) {
            row.s1Qty += qty;
            row.s1Price += amount * rateS1;
          }
        } else if (inv.season_id === s2) {
          row.s2Qty += qty;
          row.s2Price += amount * rateS2;
        }
      }

      // Calculate collectedIndex per salesperson for this country
      const countryRows: any[] = [];
      for (const sp of people) {
        const spCustomers = bySpCustomers.get(sp.id) ?? [];
        const totalCustomers = spCustomers.length;
        const nulledCustomers = spCustomers.filter(c => c.customer_id && isNulled(c.customer_id));
        const nulledCount = nulledCustomers.length;
        const a = agg.get(sp.id)!;
        const validTotal = validTargetsBySp.get(sp.id)?.size ?? Math.max(0, totalCustomers - nulledCount);
        const visitedCount = a.visitedValid.size;
        const visitedPct = validTotal > 0 ? (visitedCount / validTotal) * 100 : 0;

        // Calculate collected index for this salesperson's customers in this country
        const allowedAccounts = new Set<string>();
        const nulledAccounts = new Set<string>();
        for (const c of spCustomers) {
          if (!c.customer_id) continue;
          if (isHidden(c.customer_id)) continue;
          allowedAccounts.add(c.customer_id);
          if (isNulled(c.customer_id)) nulledAccounts.add(c.customer_id);
        }

        const buckets = new Map<string, { accountId: string; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; isNulled: boolean }>();
        const ensureBucket = (accountId: string) => {
          const existing = buckets.get(accountId);
          if (existing) return existing;
          const created = { accountId, s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, isNulled: nulledAccounts.has(accountId) };
          buckets.set(accountId, created);
          return created;
        };
        allowedAccounts.forEach((acc) => ensureBucket(acc));

        const safeCurrency = (value: string | null | undefined, fallback = 'DKK') => {
          const base = value ?? fallback ?? 'DKK';
          return String(base).toUpperCase();
        };

        // Aggregate stats for this salesperson's customers
        for (const r of stats) {
          const acc = r.account_no ?? '';
          if (!acc || !allowedAccounts.has(acc)) continue;
          if (r.salesperson_id !== sp.id) continue;
          const bucket = ensureBucket(acc);
          const qty = Number(r.qty || 0);
          const price = Number(r.price || 0);
          const currency = safeCurrency(spCurrencyById[sp.id]);
          if (r.season_id === s1) {
            if (!bucket.isNulled) {
              bucket.s1Qty += qty;
              bucket.s1Price += price * (seasonRatesS1[currency] ?? 1);
            }
          } else if (r.season_id === s2) {
            bucket.s2Qty += qty;
            bucket.s2Price += price * (seasonRatesS2[currency] ?? 1);
          }
        }

        // Aggregate invoices for this salesperson's customers
        for (const inv of invoices) {
          const acc = inv.account_no ?? '';
          if (!acc || !allowedAccounts.has(acc)) continue;
          const c = customerById.get(acc);
          if (c?.salesperson_id !== sp.id) continue;
          const bucket = ensureBucket(acc);
          const qty = Number(inv.qty || 0) || 0;
          const amount = Number(inv.amount || 0) || 0;
          const currency = safeCurrency(spCurrencyById[sp.id]);
          if (inv.season_id === s1) {
            if (!bucket.isNulled) {
              bucket.s1Qty += qty;
              bucket.s1Price += amount * (seasonRatesS1[currency] ?? 1);
            }
          } else if (inv.season_id === s2) {
            bucket.s2Qty += qty;
            bucket.s2Price += amount * (seasonRatesS2[currency] ?? 1);
          }
        }

        const values = Array.from(buckets.values());
        const visited = values.filter((v) => v.s1Qty > 0 || v.s1Price > 0);
        const visitedS1Qty = visited.reduce((a, v) => a + v.s1Qty, 0);
        const visitedS1Price = visited.reduce((a, v) => a + v.s1Price, 0);
        const visitedS2Qty = visited.reduce((a, v) => a + v.s2Qty, 0);
        const visitedS2Price = visited.reduce((a, v) => a + v.s2Price, 0);
        const qtyIndexRatio = visitedS2Qty === 0 ? 1 : visitedS1Qty / visitedS2Qty;
        const priceIndexRatio = visitedS2Price === 0 ? 1 : visitedS1Price / visitedS2Price;
        const indexQty = visitedS2Qty === 0 ? 100 : qtyIndexRatio * 100;
        const indexPrice = visitedS2Price === 0 ? 100 : priceIndexRatio * 100;
        const unvisited = values.filter((v) => v.s1Qty === 0 && v.s1Price === 0 && !v.isNulled);
        const unvisitedS2Qty = unvisited.reduce((a, v) => a + v.s2Qty, 0);
        const unvisitedS2Price = unvisited.reduce((a, v) => a + v.s2Price, 0);
        const prognosedQty = visitedS1Qty + unvisitedS2Qty;
        const prognosedPrice = visitedS1Price + unvisitedS2Price;

        // Count visited customers with no S2 entries
        const visitedNoS2 = visited.filter(v => v.s2Qty === 0 && v.s2Price === 0).length;

        if (validTotal > 0 || visitedCount > 0 || visitedS1Qty > 0 || visitedS1Price > 0) {
          countryRows.push({
            id: sp.id,
            name: sp.name,
            visitedCount,
            validTotal,
            visitedPct,
            indexQty,
            indexPrice,
            prognosedQty,
            prognosedPrice,
            visitedNoS2,
          });
        }
      }

      // Calculate totals for this country (similar to overview page)
      const countryTotals = {
        s1Qty: 0,
        s1PriceDkk: 0,
        s2Qty: 0,
        s2PriceDkk: 0,
      };

      // Calculate totals from aggregated data
      for (const sp of people) {
        const a = agg.get(sp.id)!;
        countryTotals.s1Qty += a.s1Qty;
        countryTotals.s1PriceDkk += a.s1Price;
        countryTotals.s2Qty += a.s2Qty;
        countryTotals.s2PriceDkk += a.s2Price;
      }

      if (countryRows.length > 0) {
        result[countryName] = {
          rows: countryRows,
          totals: countryTotals,
        };
      }
    }

    return result;
  }, [people, customers, stats, invoices, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById, overrides, closedCustomers]);

  // Get top 15 styles (with exclusions matching top10 page)
  const defaultSeasonId = React.useMemo(() => (seasons ?? []).find(s => (s as any).is_current)?.id || (seasons ?? [])[0]?.id || null, [seasons?.length]);
  
  // Load all items for season (will filter/exclude and slice locally)
  const { data: allTopStyles } = useSWR(defaultSeasonId ? ['top-styles', defaultSeasonId] : null, async () => {
    const { data } = await supabase.from('top_styles').select('*').eq('season_id', defaultSeasonId).order('qty', { ascending: false });
    return (data ?? []) as any[];
  });

  // Excluded styles per season (by style_no)
  const { data: excludedSet } = useSWR(defaultSeasonId ? ['top-styles:excluded', defaultSeasonId] : null, async () => {
    const key = `top_styles_excluded:${defaultSeasonId}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    const list = (((data?.value as any)?.styleNos as string[] | undefined) ?? []).filter(Boolean);
    return new Set(list);
  });

  // Global exclusions across all seasons
  const { data: excludedGlobal } = useSWR('top-styles:excluded-global', async () => {
    const key = 'top_styles_excluded_global';
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
    const list = (((data?.value as any)?.styleNos as string[] | undefined) ?? []).filter(Boolean);
    return { id: (data as any)?.id as string | null, list } as { id: string | null; list: string[] };
  });

  const excludedGlobalSet = React.useMemo(() => new Set((excludedGlobal?.list || []).map(s => String(s))), [excludedGlobal?.id, excludedGlobal?.list?.length]);

  // Filter and slice to top 15 (same logic as top10 page)
  const topStyles = React.useMemo(() => {
    const list = (allTopStyles ?? []) as Array<any>;
    const ex = excludedSet as Set<string> | undefined;
    let filtered = ex ? list.filter((r) => !ex.has(r.style_no)) : list;
    if (excludedGlobalSet && excludedGlobalSet.size > 0) {
      filtered = filtered.filter((r) => !excludedGlobalSet.has(String(r.style_no)));
    }
    return filtered.slice(0, 15);
  }, [allTopStyles, excludedSet, excludedGlobalSet]);

  const { data: supplierMap } = useSWR(topStyles && topStyles.length ? ['suppliers', topStyles.map(i => i.style_no).join(',')] : null, async () => {
    const { data } = await supabase.from('styles').select('style_no, supplier').in('style_no', (topStyles ?? []).map((i: any) => i.style_no));
    const map = new Map<string, string | null>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, r.supplier ?? null);
    return map;
  });

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4">
          <h1 className="text-2xl font-semibold">Hej{name ? ` ${name}` : ''}.</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left side - 2 columns */}
          <div className="lg:col-span-2 space-y-4">
            {/* Quick Links */}
            <div className="flex gap-2">
              <Link href="/statistics/general" className="px-4 py-2 rounded border hover:bg-gray-50 text-sm font-medium">
                General
              </Link>
              <Link href="/statistics/overview" className="px-4 py-2 rounded border hover:bg-gray-50 text-sm font-medium">
                Overview
              </Link>
              <Link href="/statistics/countries" className="px-4 py-2 rounded border hover:bg-gray-50 text-sm font-medium">
                Countries
              </Link>
            </div>

            {/* Combined Table for All Countries */}
            {React.useMemo(() => {
              return (
                <div className="rounded-md border overflow-hidden">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-semibold border-r">Sælger</th>
                        <th className="px-2 py-1.5 text-center font-semibold border-r">Fremskridt</th>
                        <th className="px-2 py-1.5 text-right font-semibold border-r">Index stk</th>
                        <th className="px-2 py-1.5 text-right font-semibold border-r">Index Oms.</th>
                        <th className="px-2 py-1.5 text-right font-semibold border-r">Prognose stk</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Prognose Oms.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {COUNTRIES.map((countryName) => {
                        const countryInfo = countryData[countryName];
                        if (!countryInfo || !countryInfo.rows || countryInfo.rows.length === 0) return null;

                        const rows = countryInfo.rows;
                        const totals = countryInfo.totals;

                        // Calculate progression percentages
                        const s1Qty = Math.round(totals.s1Qty);
                        const s1Price = Math.round(totals.s1PriceDkk);
                        const s2Qty = Math.round(totals.s2Qty);
                        const s2Price = Math.round(totals.s2PriceDkk);
                        const diffQtyPct = s2Qty === 0 ? 0 : ((s1Qty - s2Qty) / s2Qty) * 100;
                        const diffPricePct = s2Price === 0 ? 0 : ((s1Price - s2Price) / s2Price) * 100;
                        const qtyCls = diffQtyPct > 0 ? 'text-green-700' : diffQtyPct < 0 ? 'text-red-700' : '';
                        const priceCls = diffPricePct > 0 ? 'text-green-700' : diffPricePct < 0 ? 'text-red-700' : '';

                        return (
                          <React.Fragment key={countryName}>
                            {/* Country Header Row */}
                            <tr className="bg-gray-200 border-t-2 border-gray-300">
                              <td colSpan={6} className="px-2 py-1.5 font-semibold">
                                {countryName}
                              </td>
                            </tr>
                            
                            {/* Salesperson Rows */}
                            {rows.map((row: any) => (
                              <tr key={`${countryName}-${row.id}`} className="border-t hover:bg-gray-50">
                                <td className="px-2 py-1 border-r">
                                  <Link 
                                    href={`/statistics/general#sp=${encodeURIComponent(row.name)}`}
                                    className="font-medium text-blue-600 hover:underline"
                                  >
                                    {row.name}
                                  </Link>
                                  {row.visitedNoS2 > 0 && (
                                    <span className="text-orange-600 ml-1 text-[10px]">({row.visitedNoS2} besøgt uden {getSeasonLabel(s2)} tal)</span>
                                  )}
                                </td>
                                <td className="px-2 py-1 border-r text-center">
                                  <div className="flex items-center justify-center gap-1">
                                    <Donut pct={row.visitedPct} />
                                    <span className="text-gray-700">{row.visitedCount}/{row.validTotal}</span>
                                  </div>
                                </td>
                                <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                  {Math.round(row.indexQty).toLocaleString('da-DK')}
                                </td>
                                <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                  {Math.round(row.indexPrice).toLocaleString('da-DK')}
                                </td>
                                <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                  {Math.round(row.prognosedQty).toLocaleString('da-DK')}
                                </td>
                                <td className="px-2 py-1 text-right font-mono text-[11px]">
                                  {Math.round(row.prognosedPrice).toLocaleString('da-DK')}
                                </td>
                              </tr>
                            ))}

                            {/* Totals Row for Country */}
                            <tr className="bg-gray-100 border-t-2 border-gray-300 font-medium">
                              <td colSpan={2} className="px-2 py-1 border-r">TOTAL</td>
                              <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                {s1Qty.toLocaleString('da-DK')} stk<br />
                                <span className="text-gray-500 text-[10px]">vs {s2Qty.toLocaleString('da-DK')}</span><br />
                                <span className={qtyCls}>
                                  {diffQtyPct > 0 ? '+' : ''}{diffQtyPct.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                {s1Price.toLocaleString('da-DK')} Oms.<br />
                                <span className="text-gray-500 text-[10px]">vs {s2Price.toLocaleString('da-DK')}</span><br />
                                <span className={priceCls}>
                                  {diffPricePct > 0 ? '+' : ''}{diffPricePct.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-2 py-1 border-r text-right font-mono text-[11px]">
                                —
                              </td>
                              <td className="px-2 py-1 text-right font-mono text-[11px]">
                                —
                              </td>
                            </tr>
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            }, [countryData, s1, s2])}
          </div>

          {/* Right sidebar - 1 column */}
          <div className="space-y-4">
            <div className="rounded-md border p-4">
              <h2 className="text-lg font-semibold mb-3">Top 15 Styles</h2>
              <div className="space-y-2">
                {(topStyles ?? []).map((style: any, idx: number) => (
                  <div key={style.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded border">
                    {style.image_url && (
                      <img src={style.image_url} alt="" className="h-12 w-12 object-cover rounded" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{style.style_name || style.style_no}</div>
                      <div className="text-xs text-gray-600">
                        Qty: {Number(style.qty || 0).toLocaleString('da-DK')} | {supplierMap?.get(style.style_no) || '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
