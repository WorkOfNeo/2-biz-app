'use client';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, Eye, EyeOff, Trash2 } from 'lucide-react';
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
      .select('id, name')
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string }[];
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const [activePerson, setActivePerson] = useState<string>('All');
  const [showSave, setShowSave] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatePct, setUpdatePct] = useState(0);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
  }, [saved?.id]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

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
      const res = await fetch(`${orch}/enqueue`, {
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
              setUpdatePct((prev) => Math.max(prev, stepMap[msg]));
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
  const selectedSalespersonId = activePerson === 'All'
    ? null
    : (salespersons ?? []).find((sp) => sp.name === activePerson)?.id ?? null;

  type RowOut = {
    account_no: string;
    customer: string;
    city: string;
    s1Qty: number;
    s1Price: number;
    s2Qty: number;
    s2Price: number;
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
      return Array.from(map.values()).sort((a, b) => a.customer.localeCompare(b.customer));
    },
    { refreshInterval: 20000 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-balance">General Statistics</h1>
          <p className="mt-2 text-gray-500">Compare seasonal performance across salespersons</p>
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
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={handleUpdateStatistic}>Update Statistic</button>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div className="rounded-lg border bg-white">
        <div className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 min-w-[220px]">
              <label className="text-sm font-medium text-gray-600">Season 1</label>
              <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
                <option value="">—</option>
                {(seasons ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
                ))}
              </select>
            </div>
            <div className="hidden text-gray-500 sm:block">vs</div>
            <div className="flex-1 min-w-[220px]">
              <label className="text-sm font-medium text-gray-600">Season 2</label>
              <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
                <option value="">—</option>
                {(seasons ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
                ))}
              </select>
            </div>
            {showSave && (
              <button
                className="ml-auto text-sm underline"
                onClick={async () => {
                  const value = { s1, s2 };
                  if (saved) {
                    await supabase.from('app_settings').update({ value }).eq('id', saved.id);
                  } else {
                    await supabase.from('app_settings').insert({ key: 'season_compare', value });
                  }
                  setShowSave(false);
                }}
              >Save to settings?</button>
            )}
          </div>
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
        <div className="flex w-full gap-2 overflow-x-auto">
          {(['All', ...((salespersons ?? []).map((sp) => sp.name))] as string[]).map((person) => {
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
                  <th className="p-2 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">Null</button>
                      <button className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">Hide</button>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => {
                  const devQty = row.s1Qty - row.s2Qty;
                  const devPrice = row.s1Price - row.s2Price;
                  return (
                    <tr key={row.account_no} className="border-t">
                      <td className="p-2 font-medium">{row.customer}</td>
                      <td className="p-2">{row.city}</td>
                      <td className="p-2 text-center">{row.s1Qty}</td>
                      <td className="p-2 text-center">{row.s1Price.toLocaleString()} DKK</td>
                      <td className="p-2 text-center">{row.s2Qty}</td>
                      <td className="p-2 text-center">{row.s2Price.toLocaleString()} DKK</td>
                      <td className="p-2 text-center">
                        <span className={devQty > 0 ? 'text-green-600' : devQty < 0 ? 'text-red-600' : ''}>
                          {devQty > 0 ? '+' : ''}{devQty}
                        </span>
                      </td>
                      <td className="p-2 text-center">
                        <span className={devPrice > 0 ? 'text-green-600' : devPrice < 0 ? 'text-red-600' : ''}>
                          {devPrice > 0 ? '+' : ''}{devPrice.toLocaleString()} DKK
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1.5">
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Show"><Eye className="h-4 w-4" /></button>
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Hide"><EyeOff className="h-4 w-4" /></button>
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}


