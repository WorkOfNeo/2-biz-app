'use client';
import { useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStatisticsData, type Customer, type SalesStatRow, type InvoiceRow } from '../../_shared/StatisticsDataContext';

export default function OverviewRecordsPage() {
  return (
    <Suspense fallback={(
      <div className="flex items-center justify-center p-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
      </div>
    )}>
      <RecordsInner />
    </Suspense>
  );
}

function RecordsInner() {
  const search = useSearchParams();
  const sp = search.get('sp') || '';
  const mode = (search.get('mode') as 'nulled' | 'not_visited' | 'visited') || 'visited';
  const country = search.get('country') || 'All';

  // Use the same season + comparison season auto-selection as Statistics/General (via StatisticsDataProvider)
  const { seasons, s1, s2, customers, stats, invoices, overrides, closedCustomers, ready } = useStatisticsData();

  function getSeasonLabel(seasonId: string | null | undefined) {
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

  const data = useMemo(() => {
    if (!customers || !stats) return [] as any[];
    const arr = (customers ?? []).filter((c: Customer) => {
      if (c.salesperson_id !== sp) return false;
      if (country !== 'All' && String(c.country ?? '').toUpperCase() !== country.toUpperCase()) return false;
      if (c.customer_id && isHidden(c.customer_id)) return false;
      return true;
    });

    const nulledSet = new Set(arr.filter((c: Customer) => c.customer_id && isNulled(c.customer_id)).map((c: Customer) => c.customer_id));
    const validSet = new Set(arr.filter((c: Customer) => c.customer_id && !nulledSet.has(c.customer_id)).map((c: Customer) => c.customer_id));
    // Only include visited customers that are VALID (not nulled).
    // IMPORTANT: Treat S1 invoices as "visited" too, otherwise invoice-only customers look "missing".
    const visitedFromStats = new Set(
      (stats ?? [])
        .filter((r: SalesStatRow) => r.salesperson_id === sp && r.season_id === s1 && r.account_no && validSet.has(r.account_no))
        .map((r: SalesStatRow) => r.account_no as string)
    );
    const customersById = new Map<string, Customer>();
    for (const c of arr) {
      if (c.customer_id) customersById.set(c.customer_id, c);
    }
    const visitedFromInvoices = new Set(
      ((invoices ?? []) as InvoiceRow[])
        .filter((inv) => inv.season_id === s1 && inv.account_no && validSet.has(inv.account_no))
        // Ensure invoice belongs to this salesperson's filtered customer set (country + hidden already applied via arr)
        .filter((inv) => Boolean(inv.account_no && customersById.has(inv.account_no)))
        .map((inv) => inv.account_no as string)
    );
    const visitedSet = new Set<string>([...Array.from(visitedFromStats), ...Array.from(visitedFromInvoices)]);
    const invoiceOnlyVisited = Array.from(visitedFromInvoices).filter((id) => !visitedFromStats.has(id));
    if (invoiceOnlyVisited.length > 0) {
      console.log('[overview/records] invoice-only visited customers detected', {
        sp,
        mode,
        country,
        s1,
        validCustomers: validSet.size,
        visitedFromStats: visitedFromStats.size,
        visitedFromInvoices: visitedFromInvoices.size,
        invoiceOnlyCount: invoiceOnlyVisited.length,
        sampleAccountNos: invoiceOnlyVisited.slice(0, 20),
      });
    }
    const notVisitedSet = new Set(Array.from(validSet).filter((id: string) => !visitedSet.has(id)));
    let targetIds: Set<string>;
    if (mode === 'nulled') targetIds = nulledSet;
    else if (mode === 'not_visited') targetIds = notVisitedSet;
    else targetIds = visitedSet;

    // Create lookup map for customer -> salesperson_id
    const byCustomer = new Map<
      string,
      {
        id: string;
        name: string;
        city: string;
        s1: Array<SalesStatRow & { isInvoice?: boolean; invoice_no?: string | null }>;
        s2: Array<SalesStatRow & { isInvoice?: boolean; invoice_no?: string | null }>;
      }
    >();
    for (const id of targetIds) {
      const c = arr.find((x: Customer) => x.customer_id === id);
      byCustomer.set(id, { id, name: c?.company || id, city: c?.city || '-', s1: [], s2: [] });
    }
    for (const r of (stats ?? []) as SalesStatRow[]) {
      if (r.salesperson_id !== sp) continue;
      const acc = r.account_no as string | null;
      if (!acc || !byCustomer.has(acc)) continue;
      if (r.season_id === s1) byCustomer.get(acc)!.s1.push(r);
      if (r.season_id === s2) byCustomer.get(acc)!.s2.push(r);
    }
    for (const inv of (invoices ?? []) as InvoiceRow[]) {
      const acc = inv.account_no as string | null;
      if (!acc || !byCustomer.has(acc)) continue;
      const fake: SalesStatRow & { isInvoice?: boolean; invoice_no?: string | null } = {
        id: `inv:${inv.id || inv.invoice_no || acc}:${inv.season_id}`,
        account_no: inv.account_no,
        qty: Number(inv.qty || 0),
        price: Number(inv.amount || 0),
        currency: inv.currency ?? null,
        season_id: inv.season_id,
        salesperson_id: sp,
        updated_at: inv.created_at ?? null,
        isInvoice: true,
        invoice_no: inv.invoice_no
      } as any;
      if (inv.season_id === s1) byCustomer.get(acc)!.s1.push(fake);
      if (inv.season_id === s2) byCustomer.get(acc)!.s2.push(fake);
    }
    return Array.from(byCustomer.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, stats, invoices, sp, country, mode, s1, s2, overrides, closedCustomers]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-700">Overview · Records</h1>
        <div className="text-sm text-gray-600">Salesperson: {sp} · Filter: {mode} · Country: {country}</div>
      </div>
      <div className="overflow-auto rounded-lg border bg-white">
        {!ready && (
          <div className="flex items-center justify-center p-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
          </div>
        )}
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
              <th className="p-2 text-center">Price</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c: any) => (
              <tr key={c.id} className="border-t align-top">
                <td className="p-2 whitespace-nowrap align-top">{c.name}</td>
                <td className="p-2 whitespace-nowrap align-top">{c.city}</td>
                {/* S1 Qty */}
                <td className="p-1 align-top">
                  {c.s1.length === 0 ? (
                    <div className="p-1 text-xs text-gray-500">—</div>
                  ) : (
                    <div className="text-xs space-y-1">
                      {c.s1.map((r: any, idx: number) => (
                        <div key={idx}>{Number(r.qty||0)}</div>
                      ))}
                    </div>
                  )}
                </td>
                {/* S1 Price */}
                <td className="p-1 align-top text-right">
                  {c.s1.length === 0 ? (
                    <div className="p-1 text-xs text-gray-500">—</div>
                  ) : (
                    <div className="text-xs space-y-1">
                      {c.s1.map((r: any, idx: number) => (
                        <div key={idx}>
                          {Math.round(Number(r.price||0)).toLocaleString('da-DK')}
                          {r.isInvoice && <span className="ml-1 inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white">INV</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                {/* S2 Qty */}
                <td className="p-1 align-top">
                  {c.s2.length === 0 ? (
                    <div className="p-1 text-xs text-gray-500">—</div>
                  ) : (
                    <div className="text-xs space-y-1">
                      {c.s2.map((r: any, idx: number) => (
                        <div key={idx}>{Number(r.qty||0)}</div>
                      ))}
                    </div>
                  )}
                </td>
                {/* S2 Price */}
                <td className="p-1 align-top text-right">
                  {c.s2.length === 0 ? (
                    <div className="p-1 text-xs text-gray-500">—</div>
                  ) : (
                    <div className="text-xs space-y-1">
                      {c.s2.map((r: any, idx: number) => (
                        <div key={idx}>
                          {Math.round(Number(r.price||0)).toLocaleString('da-DK')}
                          {r.isInvoice && <span className="ml-1 inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white">INV</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


