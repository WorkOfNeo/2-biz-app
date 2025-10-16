'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { supabase } from '../lib/supabaseClient';

type SeasonTotals = { qty: number; price: number };
type PersonRow = { salesperson: string; qty: number; price: number; customersLeft: number };

function formatTimeDots(d: Date) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}.${mm}.${ss}`;
}

function startOfISOWeek(d: Date) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7; // 0 = Monday
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isSameISOWeek(a: Date, b: Date) {
  const sa = startOfISOWeek(a);
  const sb = startOfISOWeek(b);
  return sa.getTime() === sb.getTime();
}

function isPreviousISOWeek(a: Date, b: Date) {
  const sa = startOfISOWeek(a).getTime();
  const sb = startOfISOWeek(b).getTime();
  return sa === (sb - 7 * 24 * 3600 * 1000);
}

function relativeDayLabel(d: Date, now: Date) {
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dn = new Date(now.getFullYear(), now.getMonth(), now.getDate()); dn.setHours(0,0,0,0);
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()); dd.setHours(0,0,0,0);
  const diffDays = Math.round((dn.getTime() - dd.getTime()) / (24*3600*1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (isSameISOWeek(d, now)) {
    const idx = (d.getDay() + 6) % 7; // 0=Mon
    return `This ${dayNames[idx]}`;
  }
  if (isPreviousISOWeek(d, now)) {
    const idx = (d.getDay() + 6) % 7;
    return `Last ${dayNames[idx]}`;
  }
  // fallback: short date
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeDateTime(d: Date, now = new Date()) {
  return `${relativeDayLabel(d, now)} at ${formatTimeDots(d)}`;
}

export default function HomePage() {
  const { data: seasonCompare } = useSWR('app-settings:season-compare', async () => {
    const { data } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    return (data?.value as any) ?? { s1: null, s2: null };
  });
  const s1 = seasonCompare?.s1 as string | null;
  const s2 = seasonCompare?.s2 as string | null;

  // Load base currency + rates (DKK per 1 unit)
  const { data: ratesData } = useSWR('misc:rates', async () => {
    const defaults: Record<string, number> = { DKK: 1, SEK: 0.68, NOK: 0.64, EUR: 7.47 };
    const { data: base } = await supabase.from('app_settings').select('*').eq('key', 'base_currency').maybeSingle();
    const { data: rates } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    const merged = { ...defaults, ...((rates?.value as any) || {}) } as Record<string, number>;
    return { base: ((base?.value as any)?.code as string) || 'DKK', rates: merged };
  });

  // Salesperson currency map (fallback when row currency is missing)
  const { data: spRows } = useSWR('salespersons:map', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, currency');
    if (error) throw new Error(error.message);
    return data as { id: string; currency: string | null }[];
  });
  const spCurrencyById = new Map<string, string>(
    (spRows ?? []).map((r) => [r.id, r.currency || (ratesData?.base || 'DKK')])
  );

  // Season labels
  const { data: allSeasons } = useSWR('seasons:all', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year');
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  function seasonLabel(id: string | null | undefined): string {
    if (!id) return '';
    const s = (allSeasons ?? []).find((x) => x.id === id);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  const { data: totals } = useSWR(s1 && s2 ? ['home:totals', s1, s2, JSON.stringify(ratesData?.rates || {})] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('season_id, qty, price, currency, salesperson_id');
    if (error) throw new Error(error.message);
    const k1 = s1 as string; const k2 = s2 as string;
    const out: { [key: string]: SeasonTotals } = { [k1]: { qty: 0, price: 0 }, [k2]: { qty: 0, price: 0 } };
    for (const r of (data ?? []) as any[]) {
      const code: string = (r.currency || spCurrencyById.get(r.salesperson_id as string) || (ratesData?.base || 'DKK')) as string;
      const rate = (ratesData?.rates?.[code] ?? 1);
      const priceDKK = (Number(r.price || 0) || 0) * rate;
      if (r.season_id === k1) { const t = out[k1]!; t.qty += Number(r.qty||0); t.price += priceDKK; }
      if (r.season_id === k2) { const t = out[k2]!; t.qty += Number(r.qty||0); t.price += priceDKK; }
    }
    return out;
  });

  const { data: tops } = useSWR(s1 && s2 ? ['home:tops', s1, s2] : null, async () => {
    const { data, error } = await supabase
      .from('sales_stats')
      .select('salesperson_name, salesperson_id, qty, price, season_id, account_no')
      .in('season_id', [s1, s2]);
    if (error) throw new Error(error.message);
    const map = new Map<string, PersonRow>();
    const seenAccountsBySp = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const key = r.salesperson_name || '—';
      const row = map.get(key) || { salesperson: key, qty: 0, price: 0, customersLeft: 0 };
      row.qty += Number(r.qty || 0);
      row.price += Number(r.price || 0);
      // customers left: count unique accounts (placeholder: treated as total; subtract visited if you have that flag)
      const s = seenAccountsBySp.get(key) || new Set<string>();
      if (r.account_no) s.add(r.account_no);
      seenAccountsBySp.set(key, s);
      row.customersLeft = s.size; // adjust when we have visited/null flags joined here
      map.set(key, row);
    }
    return Array.from(map.values()).sort((a,b)=> b.price - a.price).slice(0, 20);
  });

  const { data: recent } = useSWR('home:runs', async () => {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, status, created_at, started_at, finished_at, error')
      .eq('type', 'scrape_statistics')
      .order('created_at', { ascending: false })
      .limit(5);
    return jobs ?? [];
  }, { refreshInterval: 10000 });

  const s1Tot: SeasonTotals = s1 && totals ? (totals[s1] ?? { qty: 0, price: 0 }) : { qty: 0, price: 0 };
  const s2Tot: SeasonTotals = s2 && totals ? (totals[s2] ?? { qty: 0, price: 0 }) : { qty: 0, price: 0 };
  const diff = { qty: (s1Tot.qty - s2Tot.qty), price: (s1Tot.price - s2Tot.price) };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="rounded-md border bg-white p-3">
          <div className="text-xs text-gray-500">{seasonLabel(s1) || 'Season 1'} total</div>
          <div className="mt-1 text-lg font-semibold">Qty: {s1Tot.qty.toLocaleString()}</div>
          <div className="text-lg font-semibold">Price: {Math.round(s1Tot.price).toLocaleString()} DKK</div>
        </div>
        <div className="rounded-md border bg-white p-3">
          <div className="text-xs text-gray-500">{seasonLabel(s2) || 'Season 2'} total</div>
          <div className="mt-1 text-lg font-semibold">Qty: {s2Tot.qty.toLocaleString()}</div>
          <div className="text-lg font-semibold">Price: {Math.round(s2Tot.price).toLocaleString()} DKK</div>
        </div>
        <div className="rounded-md border bg-white p-3">
          <div className="text-xs text-gray-500">Difference</div>
          <div className={"mt-1 text-lg font-semibold " + (diff.qty>=0?'text-green-700':'text-red-700')}>Qty: {diff.qty.toLocaleString()}</div>
          <div className={"text-lg font-semibold " + (diff.price>=0?'text-green-700':'text-red-700')}>Price: {Math.round(diff.price).toLocaleString()} DKK</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div className="rounded-md border bg-white">
          <div className="p-2 text-xs font-medium">Topsellers</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-1 border-b">Salesperson</th>
                  <th className="text-right p-1 border-b">Qty</th>
                  <th className="text-right p-1 border-b">Price</th>
                  <th className="text-right p-1 border-b">Customers Left</th>
                </tr>
              </thead>
              <tbody>
                {(tops ?? []).map((r: PersonRow) => (
                  <tr key={r.salesperson}>
                    <td className="p-1 border-b">{r.salesperson}</td>
                    <td className="p-1 border-b text-right">{r.qty.toLocaleString()}</td>
                    <td className="p-1 border-b text-right">{r.price.toLocaleString()} DKK</td>
                    <td className="p-1 border-b text-right">{r.customersLeft.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-md border bg-white">
          <div className="p-2 text-xs font-medium">Recent runs</div>
          <div className="divide-y text-xs">
            {(recent ?? []).map((j: any) => (
              <div key={j.id} className="flex items-start justify-between p-2">
                <Link className="underline" href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link>
                <div className="text-gray-600">{j.status}</div>
                <div className="text-gray-500">{formatRelativeDateTime(new Date(j.started_at ?? j.created_at))}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

