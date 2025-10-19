'use client';
import { useMemo, Suspense } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { useSearchParams } from 'next/navigation';

type StatsRow = { account_no: string | null; qty: number; price: number; season_id: string; salesperson_id: string | null };
type InvoiceRow = { account_no: string | null; qty: number; amount: number; currency: string | null; invoice_no: string | null; season_id: string; salesperson_id: string | null; created_at?: string };

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

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const s1 = saved?.value?.s1 ?? '';
  const s2 = saved?.value?.s2 ?? '';

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

  const { data: customers } = useSWR('overview:customers', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, country, salesperson_id, nulled, excluded, permanently_closed');
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  });

  const { data: stats, isLoading: statsLoading } = useSWR(s1 && s2 ? ['overview:stats', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('account_no, qty, price, season_id, salesperson_id')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  }, { refreshInterval: 20000 });
  const { data: invoices, isLoading: invoicesLoading } = useSWR(s1 && s2 ? ['overview:invoices', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_invoices')
      .select('account_no, qty, amount, currency, invoice_no, season_id, salesperson_id, created_at')
      .in('season_id', [s1, s2])
      .limit(200000);
    if (error) throw new Error(error.message);
    return (data ?? []) as InvoiceRow[];
  }, { refreshInterval: 20000 });

  const data = useMemo(() => {
    if (!customers || !stats) return [] as any[];
    const arr = (customers ?? []).filter((c: any) => c.salesperson_id === sp && (country === 'All' ? true : String(c.country ?? '').toUpperCase() === country.toUpperCase()));
    const nulledSet = new Set(arr.filter((c: any) => !!(c.nulled || c.excluded || c.permanently_closed)).map((c: any) => c.customer_id));
    const allSet = new Set(arr.map((c: any) => c.customer_id));
    const visitedSet = new Set((stats ?? []).filter(r => r.salesperson_id === sp && r.season_id === s1 && r.account_no && allSet.has(r.account_no)).map(r => r.account_no as string));
    const validSet = new Set(arr.filter((c: any) => !nulledSet.has(c.customer_id)).map((c: any) => c.customer_id));
    const notVisitedSet = new Set(Array.from(validSet).filter((id: string) => !visitedSet.has(id)));
    let targetIds: Set<string>;
    if (mode === 'nulled') targetIds = nulledSet;
    else if (mode === 'not_visited') targetIds = notVisitedSet;
    else targetIds = visitedSet;

    const byCustomer = new Map<string, { id: string; name: string; city: string; s1: Array<StatsRow & { isInvoice?: boolean; invoice_no?: string | null }>; s2: Array<StatsRow & { isInvoice?: boolean; invoice_no?: string | null }> }>();
    for (const id of targetIds) {
      const c = arr.find((x: any) => x.customer_id === id);
      byCustomer.set(id, { id, name: c?.company || id, city: c?.city || '-', s1: [], s2: [] });
    }
    for (const r of (stats ?? [])) {
      if (r.salesperson_id !== sp) continue;
      const acc = r.account_no as string | null;
      if (!acc || !byCustomer.has(acc)) continue;
      if (r.season_id === s1) byCustomer.get(acc)!.s1.push(r);
      if (r.season_id === s2) byCustomer.get(acc)!.s2.push(r);
    }
    for (const inv of (invoices ?? [])) {
      if (inv.salesperson_id !== sp) continue;
      const acc = inv.account_no as string | null;
      if (!acc || !byCustomer.has(acc)) continue;
      const fake: StatsRow & { isInvoice?: boolean; invoice_no?: string | null } = {
        account_no: inv.account_no,
        qty: Number(inv.qty || 0),
        price: Number(inv.amount || 0),
        season_id: inv.season_id,
        salesperson_id: inv.salesperson_id,
        isInvoice: true,
        invoice_no: inv.invoice_no
      };
      if (inv.season_id === s1) byCustomer.get(acc)!.s1.push(fake);
      if (inv.season_id === s2) byCustomer.get(acc)!.s2.push(fake);
    }
    return Array.from(byCustomer.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, stats, sp, country, mode, s1, s2]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-700">Overview · Records</h1>
        <div className="text-sm text-gray-600">Salesperson: {sp} · Filter: {mode} · Country: {country}</div>
      </div>
      <div className="overflow-auto rounded-lg border bg-white">
        {(statsLoading || invoicesLoading) && (
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
              <th className="p-2 text-center">Price (DKK)</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-center">Price (DKK)</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c: any) => (
              <tr key={c.id} className="border-t align-top">
                <td className="p-2 whitespace-nowrap">{c.name}</td>
                <td className="p-2 whitespace-nowrap">{c.city}</td>
                <td className="p-0">
                  <table className="min-w-full text-xs">
                    <tbody>
                      {c.s1.length === 0 && (<tr><td className="p-1 text-gray-500">—</td><td className="p-1"></td></tr>)}
                      {c.s1.map((r: any, idx: number) => (
                        <tr key={idx}>
                          <td className="p-1">{Number(r.qty||0)}</td>
                          <td className="p-1 text-right">
                            {Math.round(Number(r.price||0)).toLocaleString('da-DK')}
                            {r.isInvoice && <span className="ml-1 inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white">INV</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </td>
                <td className="p-0">
                  <table className="min-w-full text-xs">
                    <tbody>
                      {c.s2.length === 0 && (<tr><td className="p-1 text-gray-500">—</td><td className="p-1"></td></tr>)}
                      {c.s2.map((r: any, idx: number) => (
                        <tr key={idx}>
                          <td className="p-1">{Number(r.qty||0)}</td>
                          <td className="p-1 text-right">
                            {Math.round(Number(r.price||0)).toLocaleString('da-DK')}
                            {r.isInvoice && <span className="ml-1 inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white">INV</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


