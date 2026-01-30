'use client';
import { useMemo, useState, useRef, type ReactNode } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Modal } from '../../../components/Modal';
import { EyeOff, Ban, Trash2 } from 'lucide-react';
import { useStatisticsData, type Customer, type Salesperson, type SalesStatRow } from '../_shared/StatisticsDataContext';

type Person = Salesperson;
type StatsRow = SalesStatRow;

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
  const {
    ready,
    seasons,
    s1,
    s2,
    setS1,
    setS2,
    salespersons: people,
    customers,
    stats,
    invoices,
    overrides,
    closedCustomers,
    currencyRatesRow,
    ratesS1,
    ratesS2,
    refreshAll
  } = useStatisticsData();

  const [country, setCountry] = useState<typeof COUNTRIES[number]>('All');
  const [calcTab, setCalcTab] = useState<'visited' | 'visited_incl'>('visited');
  const [indexModal, setIndexModal] = useState<{ mode: 'visited' | 'visited_incl' | 'unvisited' } | null>(null);
  const [detailModal, setDetailModal] = useState<{ salespersonId: string; salespersonName: string; season: 's1' | 's2'; seasonLabel: string } | null>(null);
  const [notVisitedModal, setNotVisitedModal] = useState<{ salespersonId: string; salespersonName: string; customers: Customer[] } | null>(null);

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  const rates = useMemo(() => ({ DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>), [currencyRatesRow]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((people ?? []) as Person[]).map(p => [p.id, p.currency ?? 'DKK'])), [people]);

  // Helper functions to check if customer is hidden or nulled (same logic as General page)
  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }
  function isNulled(account: string): boolean {
    return Boolean(overrides?.value.nulled.includes(account)) || Boolean(closedCustomers?.setNulled.has(account)) || Boolean(closedCustomers?.setClosed.has(account));
  }

  async function saveOverrides(next: { nulled: string[]; hidden: string[] }) {
    const overridesKey = s1 ? `season_overrides:${s1}` : null;
    if (!overridesKey) return;
    console.log('[overview] saveOverrides', overridesKey, next);
    if (overrides?.id) {
      const { error } = await supabase.from('app_settings').update({ value: next }).eq('id', overrides.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('app_settings').insert({ key: overridesKey, value: next });
      if (error) throw new Error(error.message);
    }
    await refreshAll();
  }

  async function toggleNull(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const nulled = new Set(overrides?.value.nulled ?? []);
    if (nulled.has(account)) nulled.delete(account); else nulled.add(account);
    console.log('[overview] toggleNull', account, '->', Array.from(nulled));
    await saveOverrides({ nulled: Array.from(nulled), hidden: overrides?.value.hidden ?? [] });
    await refreshAll();
  }

  async function permanentClose(account: string) {
    // Mark customer globally; also add seasonal null
    const { error } = await supabase.from('customers').update({ permanently_closed: true, nulled: true }).eq('customer_id', account);
    if (error) return alert(error.message);
    console.log('[overview] permanentClose', account);
    await toggleNull(account);
    await refreshAll();
  }

  // Action button component with hover tooltip (same as General page)
  function ActionBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    const [show, setShow] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    return (
      <button
        className="relative rounded p-1 hover:bg-gray-100"
        onMouseEnter={() => { timer.current = setTimeout(() => setShow(true), 2000); }}
        onMouseLeave={() => { if (timer.current) clearTimeout(timer.current); setShow(false); }}
        onClick={onClick}
      >
        {children}
        {show && (
          <span className="absolute left-1/2 -translate-x-1/2 translate-y-2 text-[10px] bg-black text-white rounded px-1.5 py-0.5 shadow">
            {label}
          </span>
        )}
      </button>
    );
  }

  const rows = useMemo(() => {
    if (!people || !customers || !stats) return [] as any[];
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    // Customer lookup used to attribute activity to the assigned salesperson
    const customerById = new Map<string, Customer>();
    for (const c of customers) { if (c.customer_id) customerById.set(c.customer_id, c); }

    const bySpCustomers = new Map<string, Customer[]>();
    for (const c of customers) {
      if (!c.salesperson_id) continue;
      if (targetCountry && String(c.country ?? '').toUpperCase() !== targetCountry) continue;
      const arr = bySpCustomers.get(c.salesperson_id) || [];
      arr.push(c);
      bySpCustomers.set(c.salesperson_id, arr);
    }
    // Build quick lookup sets of target accounts (all) and valid accounts (excluding nulled/excluded/closed/hidden via seasonal overrides)
    const targetsBySp = new Map<string, Set<string>>();
    const validTargetsBySp = new Map<string, Set<string>>();
    for (const [spId, arr] of bySpCustomers.entries()) {
      const allSet = new Set<string>();
      const validSet = new Set<string>();
      for (const c of arr) {
        if (c.customer_id) {
          allSet.add(c.customer_id);
          // Exclude hidden and nulled customers (same logic as General page)
          if (!isHidden(c.customer_id) && !isNulled(c.customer_id)) {
            validSet.add(c.customer_id);
          }
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
      const acc = r.account_no ?? '';
      // IMPORTANT: Attribute to assigned salesperson (customer table) if present.
      // This ensures customers "count as visited" even if another salesperson recorded the sale.
      const spId = (acc ? (customerById.get(acc)?.salesperson_id ?? null) : null) ?? (r.salesperson_id ?? '');
      const set = targetsBySp.get(spId);
      if (!set) continue; // salesperson may have no customers in this country
      if (!acc || !set.has(acc)) continue;
      // Exclude hidden customers from aggregation (same as General page)
      if (isHidden(acc)) continue;
      const row = agg.get(spId)!;
      const currency = spCurrencyById[spId] ?? 'DKK';
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const price = Number(r.price || 0);
      // Exclude nulled customers from S1 totals (same as General page)
      if (r.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1) {
          row.s1Qty += Number(r.qty||0);
          row.s1Price += price * rateS1;
        }
        row.visited.add(acc);
        if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc);
      } else if (r.season_id === s2) {
        row.s2Qty += Number(r.qty||0);
        row.s2Price += price * rateS2;
      }
    }
    // Aggregate invoices mapped to salesperson via customers
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      // Exclude hidden customers from aggregation (same as General page)
      if (isHidden(acc)) continue;
      const c = customerById.get(acc);
      const spId = c?.salesperson_id ?? '';
      if (!spId) continue;
      const set = targetsBySp.get(spId);
      if (!set || !set.has(acc)) continue;
      const row = agg.get(spId)!;
      // Use salesperson's currency for consistency with sales_stats, default to DKK if no salesperson
      const currency = spCurrencyById[spId] ?? 'DKK';
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const amount = Number(inv.amount || 0);
      const qty = Number(inv.qty || 0) || 0;
      // Exclude nulled customers from S1 totals (same as General page)
      if (inv.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1) {
          row.s1Qty += qty;
          row.s1Price += amount * rateS1;
        }
        // Mark visited based on invoice activity too (fixes "invoice-only" visited customers showing as Missing)
        row.visited.add(acc);
        if (validTargetsBySp.get(spId)?.has(acc)) row.visitedValid.add(acc);
      } else if (inv.season_id === s2) {
        row.s2Qty += qty;
        row.s2Price += amount * rateS2;
      }
    }
    // Build output rows
    const out = [] as any[];
    for (const sp of people) {
      const spCustomers = bySpCustomers.get(sp.id) ?? [];
      const totalCustomers = spCustomers.length;
      // Count nulled customers using same logic as General page (includes seasonal overrides)
      const nulledCustomers = spCustomers.filter(c => c.customer_id && isNulled(c.customer_id));
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
      
      // Calculate not visited customers for modal
      const validIds = validTargetsBySp.get(sp.id) || new Set();
      const notVisitedIds = Array.from(validIds).filter(id => !a.visitedValid.has(id));
      const notVisitedCustomers = spCustomers.filter(c => c.customer_id && notVisitedIds.includes(c.customer_id));
      
      // Debug logging for not visited
      if (notVisitedCount > 0) {
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
        notVisitedCustomers, // Store for modal display
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
  }, [people, customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById, overrides, closedCustomers]);

  // Totals across all salespersons for selected country, converted to DKK
  const totals = useMemo(() => {
    if (!customers || !stats) return { s1Qty: 0, s1PriceDkk: 0, s2Qty: 0, s2PriceDkk: 0 };
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    const targetAccounts = new Set<string>();
    // Exclude hidden customers from target accounts (same as General page)
    for (const c of (customers ?? []) as Customer[]) {
      if (targetCountry && String(c.country ?? '').toUpperCase() !== targetCountry) continue;
      if (c.customer_id && !isHidden(c.customer_id)) {
        targetAccounts.add(c.customer_id);
      }
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
      // Exclude nulled customers from S1 totals (same as General page)
      if (r.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1) {
          out.s1Qty += qty;
          out.s1PriceDkk += price * rateS1;
        }
      } else if (r.season_id === s2) {
        out.s2Qty += qty;
        out.s2PriceDkk += price * rateS2;
      }
    }
    // Build customer lookup for invoice currency resolution
    const customerByIdForInv = new Map<string, Customer>();
    for (const c of (customers ?? [])) { if (c.customer_id) customerByIdForInv.set(c.customer_id, c); }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc || !targetAccounts.has(acc)) continue;
      // Use salesperson's currency via customer lookup, default to DKK if no salesperson (same as General page)
      const c = customerByIdForInv.get(acc);
      const spId = c?.salesperson_id ?? null;
      const currency = spId ? (spCurrencyById[spId] ?? 'DKK') : 'DKK';
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
      const qty = Number(inv.qty || 0) || 0;
      const amount = Number(inv.amount || 0);
      // Exclude nulled customers from S1 totals (same as General page)
      if (inv.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1) {
          out.s1Qty += qty;
          out.s1PriceDkk += amount * rateS1;
        }
      } else if (inv.season_id === s2) {
        out.s2Qty += qty;
        out.s2PriceDkk += amount * rateS2;
      }
    }
    return out;
  }, [customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById, overrides, closedCustomers]);

  // Calculate effective currency rates from actual conversions
  const effectiveRates = useMemo(() => {
    if (!customers || !stats || !invoices) return { s1: { EUR: 0, NOK: 0, SEK: 0 }, s2: { EUR: 0, NOK: 0, SEK: 0 } };
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    const targetAccounts = new Set<string>();
    for (const c of (customers ?? []) as Customer[]) {
      if (targetCountry && String(c.country ?? '').toUpperCase() !== targetCountry) continue;
      if (c.customer_id && !isHidden(c.customer_id)) {
        targetAccounts.add(c.customer_id);
      }
    }
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    
    // Track original amounts and converted DKK amounts per currency
    type CurrencyKey = 'EUR' | 'NOK' | 'SEK';
    const s1Agg: Record<CurrencyKey, { original: number; dkk: number }> = { EUR: { original: 0, dkk: 0 }, NOK: { original: 0, dkk: 0 }, SEK: { original: 0, dkk: 0 } };
    const s2Agg: Record<CurrencyKey, { original: number; dkk: number }> = { EUR: { original: 0, dkk: 0 }, NOK: { original: 0, dkk: 0 }, SEK: { original: 0, dkk: 0 } };
    
    for (const r of (stats ?? []) as StatsRow[]) {
      const acc = r.account_no ?? '';
      if (!acc || !targetAccounts.has(acc)) continue;
      const cur = (r.salesperson_id ? (spCurrencyById[r.salesperson_id] ?? 'DKK') : 'DKK').toUpperCase();
      if (cur !== 'EUR' && cur !== 'NOK' && cur !== 'SEK') continue;
      const currency = cur as CurrencyKey;
      const price = Number(r.price || 0);
      if (r.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1 && price > 0) {
          const rate = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
          s1Agg[currency].original += price;
          s1Agg[currency].dkk += price * rate;
        }
      } else if (r.season_id === s2 && price > 0) {
        const rate = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
        s2Agg[currency].original += price;
        s2Agg[currency].dkk += price * rate;
      }
    }
    
    const customerByIdForInv = new Map<string, Customer>();
    for (const c of (customers ?? [])) { if (c.customer_id) customerByIdForInv.set(c.customer_id, c); }
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc || !targetAccounts.has(acc)) continue;
      const c = customerByIdForInv.get(acc);
      const spId = c?.salesperson_id ?? null;
      const cur = (spId ? (spCurrencyById[spId] ?? 'DKK') : 'DKK').toUpperCase();
      if (cur !== 'EUR' && cur !== 'NOK' && cur !== 'SEK') continue;
      const currency = cur as CurrencyKey;
      const amount = Number(inv.amount || 0);
      if (inv.season_id === s1) {
        const isNullS1 = isNulled(acc);
        if (!isNullS1 && amount > 0) {
          const rate = { ...baseRates, ...(ratesS1 ?? {}) }[currency] ?? 1;
          s1Agg[currency].original += amount;
          s1Agg[currency].dkk += amount * rate;
        }
      } else if (inv.season_id === s2 && amount > 0) {
        const rate = { ...baseRates, ...(ratesS2 ?? {}) }[currency] ?? 1;
        s2Agg[currency].original += amount;
        s2Agg[currency].dkk += amount * rate;
      }
    }
    
    // Calculate effective rates: total_dkk / total_original
    return {
      s1: {
        EUR: s1Agg.EUR.original > 0 ? s1Agg.EUR.dkk / s1Agg.EUR.original : (ratesS1?.EUR ?? baseRates.EUR ?? 0),
        NOK: s1Agg.NOK.original > 0 ? s1Agg.NOK.dkk / s1Agg.NOK.original : (ratesS1?.NOK ?? baseRates.NOK ?? 0),
        SEK: s1Agg.SEK.original > 0 ? s1Agg.SEK.dkk / s1Agg.SEK.original : (ratesS1?.SEK ?? baseRates.SEK ?? 0)
      },
      s2: {
        EUR: s2Agg.EUR.original > 0 ? s2Agg.EUR.dkk / s2Agg.EUR.original : (ratesS2?.EUR ?? baseRates.EUR ?? 0),
        NOK: s2Agg.NOK.original > 0 ? s2Agg.NOK.dkk / s2Agg.NOK.original : (ratesS2?.NOK ?? baseRates.NOK ?? 0),
        SEK: s2Agg.SEK.original > 0 ? s2Agg.SEK.dkk / s2Agg.SEK.original : (ratesS2?.SEK ?? baseRates.SEK ?? 0)
      }
    };
  }, [customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById, overrides, closedCustomers]);

  // Detail rows for modal
  const detailRows = useMemo(() => {
    if (!detailModal || !stats || !invoices || !customers) return [];
    const { salespersonId, season } = detailModal;
    const seasonId = season === 's1' ? s1 : s2;
    
    type DetailRow = {
      source: 'stats' | 'invoice';
      account_no: string;
      customer_name: string;
      city: string;
      qty: number;
      price: number;
      currency: string;
      rate: number;
      priceDkk: number;
      isNulled: boolean;
    };
    
    const rows: DetailRow[] = [];
    const customerById = new Map<string, Customer>();
    for (const c of customers) { if (c.customer_id) customerById.set(c.customer_id, c); }
    
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const seasonRates = season === 's1' ? { ...baseRates, ...(ratesS1 ?? {}) } : { ...baseRates, ...(ratesS2 ?? {}) };
    const currency = spCurrencyById[salespersonId] ?? 'DKK';
    const rate = seasonRates[currency] ?? 1;
    
    // Add stats rows
    for (const r of stats) {
      if (r.salesperson_id !== salespersonId) continue;
      if (r.season_id !== seasonId) continue;
      const acc = r.account_no ?? '';
      if (!acc) continue;
      if (isHidden(acc)) continue;
      
      const customer = customerById.get(acc);
      rows.push({
        source: 'stats',
        account_no: acc,
        customer_name: customer?.company ?? '-',
        city: customer?.city ?? '-',
        qty: Number(r.qty || 0),
        price: Number(r.price || 0),
        currency,
        rate,
        priceDkk: Number(r.price || 0) * rate,
        isNulled: isNulled(acc)
      });
    }
    
    // Add invoice rows
    for (const inv of invoices) {
      if (inv.season_id !== seasonId) continue;
      const acc = inv.account_no ?? '';
      if (!acc) continue;
      if (isHidden(acc)) continue;
      
      const customer = customerById.get(acc);
      if (customer?.salesperson_id !== salespersonId) continue;
      
      rows.push({
        source: 'invoice',
        account_no: acc,
        customer_name: customer?.company ?? '-',
        city: customer?.city ?? '-',
        qty: Number(inv.qty || 0),
        price: Number(inv.amount || 0),
        currency,
        rate,
        priceDkk: Number(inv.amount || 0) * rate,
        isNulled: isNulled(acc)
      });
    }
    
    return rows.sort((a, b) => b.priceDkk - a.priceDkk);
  }, [detailModal, stats, invoices, customers, s1, s2, spCurrencyById, currencyRatesRow, ratesS1, ratesS2, overrides, closedCustomers]);

  const collectedIndex = useMemo(() => {
    if (!customers || !stats || !s1 || !s2) return null;
    const targetCountry = country === 'All' ? null : country.toUpperCase();
    const customersById = new Map<string, Customer>();
    const allowedAccounts = new Set<string>();
    const nulledAccounts = new Set<string>();
    for (const c of customers as Customer[]) {
      if (!c.customer_id) continue;
      customersById.set(c.customer_id, c);
      if (isHidden(c.customer_id)) continue;
      const cCountry = String(c.country ?? '').toUpperCase();
      if (targetCountry && cCountry !== targetCountry) continue;
      allowedAccounts.add(c.customer_id);
      if (isNulled(c.customer_id)) {
        nulledAccounts.add(c.customer_id);
      }
    }
    if (allowedAccounts.size === 0) return null;
    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const seasonRatesS1 = { ...baseRates, ...(ratesS1 ?? {}) };
    const seasonRatesS2 = { ...baseRates, ...(ratesS2 ?? {}) };
    type Bucket = { accountId: string; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; isNulled: boolean };
    const buckets = new Map<string, Bucket>();
    const ensureBucket = (accountId: string) => {
      const existing = buckets.get(accountId);
      if (existing) return existing;
      const created: Bucket = { accountId, s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, isNulled: nulledAccounts.has(accountId) };
      buckets.set(accountId, created);
      return created;
    };
    allowedAccounts.forEach((acc) => ensureBucket(acc));
    const safeCurrency = (value: string | null | undefined, fallback = 'DKK') => {
      const base = value ?? fallback ?? 'DKK';
      return String(base).toUpperCase();
    };
    for (const r of (stats ?? []) as StatsRow[]) {
      const acc = r.account_no ?? '';
      if (!acc || !allowedAccounts.has(acc)) continue;
      const bucket = ensureBucket(acc);
      const qty = Number(r.qty || 0);
      const price = Number(r.price || 0);
      const currency = safeCurrency(r.salesperson_id ? spCurrencyById[r.salesperson_id] : null);
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
    for (const inv of (invoices ?? [])) {
      const acc = inv.account_no ?? '';
      if (!acc || !allowedAccounts.has(acc)) continue;
      const bucket = ensureBucket(acc);
      const qty = Number(inv.qty || 0) || 0;
      const amount = Number(inv.amount || 0) || 0;
      const meta = customersById.get(acc);
      const spId = meta?.salesperson_id ?? null;
      const fallbackCurrency = safeCurrency(inv.currency);
      const currency = spId ? safeCurrency(spCurrencyById[spId], fallbackCurrency) : fallbackCurrency;
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
    if (values.length === 0) return null;
    const visited = values.filter((v) => v.s1Qty > 0 || v.s1Price > 0);
    const visitedS1Qty = visited.reduce((a, v) => a + v.s1Qty, 0);
    const visitedS1Price = visited.reduce((a, v) => a + v.s1Price, 0);
    const visitedS2Qty = visited.reduce((a, v) => a + v.s2Qty, 0);
    const visitedS2Price = visited.reduce((a, v) => a + v.s2Price, 0);
    const qtyIndexRatio = visitedS2Qty === 0 ? 1 : visitedS1Qty / visitedS2Qty;
    const priceIndexRatio = visitedS2Price === 0 ? 1 : visitedS1Price / visitedS2Price;
    const indexQty = visitedS2Qty === 0 ? 100 : qtyIndexRatio * 100;
    const indexPrice = visitedS2Price === 0 ? 100 : priceIndexRatio * 100;

    const visitedIncl = values.filter((v) => (v.s1Qty > 0 || v.s1Price > 0) || v.isNulled);
    const visitedInclS1Qty = visitedIncl.reduce((a, v) => a + v.s1Qty, 0);
    const visitedInclS1Price = visitedIncl.reduce((a, v) => a + v.s1Price, 0);
    const visitedInclS2Qty = visitedIncl.reduce((a, v) => a + v.s2Qty, 0);
    const visitedInclS2Price = visitedIncl.reduce((a, v) => a + v.s2Price, 0);
    const qtyIndexRatioIncl = visitedInclS2Qty === 0 ? 1 : visitedInclS1Qty / visitedInclS2Qty;
    const priceIndexRatioIncl = visitedInclS2Price === 0 ? 1 : visitedInclS1Price / visitedInclS2Price;
    const indexQtyIncl = visitedInclS2Qty === 0 ? 100 : qtyIndexRatioIncl * 100;
    const indexPriceIncl = visitedInclS2Price === 0 ? 100 : priceIndexRatioIncl * 100;
    const unvisited = values.filter((v) => v.s1Qty === 0 && v.s1Price === 0 && !v.isNulled);
    const unvisitedS2Qty = unvisited.reduce((a, v) => a + v.s2Qty, 0);
    const unvisitedS2Price = unvisited.reduce((a, v) => a + v.s2Price, 0);
    // Prognosis = Current sales (S1) from visited + Same sales from not visited (S2 from last year)
    const prognosedQty = visitedS1Qty + unvisitedS2Qty;
    const prognosedPrice = visitedS1Price + unvisitedS2Price;
    type DetailRow = {
      accountId: string;
      customer: string;
      city: string;
      s1Qty: number;
      s1Price: number;
      s2Qty: number;
      s2Price: number;
      isNulled: boolean;
    };
    const formatRow = (bucket: Bucket): DetailRow => {
      const meta = customersById.get(bucket.accountId);
      return {
        accountId: bucket.accountId,
        customer: meta?.company ?? bucket.accountId,
        city: meta?.city ?? '-',
        s1Qty: bucket.s1Qty,
        s1Price: bucket.s1Price,
        s2Qty: bucket.s2Qty,
        s2Price: bucket.s2Price,
        isNulled: bucket.isNulled,
      };
    };
    const visitedRows = visited
      .map(formatRow)
      .sort((a, b) => b.s1Price - a.s1Price);
    const visitedInclRows = visitedIncl
      .map(formatRow)
      .sort((a, b) => b.s2Price - a.s2Price);
    const unvisitedRows = unvisited
      .map(formatRow)
      .sort((a, b) => b.s2Price - a.s2Price);
    return {
      visitedS1Qty,
      visitedS2Qty,
      visitedS1Price,
      visitedS2Price,
      visitedInclS1Qty,
      visitedInclS2Qty,
      visitedInclS1Price,
      visitedInclS2Price,
      unvisitedS2Qty,
      unvisitedS2Price,
      indexQty,
      indexPrice,
      indexQtyIncl,
      indexPriceIncl,
      prognosedQty,
      prognosedPrice,
      visitedRows,
      visitedInclRows,
      unvisitedRows,
    };
  }, [customers, stats, invoices, country, s1, s2, currencyRatesRow, ratesS1, ratesS2, spCurrencyById, overrides, closedCustomers]);

  const salesmenSummary = useMemo(() => {
    const n = rows.length || 0;
    const sums = rows.reduce(
      (acc, r) => {
        acc.nulled += Number(r.nulledCount || 0);
        acc.visited += Number(r.visited || 0);
        acc.total += Number(r.effectiveTotal || 0);
        acc.notVisited += Number(r.notVisited || 0);
        acc.s1Qty += Number(r.s1Qty || 0);
        acc.s1Price += Number(r.s1Price || 0);
        acc.s2Qty += Number(r.s2Qty || 0);
        acc.s2Price += Number(r.s2Price || 0);
        acc.s1AvgSum += Number(r.s1Avg || 0);
        acc.s2AvgSum += Number(r.s2Avg || 0);
        acc.visitedPctSum += Number(r.visitedPct || 0);
        // Match table logic for price pct
        const perRowPricePct =
          typeof r.diffPct === 'number'
            ? r.diffPct
            : (Number(r.s2Price || 0) === 0 ? 0 : ((Number(r.s1Price || 0) - Number(r.s2Price || 0)) / Number(r.s2Price || 0)) * 100);
        acc.qtyPctSum += (Number(r.s2Qty || 0) === 0 ? 0 : ((Number(r.s1Qty || 0) - Number(r.s2Qty || 0)) / Number(r.s2Qty || 0)) * 100);
        acc.pricePctSum += perRowPricePct;
        return acc;
      },
      {
        nulled: 0,
        visited: 0,
        total: 0,
        notVisited: 0,
        s1Qty: 0,
        s1Price: 0,
        s2Qty: 0,
        s2Price: 0,
        s1AvgSum: 0,
        s2AvgSum: 0,
        visitedPctSum: 0,
        qtyPctSum: 0,
        pricePctSum: 0,
      }
    );
    const avg = (v: number) => (n === 0 ? 0 : v / n);
    const overallVisitedPct = sums.total === 0 ? 0 : (sums.visited / sums.total) * 100;
    const overallS1Avg = sums.s1Qty === 0 ? 0 : sums.s1Price / sums.s1Qty;
    const overallS2Avg = sums.s2Qty === 0 ? 0 : sums.s2Price / sums.s2Qty;
    const overallQtyPct = sums.s2Qty === 0 ? 0 : ((sums.s1Qty - sums.s2Qty) / sums.s2Qty) * 100;
    const overallPricePct = sums.s2Price === 0 ? 0 : ((sums.s1Price - sums.s2Price) / sums.s2Price) * 100;
    return {
      n,
      sums,
      avgNulled: avg(sums.nulled),
      avgVisited: avg(sums.visited),
      avgTotal: avg(sums.total),
      avgNotVisited: avg(sums.notVisited),
      avgVisitedPct: avg(sums.visitedPctSum),
      overallVisitedPct,
      avgS1Qty: avg(sums.s1Qty),
      avgS1Price: avg(sums.s1Price),
      avgS2Qty: avg(sums.s2Qty),
      avgS2Price: avg(sums.s2Price),
      avgS1Avg: avg(sums.s1AvgSum),
      avgS2Avg: avg(sums.s2AvgSum),
      overallS1Avg,
      overallS2Avg,
      avgQtyPct: avg(sums.qtyPctSum),
      avgPricePct: avg(sums.pricePctSum),
      overallQtyPct,
      overallPricePct,
    };
  }, [rows]);

  // navigation helper
  function buildDetailsHref(spId: string, mode: 'nulled' | 'not_visited' | 'visited') {
    return {
      pathname: '/statistics/overview/records' as const,
      query: { sp: spId, mode, country }
    };
  }

  return !ready ? (
    <div className="flex items-center justify-center p-10">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
    </div>
  ) : (
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
                <td className="p-2">
                  <button
                    onClick={() => setNotVisitedModal({ 
                      salespersonId: r.id, 
                      salespersonName: r.name, 
                      customers: (r as any).notVisitedCustomers || [] 
                    })}
                    className="underline underline-offset-2 hover:text-blue-600"
                    disabled={r.notVisited === 0}
                  >
                    {r.notVisited}
                  </button>
                </td>
                <td className="p-2"><Donut pct={r.visitedPct} /></td>
                <td className="p-2 text-center">
                  <button 
                    onClick={() => setDetailModal({ salespersonId: r.id, salespersonName: r.name, season: 's1', seasonLabel: getSeasonLabel(s1) })}
                    className="underline underline-offset-2 hover:text-blue-600"
                  >
                    {r.s1Qty}
                  </button>
                </td>
                <td className="p-2 text-center">
                  <button 
                    onClick={() => setDetailModal({ salespersonId: r.id, salespersonName: r.name, season: 's1', seasonLabel: getSeasonLabel(s1) })}
                    className="underline underline-offset-2 hover:text-blue-600"
                  >
                    {Math.round(r.s1Price).toLocaleString('da-DK')}
                  </button>
                </td>
                <td className="p-2 text-center">{Math.round(r.s1Avg).toLocaleString('da-DK')}</td>
                <td className="p-2 text-center">
                  <button 
                    onClick={() => setDetailModal({ salespersonId: r.id, salespersonName: r.name, season: 's2', seasonLabel: getSeasonLabel(s2) })}
                    className="underline underline-offset-2 hover:text-blue-600"
                  >
                    {r.s2Qty}
                  </button>
                </td>
                <td className="p-2 text-center">
                  <button 
                    onClick={() => setDetailModal({ salespersonId: r.id, salespersonName: r.name, season: 's2', seasonLabel: getSeasonLabel(s2) })}
                    className="underline underline-offset-2 hover:text-blue-600"
                  >
                    {Math.round(r.s2Price).toLocaleString('da-DK')}
                  </button>
                </td>
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
            <tr className="border-t bg-gray-50">
              <td className="p-2 font-semibold">
                <div className="flex flex-col leading-tight">
                  <span>Avg</span>
                  <span className="text-xs text-gray-500">Totals</span>
                </div>
              </td>
              <td className="p-2">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgNulled).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.nulled).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2">
                <div className="flex flex-col leading-tight">
                  <span>
                    {Math.round(salesmenSummary.avgVisited).toLocaleString('da-DK')}/{Math.round(salesmenSummary.avgTotal).toLocaleString('da-DK')}
                  </span>
                  <span className="text-xs text-gray-500">
                    {Math.round(salesmenSummary.sums.visited).toLocaleString('da-DK')}/{Math.round(salesmenSummary.sums.total).toLocaleString('da-DK')}
                  </span>
                </div>
              </td>
              <td className="p-2">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgNotVisited).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.notVisited).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2">
                <div className="flex flex-col leading-tight">
                  <span>{salesmenSummary.avgVisitedPct.toFixed(1)}%</span>
                  <span className="text-xs text-gray-500">{salesmenSummary.overallVisitedPct.toFixed(1)}%</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS1Qty).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.s1Qty).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS1Price).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.s1Price).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS1Avg).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.overallS1Avg).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS2Qty).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.s2Qty).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS2Price).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.sums.s2Price).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{Math.round(salesmenSummary.avgS2Avg).toLocaleString('da-DK')}</span>
                  <span className="text-xs text-gray-500">{Math.round(salesmenSummary.overallS2Avg).toLocaleString('da-DK')}</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{salesmenSummary.avgQtyPct.toFixed(2)}%</span>
                  <span className="text-xs text-gray-500">{salesmenSummary.overallQtyPct.toFixed(2)}%</span>
                </div>
              </td>
              <td className="p-2 text-center">
                <div className="flex flex-col leading-tight">
                  <span>{salesmenSummary.avgPricePct.toFixed(2)}%</span>
                  <span className="text-xs text-gray-500">{salesmenSummary.overallPricePct.toFixed(2)}%</span>
                </div>
              </td>
            </tr>
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

      {collectedIndex && (
        <div className="rounded-lg border bg-white">
          <div className="border-b p-3">
            <div className="text-sm font-semibold">Collected Index & Prognosis</div>
            <div className="mt-2 inline-flex rounded-md border bg-white p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setCalcTab('visited')}
                className={'rounded px-3 py-1.5 ' + (calcTab === 'visited' ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50')}
              >
                Visited
              </button>
              <button
                type="button"
                onClick={() => setCalcTab('visited_incl')}
                className={'rounded px-3 py-1.5 ' + (calcTab === 'visited_incl' ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50')}
              >
                Visited + Nulled
              </button>
            </div>
            <div className="mt-2 text-xs text-gray-600">
              {calcTab === 'visited'
                ? 'Visited: Index is calculated from customers that have Season 1 activity.'
                : 'Visited + Nulled: Index basis includes visited customers plus customers that are nulled / permanently closed (may have last-year numbers).'}
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            {calcTab === 'visited' ? (
              <>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-gray-500">Index QTY</div>
                  <div className="text-xl font-semibold">{collectedIndex.indexQty.toFixed(1)}</div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedS1Qty.toLocaleString('da-DK')} vs {collectedIndex.visitedS2Qty.toLocaleString('da-DK')} (visited)
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedS2Qty === 0 ? 'Calc: visited S2 is 0 → 100.0' : 'Calc: (visited S1 / visited S2) × 100'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIndexModal({ mode: 'visited' })}
                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                    disabled={collectedIndex.visitedRows.length === 0}
                  >
                    View records
                  </button>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-gray-500">Index PRICE</div>
                  <div className="text-xl font-semibold">{collectedIndex.indexPrice.toFixed(1)}</div>
                  <div className="text-[11px] text-gray-400">
                    {Math.round(collectedIndex.visitedS1Price).toLocaleString('da-DK')} vs {Math.round(collectedIndex.visitedS2Price).toLocaleString('da-DK')} (visited · DKK)
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedS2Price === 0 ? 'Calc: visited S2 is 0 → 100.0' : 'Calc: (visited S1 / visited S2) × 100'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIndexModal({ mode: 'visited' })}
                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                    disabled={collectedIndex.visitedRows.length === 0}
                  >
                    View records
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-gray-500">Index QTY</div>
                  <div className="text-xl font-semibold">{collectedIndex.indexQtyIncl.toFixed(1)}</div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedInclS1Qty.toLocaleString('da-DK')} vs {collectedIndex.visitedInclS2Qty.toLocaleString('da-DK')} (visited + nulled/closed)
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedInclS2Qty === 0 ? 'Calc: visited+excluded S2 is 0 → 100.0' : 'Calc: (visited+excluded S1 / visited+excluded S2) × 100'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIndexModal({ mode: 'visited_incl' })}
                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                    disabled={collectedIndex.visitedInclRows.length === 0}
                  >
                    View records
                  </button>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-gray-500">Index PRICE</div>
                  <div className="text-xl font-semibold">{collectedIndex.indexPriceIncl.toFixed(1)}</div>
                  <div className="text-[11px] text-gray-400">
                    {Math.round(collectedIndex.visitedInclS1Price).toLocaleString('da-DK')} vs {Math.round(collectedIndex.visitedInclS2Price).toLocaleString('da-DK')} (visited + nulled/closed · DKK)
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {collectedIndex.visitedInclS2Price === 0 ? 'Calc: visited+excluded S2 is 0 → 100.0' : 'Calc: (visited+excluded S1 / visited+excluded S2) × 100'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIndexModal({ mode: 'visited_incl' })}
                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                    disabled={collectedIndex.visitedInclRows.length === 0}
                  >
                    View records
                  </button>
                </div>
              </>
            )}

            <div className="rounded-md border p-3">
              <div className="text-xs text-gray-500">Prognose QTY</div>
              <div className="text-xl font-semibold">{Math.round(collectedIndex.prognosedQty).toLocaleString('da-DK')}</div>
              <div className="text-[11px] text-gray-400">if index holds</div>
              <div className="text-[11px] text-gray-400">Calc: visited S1 + unvisited S2</div>
              <button
                type="button"
                onClick={() => setIndexModal({ mode: 'unvisited' })}
                className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                disabled={collectedIndex.unvisitedRows.length === 0}
              >
                View pending records
              </button>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-gray-500">Prognose PRICE</div>
              <div className="text-xl font-semibold">{Math.round(collectedIndex.prognosedPrice).toLocaleString('da-DK')} DKK</div>
              <div className="text-[11px] text-gray-400">if index holds</div>
              <div className="text-[11px] text-gray-400">Calc: visited S1 + unvisited S2</div>
              <button
                type="button"
                onClick={() => setIndexModal({ mode: 'unvisited' })}
                className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                disabled={collectedIndex.unvisitedRows.length === 0}
              >
                View pending records
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(indexModal && collectedIndex)}
        onClose={() => setIndexModal(null)}
        title={
          indexModal?.mode === 'visited'
            ? 'Visited customers · Index basis'
            : indexModal?.mode === 'visited_incl'
              ? 'Visited + nulled/closed · Index basis'
            : 'Pending customers · Prognosis basis'
        }
        maxWidth="max-w-4xl"
        footer={
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => setIndexModal(null)}
          >
            Close
          </button>
        }
      >
        {(() => {
          if (!indexModal || !collectedIndex) return null;
          const rows =
            indexModal.mode === 'visited'
              ? collectedIndex.visitedRows
              : indexModal.mode === 'visited_incl'
                ? collectedIndex.visitedInclRows
                : collectedIndex.unvisitedRows;
          if (rows.length === 0) {
            return <div className="p-4 text-sm text-gray-600">Nothing to show for this selection.</div>;
          }
          return (
            <div className="max-h-[60vh] overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left">
                    <th className="p-2 font-semibold">Customer</th>
                    <th className="p-2 font-semibold">City</th>
                    <th className="p-2 text-right font-semibold">S1 Qty</th>
                    <th className="p-2 text-right font-semibold">S1 Price (DKK)</th>
                    <th className="p-2 text-right font-semibold">S2 Qty</th>
                    <th className="p-2 text-right font-semibold">S2 Price (DKK)</th>
                    <th className="p-2 text-center font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.accountId} className={`border-t hover:bg-gray-50 ${row.isNulled ? 'bg-amber-50' : ''}`}>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span>{row.customer}</span>
                          {row.isNulled && <span className="text-[10px] rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">nulled/closed</span>}
                        </div>
                      </td>
                      <td className="p-2">{row.city || '-'}</td>
                      <td className="p-2 text-right">{Number(row.s1Qty || 0).toLocaleString('da-DK')}</td>
                      <td className="p-2 text-right">{Math.round(row.s1Price || 0).toLocaleString('da-DK')}</td>
                      <td className="p-2 text-right">{Number(row.s2Qty || 0).toLocaleString('da-DK')}</td>
                      <td className="p-2 text-right">{Math.round(row.s2Price || 0).toLocaleString('da-DK')}</td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1">
                          {row.accountId && (
                            <>
                              <ActionBtn label="Null (season)" onClick={() => toggleNull(row.accountId)}>
                                <EyeOff className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Close (perm)" onClick={() => permanentClose(row.accountId)}>
                                <Trash2 className="h-4 w-4" />
                              </ActionBtn>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
      </Modal>

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
                <td className="p-2 text-center">{effectiveRates.s1.EUR.toFixed(4)}</td>
                <td className="p-2 text-center">{effectiveRates.s2.EUR.toFixed(4)}</td>
              </tr>
              <tr className="border-t">
                <td className="p-2 font-medium">NOK</td>
                <td className="p-2 text-center">{effectiveRates.s1.NOK.toFixed(4)}</td>
                <td className="p-2 text-center">{effectiveRates.s2.NOK.toFixed(4)}</td>
              </tr>
              <tr className="border-t">
                <td className="p-2 font-medium">SEK</td>
                <td className="p-2 text-center">{effectiveRates.s1.SEK.toFixed(4)}</td>
                <td className="p-2 text-center">{effectiveRates.s2.SEK.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal for QTY/Price breakdown */}
      <Modal
        open={Boolean(detailModal)}
        onClose={() => setDetailModal(null)}
        title={detailModal ? `${detailModal.salespersonName} · ${detailModal.seasonLabel} · Detail Rows` : 'Details'}
        maxWidth="max-w-6xl"
        footer={
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => setDetailModal(null)}
          >
            Close
          </button>
        }
      >
        {detailModal && detailRows.length > 0 ? (
          <div>
            <div className="mb-3 text-sm text-gray-600">
              Currency: <span className="font-semibold">{spCurrencyById[detailModal.salespersonId] ?? 'DKK'}</span>
              {' · '}
              Rate to DKK: <span className="font-semibold">
                {(() => {
                  const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
                  const seasonRates = detailModal.season === 's1' ? { ...baseRates, ...(ratesS1 ?? {}) } : { ...baseRates, ...(ratesS2 ?? {}) };
                  const currency = spCurrencyById[detailModal.salespersonId] ?? 'DKK';
                  const rate = seasonRates[currency] ?? 1;
                  return rate.toFixed(4);
                })()}
              </span>
            </div>
            <div className="max-h-[60vh] overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="p-2 text-left font-semibold">Source</th>
                    <th className="p-2 text-left font-semibold">Account</th>
                    <th className="p-2 text-left font-semibold">Customer</th>
                    <th className="p-2 text-left font-semibold">City</th>
                    <th className="p-2 text-right font-semibold">Qty</th>
                    <th className="p-2 text-right font-semibold">Price (Local)</th>
                    <th className="p-2 text-right font-semibold">Price (DKK)</th>
                    <th className="p-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row, idx) => (
                    <tr key={idx} className={`border-t ${row.isNulled ? 'bg-red-50 opacity-60' : ''}`}>
                      <td className="p-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded ${row.source === 'stats' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>
                          {row.source}
                        </span>
                      </td>
                      <td className="p-2">{row.account_no}</td>
                      <td className="p-2">{row.customer_name}</td>
                      <td className="p-2">{row.city}</td>
                      <td className="p-2 text-right">{row.qty.toLocaleString('da-DK')}</td>
                      <td className="p-2 text-right">{Math.round(row.price).toLocaleString('da-DK')}</td>
                      <td className="p-2 text-right font-semibold">{Math.round(row.priceDkk).toLocaleString('da-DK')}</td>
                      <td className="p-2 text-center">
                        {row.isNulled && (
                          <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-800 rounded">
                            Nulled{detailModal.season === 's1' ? ' (excluded)' : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 font-semibold">
                  <tr>
                    <td className="p-2" colSpan={4}>TOTAL</td>
                    <td className="p-2 text-right">
                      {detailRows.reduce((sum, r) => detailModal.season === 's1' && r.isNulled ? sum : sum + r.qty, 0).toLocaleString('da-DK')}
                    </td>
                    <td className="p-2 text-right">
                      {Math.round(detailRows.reduce((sum, r) => detailModal.season === 's1' && r.isNulled ? sum : sum + r.price, 0)).toLocaleString('da-DK')}
                    </td>
                    <td className="p-2 text-right">
                      {Math.round(detailRows.reduce((sum, r) => detailModal.season === 's1' && r.isNulled ? sum : sum + r.priceDkk, 0)).toLocaleString('da-DK')}
                    </td>
                    <td className="p-2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : (
          <div className="p-4 text-sm text-gray-600">No detail rows to display.</div>
        )}
      </Modal>

      {/* Not Visited Customers Modal */}
      <Modal
        open={Boolean(notVisitedModal)}
        onClose={() => setNotVisitedModal(null)}
        title={notVisitedModal ? `Not Visited Customers: ${notVisitedModal.salespersonName}` : 'Not Visited Customers'}
        maxWidth="max-w-4xl"
        footer={
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => setNotVisitedModal(null)}
          >
            Close
          </button>
        }
      >
        {notVisitedModal && notVisitedModal.customers.length > 0 ? (
          <div className="max-h-[60vh] overflow-auto">
            <div className="mb-3 text-sm text-gray-600">
              Total: <span className="font-semibold">{notVisitedModal.customers.length}</span> customer{notVisitedModal.customers.length !== 1 ? 's' : ''} not visited in {getSeasonLabel(s1) || 'Season 1'}
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="p-2 text-left font-semibold">Customer ID</th>
                  <th className="p-2 text-left font-semibold">Company</th>
                  <th className="p-2 text-left font-semibold">City</th>
                  <th className="p-2 text-left font-semibold">Country</th>
                  <th className="p-2 text-center font-semibold">Status</th>
                  <th className="p-2 text-center font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {notVisitedModal.customers
                  .sort((a, b) => (a.company || a.customer_id || '').localeCompare(b.company || b.customer_id || ''))
                  .map((customer) => (
                    <tr key={customer.customer_id} className="border-t hover:bg-gray-50">
                      <td className="p-2 font-mono text-xs">{customer.customer_id}</td>
                      <td className="p-2">{customer.company || '—'}</td>
                      <td className="p-2">{customer.city || '—'}</td>
                      <td className="p-2">{customer.country || '—'}</td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1 justify-center">
                          {customer.nulled && (
                            <span className="px-1.5 py-0.5 text-xs bg-orange-100 text-orange-700 rounded">Nulled</span>
                          )}
                          {customer.excluded && (
                            <span className="px-1.5 py-0.5 text-xs bg-red-100 text-red-700 rounded">Excluded</span>
                          )}
                          {customer.permanently_closed && (
                            <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 rounded">Closed</span>
                          )}
                          {!customer.nulled && !customer.excluded && !customer.permanently_closed && (
                            <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-500 rounded">Active</span>
                          )}
                        </div>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1">
                          {customer.customer_id && (
                            <>
                              <ActionBtn label="Null (season)" onClick={() => toggleNull(customer.customer_id)}>
                                <EyeOff className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Close (perm)" onClick={() => permanentClose(customer.customer_id)}>
                                <Trash2 className="h-4 w-4" />
                              </ActionBtn>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 text-sm text-gray-600">
            {notVisitedModal ? 'No customers found.' : 'No data available.'}
          </div>
        )}
      </Modal>

    </div>
  );
}

