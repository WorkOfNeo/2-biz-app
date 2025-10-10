'use client';
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, EyeOff, Trash2, Ban } from 'lucide-react';
import { ProgressBar } from '../../../components/ProgressBar';

export default function StatisticsGeneralPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const { data: salespersons } = useSWR('salespersons-all', async () => {
    const { data, error } = await supabase
      .from('salespersons')
      .select('id, name, currency, sort_index')
      .order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; currency?: string | null; sort_index?: number | null }[];
  });
  // Currency rates (from Misc settings) – 1 unit equals how many DKK
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const [activePerson, setActivePerson] = useState<string>('');
  const [showSave, setShowSave] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatePct, setUpdatePct] = useState(0);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const spNameById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; name: string }[]).map(s => [s.id, s.name])), [salespersons]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; currency?: string | null }[]).map(s => [s.id, s.currency ?? 'DKK'])), [salespersons]);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
  }, [saved?.id]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

  // Read salesperson from URL hash on load; default to first salesperson
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const m = hash.match(/(^#|&)sp=([^&]+)/);
    if (m && m[2]) {
      try {
        const decoded = decodeURIComponent(m[2]);
        const exists = (salespersons ?? []).some(sp => sp.name === decoded);
        if (exists) setActivePerson(decoded);
        console.log('[stats] read salesperson from hash', decoded);
      } catch {}
    }
    if ((!m || !m[2]) && (salespersons ?? []).length > 0 && !activePerson) {
      const first = ((salespersons ?? [])[0] as any)?.name as string | undefined;
      if (first) {
        setActivePerson(first);
        console.log('[stats] default salesperson', first);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salespersons?.length]);
  // Update hash when selecting a salesperson
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activePerson) {
      const url = new URL(window.location.href);
      url.hash = `sp=${encodeURIComponent(activePerson)}`;
      window.history.replaceState(null, '', url.toString());
      console.log('[stats] set salesperson hash', activePerson);
    } else {
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState(null, '', url.toString());
      console.log('[stats] cleared salesperson hash');
    }
  }, [activePerson]);

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  async function handleUpdateStatistic() {
    if (!s1) return alert('Select Season 1 to update');
    try {
      setUpdating(true);
      setUpdatePct(5);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const orch = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');
      setUpdatePct(15);
      const body = { type: 'scrape_statistics', payload: { toggles: { deep: true }, requestedBy: session.user.email, seasonId: s1 } };
      const res = await fetch(`/api/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setLastJobId(json.jobId);
      setUpdatePct(35);
      // Poll logs to reflect steps
      const start = Date.now();
      const stepMap: Record<string, number> = {
        'STEP:begin_deep': 35,
        'STEP:topseller_ready': 50,
        'STEP:salespersons_total': 60,
        'STEP:salesperson_start': 65,
        'STEP:salesperson_done': 85,
        'STEP:complete': 100
      };
      const timer = setInterval(async () => {
        try {
          const { data: logs } = await supabase
            .from('job_logs')
            .select('msg, ts')
            .eq('job_id', json.jobId)
            .order('ts', { ascending: false })
            .limit(50);
          for (const l of (logs ?? [])) {
            const msg = (l as any).msg as string;
            if (stepMap[msg] !== undefined) {
              setUpdatePct((prev) => {
                const nextVal = stepMap[msg] ?? prev;
                return Math.max(prev, nextVal);
              });
              if (msg === 'STEP:complete') {
                clearInterval(timer);
                setTimeout(() => setUpdating(false), 750);
              }
              break;
            }
          }
          // Safety cap
          if (Date.now() - start > 5 * 60 * 1000) {
            clearInterval(timer);
            setUpdating(false);
          }
        } catch {}
      }, 1500);
    } catch (e: any) {
      alert(e?.message || 'Failed to enqueue');
      setUpdating(false);
    }
  }

  function calculateDevelopment(s1Qty: number, s2Qty: number) {
    const diff = s1Qty - s2Qty;
    const percentage = s2Qty === 0 ? 0 : (diff / s2Qty) * 100;
    return { diff, percentage: Number.isFinite(percentage) ? percentage : 0 };
  }

  // Resolve selected salesperson id (optional filter)
  const selectedSalespersonId = activePerson
    ? (salespersons ?? []).find((sp) => sp.name === activePerson)?.id ?? null
    : null;

  type RowOut = {
    account_no: string;
    customer: string;
    city: string;
    s1Qty: number;
    s1Price: number;
    s2Qty: number;
    s2Price: number;
    salespersonId: string | null;
    salespersonName: string;
  };

  const { data: rows } = useSWR(
    s1 && s2 ? ['general-stats', s1, s2, selectedSalespersonId ?? 'all'] : null,
    async () => {
      // Fetch both seasons at once and aggregate client-side by account_no
      const query = supabase
        .from('sales_stats')
        .select('account_no, customer_name, city, qty, price, season_id, salesperson_id')
        .in('season_id', [s1, s2]);
      if (selectedSalespersonId) {
        query.eq('salesperson_id', selectedSalespersonId);
      }
      const { data, error } = await query.limit(100000);
      if (error) throw new Error(error.message);
      console.log('[stats] fetched raw rows', (data ?? []).length);

      const map = new Map<string, RowOut>();
      for (const r of (data ?? []) as any[]) {
        const key: string = r.account_no ?? `${r.customer_name ?? ''}:${r.city ?? ''}`;
        const item = map.get(key) ?? {
          account_no: r.account_no ?? key,
          customer: r.customer_name ?? '-',
          city: r.city ?? '-',
          s1Qty: 0,
          s1Price: 0,
          s2Qty: 0,
          s2Price: 0,
          salespersonId: r.salesperson_id ?? null,
          salespersonName: spNameById[r.salesperson_id as string] ?? (r.salesperson_id ? 'Unknown' : '—')
        };
        const qty = Number(r.qty ?? 0) || 0;
        const price = Number(r.price ?? 0) || 0;
        if (r.season_id === s1) {
          item.s1Qty += qty;
          item.s1Price += price;
        } else if (r.season_id === s2) {
          item.s2Qty += qty;
          item.s2Price += price;
        }
        map.set(key, item);
      }
      const out = Array.from(map.values()).sort((a, b) => a.customer.localeCompare(b.customer));
      console.log('[stats] aggregated rows', out.length, 'sample', out[0]);
      return out;
    },
    { refreshInterval: 20000 }
  );

  // Seasonal overrides (null/hidden) stored in app_settings per season
  const overridesKey = s1 ? `season_overrides:${s1}` : null;
  const { data: overrides, mutate: mutateOverrides } = useSWR(overridesKey, async () => {
    if (!overridesKey) return { id: null, value: { nulled: [], hidden: [] as string[] } };
    const { data, error } = await supabase.from('app_settings').select('id, value').eq('key', overridesKey).maybeSingle();
    if (error) throw new Error(error.message);
    const val = (data?.value as any) || {};
    return { id: data?.id ?? null, value: { nulled: Array.isArray(val.nulled) ? val.nulled : [], hidden: Array.isArray(val.hidden) ? val.hidden : [] } } as { id: string | null, value: { nulled: string[]; hidden: string[] } };
  }, { refreshInterval: 0 });
  useEffect(() => {
    if (overridesKey) console.log('[stats] overrides', overridesKey, overrides);
  }, [overridesKey, overrides?.id, overrides?.value]);

  const { data: closedCustomers } = useSWR('customers-closed', async () => {
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

  async function saveOverrides(next: { nulled: string[]; hidden: string[] }) {
    if (!overridesKey) return;
    console.log('[stats] saveOverrides', overridesKey, next);
    if (overrides?.id) {
      const { error } = await supabase.from('app_settings').update({ value: next }).eq('id', overrides.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('app_settings').insert({ key: overridesKey, value: next });
      if (error) throw new Error(error.message);
    }
    await mutateOverrides();
  }

  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }
  function isNulled(account: string): boolean {
    return Boolean(overrides?.value.nulled.includes(account)) || Boolean(closedCustomers?.setNulled.has(account)) || Boolean(closedCustomers?.setClosed.has(account));
  }

  async function toggleHide(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const hidden = new Set(overrides?.value.hidden ?? []);
    if (hidden.has(account)) hidden.delete(account); else hidden.add(account);
    console.log('[stats] toggleHide', account, '->', Array.from(hidden));
    await saveOverrides({ nulled: overrides?.value.nulled ?? [], hidden: Array.from(hidden) });
  }
  async function toggleNull(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const nulled = new Set(overrides?.value.nulled ?? []);
    if (nulled.has(account)) nulled.delete(account); else nulled.add(account);
    console.log('[stats] toggleNull', account, '->', Array.from(nulled));
    await saveOverrides({ nulled: Array.from(nulled), hidden: overrides?.value.hidden ?? [] });
  }
  async function permanentClose(account: string) {
    // Mark customer globally; also add seasonal null
    const { error } = await supabase.from('customers').update({ permanently_closed: true, nulled: true }).eq('customer_id', account);
    if (error) return alert(error.message);
    console.log('[stats] permanentClose', account);
    await toggleNull(account);
  }

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-balance text-slate-700">General statistics</h1>
          <div className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
        </div>
        <div className="relative">
          <details>
            <summary className="list-none inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-slate-50"><Menu className="h-4 w-4" /></summary>
            <div className="absolute right-0 z-10 mt-2 w-56 rounded-md border bg-white shadow">
              <div className="py-1 text-sm">
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Export Data</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Print Report</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Download PDF</button>
                <Link className="block px-3 py-2 hover:bg-gray-50" href="/statistics/general/import">Import Statistic</Link>
                <Link className="block px-3 py-2 hover:bg-gray-50" href={'/statistics/general/last-runs' as any}>Last Runs</Link>
                <Link className="block px-3 py-2 hover:bg-gray-50" href="/settings/seasons">Season Settings</Link>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={handleUpdateStatistic}>Update Statistic</button>
              </div>
            </div>
          </details>
        </div>
      </div>


      <div className="space-y-4">
        {updating && (
          <div className="rounded-md border p-3">
            <div className="mb-2 text-sm text-gray-600">Updating statistics…</div>
            <ProgressBar value={updatePct} />
            {lastJobId && <div className="mt-1 text-[11px] text-gray-500">Job: {lastJobId}</div>}
          </div>
        )}
        <div className="flex flex-wrap w-full gap-2">
          {(((salespersons ?? []).map((sp) => sp.name)) as string[]).map((person) => {
            const active = person === activePerson;
            return (
              <button
                key={person}
                onClick={() => setActivePerson(person)}
                className={
                  'whitespace-nowrap rounded-md border px-3 py-1.5 text-sm ' +
                  (active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50')
                }
              >
                {person}
              </button>
            );
          })}
        </div>

        {/* Single section for selected salesperson */}
        {(() => {
          const visibleRows = (rows ?? []).filter(r => !isHidden(r.account_no));
          const items = activePerson ? visibleRows.filter(r => r.salespersonName === activePerson) : visibleRows;
          console.log('[stats] table items', items.length);
          return (
            <div className="rounded-lg border bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b-2">
                      <th className="p-2 text-left font-semibold">Customer</th>
                      <th className="p-2 text-left font-semibold">City</th>
                      <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s1) || 'Season 1'}</th>
                      <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s2) || 'Season 2'}</th>
                      <th className="p-2 text-center font-semibold" colSpan={2}>Development</th>
                      <th className="p-2 text-left font-semibold">Actions</th>
                    </tr>
                    <tr className="bg-gray-50">
                      <th className="p-2 text-left"></th>
                      <th className="p-2 text-left"></th>
                      <th className="p-2 text-center">Qty</th>
                      <th className="p-2 text-center">Price</th>
                      <th className="p-2 text-center">Qty</th>
                      <th className="p-2 text-center">Price</th>
                      <th className="p-2 text-center">Qty</th>
                      <th className="p-2 text-center">Price</th>
                      <th className="p-2 text-center"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => {
                      const devQty = row.s1Qty - row.s2Qty;
                      const devPrice = row.s1Price - row.s2Price;
                      const nulled = isNulled(row.account_no);
                      const currency = row.salespersonId ? (spCurrencyById[row.salespersonId] ?? 'DKK') : 'DKK';
                      return (
                        <tr key={row.account_no} className={"border-t " + (nulled ? 'opacity-80' : '')}>
                          <td className={"relative p-2 font-medium " + (nulled ? '' : '')}>
                            {row.customer}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 " + (nulled ? '' : '')}>
                            {row.city}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s1Qty}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s1Price.toLocaleString()} {currency}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s2Qty}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s2Price.toLocaleString()} {currency}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="p-2 text-center">
                            <span className={devQty > 0 ? 'text-green-600' : devQty < 0 ? 'text-red-600' : ''}>
                              {devQty > 0 ? '+' : ''}{devQty}
                            </span>
                          </td>
                          <td className="p-2 text-center">
                            <span className={devPrice > 0 ? 'text-green-600' : devPrice < 0 ? 'text-red-600' : ''}>
                              {devPrice > 0 ? '+' : ''}{devPrice.toLocaleString()} {currency}
                            </span>
                          </td>
                          <td className="p-2">
                            <div className="relative flex items-center justify-center gap-1.5">
                              <ActionBtn label="Hide" onClick={() => toggleHide(row.account_no)}>
                                <Ban className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Null (season)" onClick={() => toggleNull(row.account_no)}>
                                <EyeOff className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Close (perm)" onClick={() => permanentClose(row.account_no)}>
                                <Trash2 className="h-4 w-4" />
                              </ActionBtn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {(() => {
                      const sum = items.reduce((acc, r) => {
                        acc.s1Qty += r.s1Qty; acc.s1Price += r.s1Price; acc.s2Qty += r.s2Qty; acc.s2Price += r.s2Price; return acc;
                      }, { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 });
                      return (
                        <tr className="border-t bg-gray-50 font-semibold">
                          <td className="p-2">TOTAL</td>
                          <td className="p-2"></td>
                          <td className="p-2 text-center">{sum.s1Qty}</td>
                          <td className="p-2 text-center">{sum.s1Price.toLocaleString()} DKK</td>
                          <td className="p-2 text-center">{sum.s2Qty}</td>
                          <td className="p-2 text-center">{sum.s2Price.toLocaleString()} DKK</td>
                          <td className="p-2 text-center">{(sum.s1Qty - sum.s2Qty) >= 0 ? `+${sum.s1Qty - sum.s2Qty}` : (sum.s1Qty - sum.s2Qty)}</td>
                          <td className="p-2 text-center">{(sum.s1Price - sum.s2Price).toLocaleString()} DKK</td>
                          <td className="p-2"></td>
                        </tr>
                      );
                    })()}
                    {(() => {
                      const rates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
                      const sumDkk = items.reduce((acc, r) => {
                        const currency = r.salespersonId ? (spCurrencyById[r.salespersonId] ?? 'DKK') : 'DKK';
                        const rate = rates[currency] ?? 1;
                        acc.s1Price += r.s1Price * rate;
                        acc.s2Price += r.s2Price * rate;
                        return acc;
                      }, { s1Price: 0, s2Price: 0 });
                      return (
                        <tr className="bg-gray-100">
                          <td className="p-2">TOTAL (DKK)</td>
                          <td className="p-2"></td>
                          <td className="p-2 text-center">—</td>
                          <td className="p-2 text-center">{Math.round(sumDkk.s1Price).toLocaleString()} DKK</td>
                          <td className="p-2 text-center">—</td>
                          <td className="p-2 text-center">{Math.round(sumDkk.s2Price).toLocaleString()} DKK</td>
                          <td className="p-2 text-center">—</td>
                          <td className="p-2 text-center">{Math.round(sumDkk.s1Price - sumDkk.s2Price).toLocaleString()} DKK</td>
                          <td className="p-2"></td>
                        </tr>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
              {/* KPI cards when a salesperson is selected */}
              {activePerson && (
                <div className="border-t p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-gray-500">Total customers</div>
                    <div className="text-xl font-semibold">{items.length}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-gray-500">Season 1 total</div>
                    <div className="text-xl font-semibold">{items.reduce((a,b)=>a+b.s1Price,0).toLocaleString()} DKK</div>
                    <div className="text-[11px] text-gray-400">local: varies per salesperson</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-gray-500">Season 2 total</div>
                    <div className="text-xl font-semibold">{items.reduce((a,b)=>a+b.s2Price,0).toLocaleString()} DKK</div>
                    <div className="text-[11px] text-gray-400">local: varies per salesperson</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-gray-500">Growth</div>
                    <div className={"text-xl font-semibold " + ((items.reduce((a,b)=>a+b.s1Price,0) - items.reduce((a,b)=>a+b.s2Price,0))>=0? 'text-green-700':'text-red-700')}>
                      {(items.reduce((a,b)=>a+b.s1Price,0) - items.reduce((a,b)=>a+b.s2Price,0)).toLocaleString()} DKK
                    </div>
                    <div className="text-[11px] text-gray-400">based on visible customers</div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}


