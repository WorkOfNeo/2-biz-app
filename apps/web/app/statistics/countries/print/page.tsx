'use client';
import { useEffect, useMemo } from 'react';
import { useStatisticsData, type Customer, type SalesStatRow, type InvoiceRow } from '../../_shared/StatisticsDataContext';

function Donut({ pct, label }: { pct: number; label: string }) {
  const displayPct = Math.round(pct); // number can exceed 100
  const size = 160; // print-friendly size
  
  // If at or above 100%, show full green circle; otherwise show partial progress
  let bg: string;
  let textColor: string;
  
  if (pct >= 100) {
    // Full green circle
    bg = '#22c55e'; // green-500
    textColor = '#15803d'; // green-700
  } else {
    // Partial fill with slate
    const visualPct = Math.max(0, Math.min(100, Math.round(pct)));
    bg = `conic-gradient(#0f172a ${visualPct}%, #e5e7eb 0)`;
    textColor = '#334155'; // slate-700
  }
  
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="rounded-full" style={{ width: size, height: size, background: bg }} />
      <div className="text-xs" style={{ color: textColor }}>{label}: {displayPct}%</div>
    </div>
  );
}

export default function CountriesPrintPage() {
  // Use the same season + comparison season auto-selection as Statistics/General (via StatisticsDataProvider)
  const {
    ready,
    seasons,
    s1,
    s2,
    stats,
    invoices,
    customers,
    overrides,
    closedCustomers,
    currencyRatesRow,
    ratesS1,
    ratesS2
  } = useStatisticsData();

  const countries = useMemo(() => ['Denmark', 'Norway', 'Sweden', 'Finland'], []);
  const countryCurrency: Record<string, string> = useMemo(() => ({ Denmark: 'DKK', Norway: 'NOK', Sweden: 'SEK', Finland: 'EUR' }), []);

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }
  function isNulled(account: string): boolean {
    return (
      Boolean(overrides?.value.nulled.includes(account)) ||
      Boolean(closedCustomers?.setNulled.has(account)) ||
      Boolean(closedCustomers?.setClosed.has(account))
    );
  }

  const byCountry = useMemo(() => {
    const out: Record<string, { s1Qty: number; s2Qty: number; s1PriceDkk: number; s2PriceDkk: number }> = {};
    for (const c of countries) out[c] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 };

    const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
    const customerCountryById = new Map<string, string | null>();
    for (const c of (customers ?? []) as Customer[]) customerCountryById.set(c.customer_id, c.country ?? null);

    for (const r of (stats ?? []) as SalesStatRow[]) {
      const acc = String(r.account_no || '');
      if (acc && isHidden(acc)) continue;
      const ctry = String(customerCountryById.get(acc) || '').trim();
      if (!countries.includes(ctry)) continue;

      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const cur = countryCurrency[ctry] || String(r.currency || 'DKK').toUpperCase();
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const price = Number(r.price || 0);
      if (r.season_id === s1) {
        if (!isNulled(acc)) {
          bucket.s1Qty += Number(r.qty || 0);
          bucket.s1PriceDkk += price * rateS1;
        }
      } else if (r.season_id === s2) {
        bucket.s2Qty += Number(r.qty || 0);
        bucket.s2PriceDkk += price * rateS2;
      }
    }

    for (const inv of (invoices ?? []) as InvoiceRow[]) {
      const acc = String(inv.account_no || '');
      if (!acc) continue;
      if (isHidden(acc)) continue;
      const ctry = String(customerCountryById.get(acc) || '').trim();
      if (!countries.includes(ctry)) continue;

      const bucket = out[ctry] || (out[ctry] = { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 });
      const cur = countryCurrency[ctry] || String(inv.currency || 'DKK').toUpperCase();
      const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
      const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
      const amount = Number(inv.amount || 0);
      const qty = Number(inv.qty || 0) || 0;
      if (inv.season_id === s1) {
        if (!isNulled(acc)) {
          bucket.s1Qty += qty;
          bucket.s1PriceDkk += amount * rateS1;
        }
      } else if (inv.season_id === s2) {
        bucket.s2Qty += qty;
        bucket.s2PriceDkk += amount * rateS2;
      }
    }

    return out;
  }, [countries, customers, stats, invoices, s1, s2, currencyRatesRow, ratesS1, ratesS2, overrides, closedCustomers]);

  // Auto-trigger print when data is ready
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => {
      try { window.print(); } catch {}
    }, 300);
    return () => clearTimeout(id);
  }, [ready]);

  return (
    <div className="p-6 space-y-6 print:p-4">
      <div className="text-center mb-2">
        <div className="text-[20px] font-semibold">Countries</div>
        <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
      </div>
      {countries.map((c) => {
        const row = byCountry[c] || { s1Qty: 0, s2Qty: 0, s1PriceDkk: 0, s2PriceDkk: 0 };
        const qtyPct = row.s2Qty === 0 ? 0 : (row.s1Qty / row.s2Qty) * 100;
        const pricePct = row.s2PriceDkk === 0 ? 0 : (row.s1PriceDkk / row.s2PriceDkk) * 100;
        return (
          <div key={c} className="rounded-lg border bg-white break-inside-avoid print:break-inside-avoid">
            <div className="border-b text-center bg-[#0f172a] text-white rounded-t-lg text-[1.5rem] leading-tight py-2">{c}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 text-center">
              <div className="space-y-3">
                <div className="font-medium">Antal stk</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{row.s1Qty.toLocaleString('da-DK')} vs {row.s2Qty.toLocaleString('da-DK')}</div>
                <Donut pct={qtyPct} label="Stk" />
              </div>
              <div className="space-y-3">
                <div className="font-medium">Omsætning</div>
                <div className="text-sm text-gray-600">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
                <div className="text-lg font-semibold">{Math.round(row.s1PriceDkk).toLocaleString('da-DK')} DKK vs {Math.round(row.s2PriceDkk).toLocaleString('da-DK')} DKK</div>
                {c !== 'Denmark' && (() => {
                  const cur = countryCurrency[c] || 'DKK';
                  const baseRatesForDisplay = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
                  const rateForS1 = { ...baseRatesForDisplay, ...(ratesS1 ?? {}) }[cur] ?? 1;
                  const rateForS2 = { ...baseRatesForDisplay, ...(ratesS2 ?? {}) }[cur] ?? 1;
                  return (
                    <div className="text-sm text-gray-600">
                      {Math.round(row.s1PriceDkk / (rateForS1 || 1)).toLocaleString('da-DK')} {cur} vs {Math.round(row.s2PriceDkk / (rateForS2 || 1)).toLocaleString('da-DK')} {cur}
                    </div>
                  );
                })()}
                <Donut pct={pricePct} label="Omsætning" />
              </div>
            </div>
          </div>
        );
      })}
      <style>{`
        @media print {
          html, body { background: #ffffff !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          a { color: inherit; text-decoration: none; }
          .break-inside-avoid { break-inside: avoid; page-break-inside: avoid; }
          .print\\:p-4 { padding: 1rem; }
          .print\\:break-inside-avoid { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}


